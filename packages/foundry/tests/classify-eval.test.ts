// The eval runs classify configurations through the live call path: the three-way experiment's arms
// (2026-10-18-three-way: stage 1 binary or ternary on knowledge.md, then a Sonnet pick on what it
// escalates), and a grouped recogniser fanning out to its members. Stub providers only: no model calls.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage, LLMProvider, WardenProbe } from '@inixiative/foundry-core';
import {
  ADVICE_RESPONSE_PROTOCOL,
  NO_COMMENT,
  PROMPT_SECTIONS,
  validateStages,
} from '../src/classify';
import { type EvalWarden, runCharterEval } from '../src/feedback/charter-eval';
import { readClassifyRun } from '../src/feedback/classify-run';

/** A whole candidate charter as sections: its text in the opening's place, every other section off. */
const whole = (prompt: 'point' | 'recognise', text: string) => ({
  sections: Object.fromEntries(
    PROMPT_SECTIONS[prompt]
      .map(([name]) => name as string)
      .filter((name) => name !== 'choose-one')
      .map((name) => [name, name === 'opening' ? { text } : false]),
  ),
});
/** A run config written to a fresh folder and read as `warden-charter.ts --classify` reads it. */
const runOf = (config: object) => {
  const dir = mkdtempSync(join(tmpdir(), 'classify-run-'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify(config));
  return readClassifyRun(join(dir, 'run.json'));
};

const RECOGNISE_2WAY = 'CANDIDATE RECOGNISE 2WAY';
const RECOGNISE_3WAY = 'CANDIDATE RECOGNISE 3WAY';
const PICK = 'CANDIDATE PICK';
/** The three-way design's two arms, as run configs (`warden-charter.ts --classify`). */
const ARMS = {
  A: [
    {
      task: 'recognise',
      outcomes: 'binary',
      escalate: ['yes'],
      ...whole('recognise', RECOGNISE_2WAY),
    },
    { model: 'claude-sonnet-5-5', effort: 'low', pointer: { any: false }, ...whole('point', PICK) },
  ],
  B: [
    {
      task: 'recognise',
      outcomes: 'ternary',
      escalate: ['yes', 'unsure'],
      ...whole('recognise', RECOGNISE_3WAY),
    },
    { model: 'claude-sonnet-5-5', effort: 'low', pointer: { any: false }, ...whole('point', PICK) },
  ],
} as const;

const PROBES: WardenProbe[] = [
  { id: 'lock', kind: 'positive', ctx: 'x', moment: '', ask: 'Add a job that never overlaps.' },
  { id: 'vague', kind: 'positive', ctx: 'x', moment: '', ask: 'Make the nightly thing safer.' },
  { id: 'none', kind: 'negative', ctx: 'x', moment: '', ask: 'Fix a typo in the README.' },
];
const LOCKS: EvalWarden = {
  domain: 'locks',
  instructions: 'Locks Warden',
  domainKnowledge: '# Locks\n- createLock (CONCURRENCY.md)',
  session: 'run:locks',
};
const POINTER = 'Look over here: createLock (CONCURRENCY.md) — exclusion across instances.';
const text = (messages: readonly LLMMessage[]) => messages.map((m) => m.content).join('\n');

function hosts() {
  const calls: Array<{ host: string; messages: LLMMessage[]; threadId?: string }> = [];
  const host = (id: string, answer: (body: string, system: string) => string): LLMProvider => ({
    id,
    async complete(messages, opts) {
      calls.push({ host: id, messages, ...(opts?.threadId ? { threadId: opts.threadId } : {}) });
      return {
        model: id,
        content: answer(text(messages.slice(1)), messages[0]!.content),
        tokens: { input: 100, output: 10 },
      };
    },
  });
  const haiku = host('claude-haiku-5-5', (body, system) => {
    const ternary = system.startsWith(RECOGNISE_3WAY);
    if (body.includes('never overlaps'))
      return JSON.stringify({
        snippets: ['locks: YES — a job that must not run twice'],
        layers: [],
        confidence: 0.9,
      });
    if (body.includes('nightly thing') && ternary)
      return JSON.stringify({
        snippets: ['locks: UNSURE — "safer" may mean no overlap'],
        layers: [],
        confidence: 0.4,
      });
    return NO_COMMENT;
  });
  const sonnet = host('claude-sonnet-5-5', () =>
    JSON.stringify({ snippets: [POINTER], layers: [], confidence: 0.8 }),
  );
  return { haiku, sonnet, calls };
}

async function arm(stagesConfig: readonly Record<string, unknown>[]) {
  const config = runOf({ stages: stagesConfig });
  const { haiku, sonnet, calls } = hosts();
  const run = await runCharterEval({
    probes: PROBES,
    wardensFor: () => [LOCKS],
    warden: haiku,
    stages: config.stages,
    stageProviders: [haiku, sonnet],
    charters: config.charters,
    triggers: ['user-message'],
  });
  return { ...run, calls };
}

describe('the three-way arms, on stub providers', () => {
  test('arm B: an UNSURE reaches stage 2 with its tag; every answer carries its stage trace', async () => {
    const { answers, calls } = await arm(ARMS.B);
    const stage2 = calls.filter((c) => c.host === 'claude-sonnet-5-5');
    expect(stage2).toHaveLength(2);
    expect(stage2.every((c) => c.messages[0]!.content.startsWith(PICK))).toBe(true);
    expect(stage2.every((c) => c.threadId === 'run:locks:stage:1')).toBe(true);
    const vague = stage2.find((c) => text(c.messages).includes('nightly thing'))!;
    expect(text(vague.messages)).toContain(
      'Stage 1 (claude-haiku-5-5) was unsure this moment is in your region: "safer" may mean no overlap\nTreat that as no until your own knowledge shows otherwise.',
    );
    expect(text(vague.messages)).toEndWith(ADVICE_RESPONSE_PROTOCOL);
    // Stage 1 answers under the ternary recogniser protocol it was given.
    const first = calls.find((c) => c.host === 'claude-haiku-5-5')!;
    expect(first.messages[0]!.content.startsWith(RECOGNISE_3WAY)).toBe(true);
    expect(text(first.messages)).toContain('`<region id>: UNSURE — ');
    expect(answers.map((a) => [a.probeId, a.noComment, a.outcome])).toEqual([
      ['lock', false, 'yes'],
      ['vague', false, 'yes'],
      ['none', true, 'no'],
    ]);
    expect(answers[1]).toMatchObject({
      text: POINTER,
      stages: [
        {
          stage: 0,
          task: 'recognise',
          outcome: 'unsure',
          model: 'claude-haiku-5-5',
          tokens: { input: 100, output: 10 },
          regions: [{ regionId: 'locks', outcome: 'unsure' }],
        },
        { stage: 1, task: 'point', outcome: 'yes', model: 'claude-sonnet-5-5' },
      ],
    });
    // A staged row carries per-stage tokens, never a merged total.
    expect(answers[1]!.tokens).toBeUndefined();
  });

  test('arm A: a binary recogniser has no unsure, so only its yes reaches stage 2', async () => {
    const { answers, calls } = await arm(ARMS.A);
    expect(calls.filter((c) => c.host === 'claude-sonnet-5-5')).toHaveLength(1);
    const first = calls.find((c) => c.host === 'claude-haiku-5-5')!;
    expect(first.messages[0]!.content.startsWith(RECOGNISE_2WAY)).toBe(true);
    expect(text(first.messages)).not.toContain('UNSURE');
    expect(answers.map((a) => [a.probeId, a.outcome])).toEqual([
      ['lock', 'yes'],
      ['vague', 'no'],
      ['none', 'no'],
    ]);
  });
});

describe('a grouped recogniser', () => {
  const GROUP: EvalWarden = {
    domain: 'g01-locks',
    instructions: 'Group of 2',
    domainKnowledge: '# Region locks\n...\n# Region queues\n...',
    members: ['locks', 'queues'],
  };
  const member = (id: string): EvalWarden => ({
    domain: id,
    instructions: `${id} Warden`,
    domainKnowledge: `# ${id}`,
    docs: { 'knowledge.md': `# ${id} catalogue` },
  });

  test('asks the group once and fans each named member out to its own later stages; others are silent', async () => {
    const config = runOf({ stages: ARMS.B }).stages;
    const seen: string[] = [];
    const provider: LLMProvider = {
      id: 'stub',
      async complete(messages) {
        const body = text(messages.slice(1));
        seen.push(body.slice(0, 40));
        if (body.includes('## Domain cache (g01-locks)'))
          return {
            model: 'haiku',
            content: JSON.stringify({
              snippets: ['locks: YES — overlap', 'inquiries: YES — not in this group'],
              layers: [],
              confidence: 0.9,
            }),
            tokens: { input: 200, output: 20 },
          };
        expect(body).toContain('# locks catalogue');
        expect(body).toContain('read this moment as in your region: overlap');
        return {
          model: 'sonnet',
          content: JSON.stringify({ snippets: [POINTER], layers: [], confidence: 0.8 }),
        };
      },
    };
    const { answers, turns } = await runCharterEval({
      probes: [PROBES[0]!],
      wardensFor: () => [GROUP],
      memberWarden: (_p, id) => (id === 'locks' || id === 'queues' ? member(id) : undefined),
      warden: provider,
      stages: config,
      triggers: ['user-message'],
    });
    expect(seen).toHaveLength(2);
    expect(turns[0]).toMatchObject({ calls: 2 });
    expect(answers.map((a) => [a.domain, a.noComment, a.outcome])).toEqual([
      ['locks', false, 'yes'],
      ['queues', true, 'no'],
    ]);
    // The group's call is shared: its tokens split over the members, its stray id counted.
    expect(answers[0]!.stages![0]).toMatchObject({
      stage: 0,
      outcome: 'yes',
      why: 'overlap',
      tokens: { input: 100, output: 10 },
      unknownRegions: ['inquiries'],
    });
    expect(answers[0]!.stages![1]).toMatchObject({ stage: 1, outcome: 'yes' });
    expect(answers[0]!.text).toBe(POINTER);
    expect(answers[1]!.stages).toEqual([expect.objectContaining({ stage: 0, outcome: 'no' })]);
  });

  test('a one-stage grouped run writes each named member’s line as its own yes, and a group failure is every member’s', async () => {
    const one = validateStages('run', [{ task: 'recognise' }]);
    const answer = (content: string): LLMProvider => ({
      id: 'stub',
      complete: async () => ({ model: 'haiku', content }),
    });
    const named = await runCharterEval({
      probes: [PROBES[0]!],
      wardensFor: () => [GROUP],
      warden: answer(
        JSON.stringify({ snippets: ['queues: ordering'], layers: [], confidence: 0.6 }),
      ),
      stages: one,
      triggers: ['user-message'],
    });
    expect(named.answers.map((a) => [a.domain, a.noComment, a.text])).toEqual([
      ['locks', true, undefined],
      ['queues', false, 'queues: ordering'],
    ]);
    const broken = await runCharterEval({
      probes: [PROBES[0]!],
      wardensFor: () => [GROUP],
      warden: answer('Yes, both of them.'),
      stages: one,
      triggers: ['user-message'],
      retries: 0,
    });
    expect(broken.answers.map((a) => [a.domain, a.noComment, !!a.error])).toEqual([
      ['locks', false, true],
      ['queues', false, true],
    ]);
  });
});

test('reason inline and followup, through the eval: the why lands on the stage trace', async () => {
  const replies = [
    JSON.stringify({
      outcome: 'no',
      why: 'a README typo',
      snippets: [],
      layers: [],
      confidence: 0,
    }),
    NO_COMMENT,
    'It asks for a typo fix.\nNothing in locks.\nREVISED: KEEP',
  ];
  const provider: LLMProvider = {
    id: 'stub',
    complete: async () => ({ model: 'haiku', content: replies.shift()! }),
  };
  const ask = (reason: string) =>
    runCharterEval({
      probes: [PROBES[2]!],
      wardensFor: () => [LOCKS],
      warden: provider,
      stages: validateStages('run', [{ reason }]),
      triggers: ['user-message'],
    });
  const inline = await ask('inline');
  expect(inline.answers[0]).toMatchObject({
    noComment: true,
    outcome: 'no',
    stages: [{ outcome: 'no', why: 'a README typo' }],
  });
  const followup = await ask('followup');
  expect(followup.answers[0]).toMatchObject({
    noComment: true,
    stages: [{ outcome: 'no', why: 'It asks for a typo fix. Nothing in locks.', revised: 'keep' }],
  });
});
