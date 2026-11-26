// Dev mode (R-2026-11-25-05): with a remote Chorus, the orchestrator sends one `chorus.*` call per
// moment for every Warden it would have asked, never its local Wardens' models, and reads the answer
// back into the same plan, chime and guard report.

import { describe, expect, it } from 'bun:test';
import {
  type CompletionResult,
  ContextLayer,
  ContextStack,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import type { ChorusOperation } from '@inixiative/signet';
import { FlowOrchestrator } from '../src/agents/flow-orchestrator';
import { Librarian } from '../src/agents/librarian';
import { Warden } from '../src/agents/warden';
import {
  type ChorusCallOutcome,
  type ChorusTransport,
  createChorusRemote,
} from '../src/providers/chorus-client';

const CALL_ID = '00000000-0000-4000-8000-000000000001';

/** A local model that must never be asked: dev mode's Wardens are Chorus's. */
const untouchable: LLMProvider = {
  id: 'local',
  async complete(): Promise<CompletionResult> {
    throw Error('a local Warden was asked in dev mode');
  },
};

interface Sent {
  operation: ChorusOperation;
  projectId: string;
  input: Record<string, unknown>;
}

type Reply = (operation: ChorusOperation, input: Record<string, unknown>) => unknown;

/** Speaks for every asked domain, or answers what `reply` says. */
const speakAll: Reply = (operation, input) => {
  const domains = (input.domains as string[] | undefined) ?? [];
  if (operation === 'chorus.guard')
    return {
      ok: true,
      result: {
        rosterRevision: 'r1',
        findings: domains.map((domain) => ({
          domain,
          severity: 'advisory',
          description: `${domain} finding`,
        })),
        checkedDomains: domains,
        skippedDomains: [],
        elapsedMs: 1,
      },
    };
  return {
    ok: true,
    result: {
      rosterRevision: 'r1',
      contributions: domains.map((domain) => ({
        callId: CALL_ID,
        domain,
        outcome: 'spoke',
        snippets: [`${domain} says: see docs/${domain}.md`],
        layers: [],
        confidence: 0.9,
      })),
      elapsedMs: 1,
    },
  };
};

function setup(reply: Reply = speakAll) {
  const signals = new SignalBus();
  const stack = new ContextStack([]);
  const librarian = new Librarian({ signals, stack });
  const warden = (domain: string, guardTriggers: string[]) =>
    new Warden({
      domain,
      cache: new ContextLayer({ id: `${domain}-cache` }),
      signals,
      llm: untouchable,
      guardTriggers,
    });
  const wardens = new Map([
    ['convention', warden('convention', ['file_write'])],
    ['security', warden('security', ['file_write', 'bash'])],
  ]);
  const sent: Sent[] = [];
  const state = { reply };
  const transport: ChorusTransport = async (operation, call) => {
    const input = call.input as Record<string, unknown>;
    sent.push({ operation, projectId: call.projectId, input });
    return state.reply(operation, input) as ChorusCallOutcome<typeof operation>;
  };
  const remote = createChorusRemote({ projectId: 'proj', endpoint: 'http://chorus', transport });
  const orchestrator = new FlowOrchestrator({
    wardens,
    librarian,
    stack,
    signals,
    chorus: () => remote,
  });
  return { orchestrator, sent, state };
}

describe('dev mode: one Chorus call per moment', () => {
  it('a user message is one chorus.advise for every Warden, and each spoke chimes in', async () => {
    const { orchestrator, sent } = setup();
    const plan = await orchestrator.preMessage('add a route');
    expect(sent.map((s) => [s.operation, s.projectId])).toEqual([['chorus.advise', 'proj']]);
    expect(sent[0]!.input.domains).toEqual(['convention', 'security']);
    expect(sent[0]!.input.moment).toBe('add a route');
    const { decoration } = await orchestrator.hydrateDelta(plan);
    const chimes = decoration.blocks
      .filter((b) => b.placement === 'after-message')
      .map((b) => b.text);
    expect(chimes).toEqual([
      'The convention Warden chimed in:\n- convention says: see docs/convention.md',
      'The security Warden chimed in:\n- security says: see docs/security.md',
    ]);
  });

  it('each between-turn trigger is its own operation', async () => {
    const { orchestrator, sent } = setup();
    await orchestrator.brief({ childThreadId: 'c1', handoffId: 'h1', prompt: 'audit auth' });
    await orchestrator.consume({ itemId: 'T-1', name: 'T-1', tool: 'Read', text: 'fix login' });
    await orchestrator.milestone({
      milestoneId: 'm1',
      kind: 'publish',
      tool: 'Bash',
      detail: 'git push',
      when: 'before',
    });
    await orchestrator.handBack({ turnId: 't1', text: 'done, pushed' });
    expect(sent.map((s) => s.operation)).toEqual([
      'chorus.brief',
      'chorus.consumed',
      'chorus.milestone',
      'chorus.handBack',
    ]);
  });

  it('a warming host is not-held: nothing chimes, and the next message carries the missed one', async () => {
    const { orchestrator, sent, state } = setup(() => ({ ok: false, refusal: 'chorus_warming' }));
    const plan = await orchestrator.preMessage('first message');
    expect(plan.contributions.map((c) => c.outcome)).toEqual([
      { status: 'not-sent', cause: 'not-held' },
      { status: 'not-sent', cause: 'not-held' },
    ]);
    expect(plan.contributions.every((c) => c.catchesUp)).toBe(true);
    const { decoration } = await orchestrator.hydrateDelta(plan);
    expect(decoration.blocks.filter((b) => b.placement === 'after-message')).toEqual([]);
    state.reply = speakAll;
    await orchestrator.preMessage('second message');
    expect(sent[1]!.input.earlier).toEqual({ messages: ['first message'], dropped: 0 });
    await orchestrator.preMessage('third message');
    expect('earlier' in sent[2]!.input).toBe(false);
  });

  it('Retry sends only the chosen Wardens', async () => {
    const { orchestrator, sent } = setup();
    const report = await orchestrator.retry('milestone', 'git push', ['security']);
    expect(sent.map((s) => [s.operation, s.input.domains])).toEqual([
      ['chorus.milestone', ['security']],
    ]);
    expect(report.contributions.map((c) => c.domain)).toEqual(['security']);
  });

  it('a guard is one chorus.guard for the Wardens its triggers gate', async () => {
    const { orchestrator, sent } = setup();
    const report = await orchestrator.postAction({
      turnId: 't1',
      observations: [{ tool: 'bash', input: { command: 'ls' }, output: 'a.ts' }],
    });
    expect(sent.map((s) => [s.operation, s.input.domains])).toEqual([
      ['chorus.guard', ['security']],
    ]);
    expect(report.outcomes.map((o) => [o.domain, o.outcome])).toEqual([
      ['security', { status: 'answered', result: 'findings' }],
    ]);
  });
});
