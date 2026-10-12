import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchiveSnapshot } from '@inixiative/archive';
import type { CompletionResult, LLMMessage, LLMProvider } from '@inixiative/foundry-core';
import {
  renderReport,
  renderShareMarkdown,
  renderShareText,
  repeatReport,
  reportItems,
} from '../src/feedback/repeats';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const at = (day: number, minute = 0) =>
  new Date(
    Date.parse(`2026-10-${String(day).padStart(2, '0')}T10:00:00Z`) + minute * 60_000,
  ).toISOString();
let root: string;

const claudeRow = (
  sessionId: string,
  uuid: string,
  type: string,
  text: string,
  time: string,
  extra = {},
) =>
  JSON.stringify({
    sessionId,
    uuid,
    type,
    timestamp: time,
    entrypoint: 'cli',
    ...(type === 'user' ? { origin: { kind: 'human' } } : {}),
    message: { role: type, content: [{ type: 'text', text }] },
    ...extra,
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'foundry-repeats-'));
  const project = join(root, 'claude', '-Users-x-code-app');
  mkdirSync(project, { recursive: true });
  // Two sessions where the person says the same thing; one peer message that must not count.
  writeFileSync(
    join(project, 'a.jsonl'),
    [
      claudeRow('a', 'a1', 'user', 'add a date parser', at(5)),
      claudeRow('a', 'a2', 'assistant', 'I wrote a new parseDate helper.', at(5, 1)),
      claudeRow(
        'a',
        'a3',
        'user',
        'Why would you write a new helper? Use the existing one, sk-ant-abcdefghijklmnop',
        at(5, 2),
      ),
      claudeRow('a', 'a4', 'user', 'Again: never write a new helper', at(5, 3), {
        isMeta: true,
        origin: { kind: 'peer', from: 'agent' },
      }),
    ].join('\n'),
  );
  writeFileSync(
    join(project, 'b.jsonl'),
    [
      claudeRow('b', 'b1', 'assistant', 'Added utils/format.ts.', at(9)),
      claudeRow('b', 'b2', 'user', 'again, you should use the existing helper', at(9, 1)),
      claudeRow('b', 'b3', 'assistant', 'Should I merge it?', at(9, 2)),
      claudeRow('b', 'b4', 'user', 'no', at(9, 3)),
    ].join('\n'),
  );
  // An old session outside the window.
  writeFileSync(
    join(project, 'old.jsonl'),
    claudeRow('old', 'o1', 'user', 'never do X', '2026-08-01T00:00:00Z'),
  );
  utimesSync(join(project, 'old.jsonl'), new Date('2026-08-01'), new Date('2026-08-01'));
  mkdirSync(join(project, 'a', 'subagents'), { recursive: true });
  writeFileSync(
    join(project, 'a', 'subagents', 'agent-1.jsonl'),
    claudeRow('a', 's1', 'user', 'never write a new helper', at(6)),
  );
  const codex = join(root, 'codex', '2026', '10', '10');
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    join(codex, 'rollout.jsonl'),
    [
      {
        type: 'session_meta',
        payload: { id: 'c1', originator: 'Codex Desktop', source: 'vscode', cwd: '/w/app' },
      },
      {
        timestamp: at(10),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I created a second helper.' }],
        },
      },
      {
        timestamp: at(10, 1),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'stop writing helpers that already exist' }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  writeFileSync(
    join(root, 'history.jsonl'),
    [
      {
        display: 'again, you should use the existing helper',
        timestamp: Date.parse(at(9, 1)),
        project: '/w/app',
      },
      {
        display: 'from now on run the full check',
        timestamp: Date.parse(at(11)),
        project: '/w/app',
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A scan model that calls messages about helpers or checks corrections; a polish model that groups by keyword. */
function models() {
  const seen: { scan: string[]; polish: number } = { scan: [], polish: 0 };
  const result = (content: string): CompletionResult => ({
    content,
    model: 'fake',
    tokens: { input: 10, output: 5 },
  });
  const scan: LLMProvider = {
    id: 'scan',
    async complete(messages: LLMMessage[]) {
      const body = messages.at(-1)!.content;
      seen.scan.push(body);
      const results: Record<string, unknown> = {};
      for (const [, id, text] of body.matchAll(
        /## (M\d+)\n[\s\S]*?### Person's message\n([^\n]*)/g,
      )) {
        const helper = /helper/.test(text!);
        const check = /full check/.test(text!);
        results[id!] =
          helper || check
            ? {
                isCorrection: true,
                category: 'approach',
                statements: [helper ? 'Reuse the existing helper.' : 'Run the full check.'],
                sharp: true,
              }
            : { isCorrection: false };
      }
      return result(JSON.stringify({ results }));
    },
  };
  const polish: LLMProvider = {
    id: 'polish',
    async complete(messages: LLMMessage[]) {
      seen.polish++;
      const body = messages.at(-1)!.content;
      if (body.startsWith('## Rules so far')) {
        const assign: Record<string, string> = {};
        const created: Record<string, unknown> = {};
        for (const [, id, text] of body.matchAll(/^(S\d+): (.*)$/gm)) {
          const key = /helper/.test(text!) ? 'N1' : 'N2';
          const existing = /R(\d+): .*helper/.exec(body);
          assign[id!] = key === 'N1' && existing ? `R${existing[1]}` : key;
          created[key] = {
            statement:
              key === 'N1'
                ? 'When a helper exists, use it instead of writing a new one.'
                : 'Run the full check.',
            tags: key === 'N1' ? ['reuse'] : ['process'],
          };
        }
        return result(JSON.stringify({ assign, new: created }));
      }
      const ids = [...body.matchAll(/^(R\d+)/gm)].map((match) => match[1]);
      return result(
        JSON.stringify({
          rules: ids.map((id) => ({
            ids: [id],
            statement: 'Reuse the helper that already exists.',
            tags: ['reuse', 'overbuild'],
          })),
        }),
      );
    },
  };
  return { scan, polish, seen };
}

async function run(extra: Partial<Parameters<typeof repeatReport>[0]> = {}) {
  const { scan, polish, seen } = models();
  const report = await repeatReport({
    days: 30,
    now: NOW,
    claudeProjects: join(root, 'claude'),
    codexSessions: join(root, 'codex'),
    history: join(root, 'history.jsonl'),
    scan: { provider: scan, model: 'haiku', batch: 2, concurrency: 2 },
    polish: { provider: polish, model: 'opus', batch: 40 },
    ...extra,
  });
  return { report, seen };
}

describe('repeatReport', () => {
  test('counts one rule across sessions and harnesses, typed messages only', async () => {
    const { report, seen } = await run();
    expect(report.sources).toEqual({ 'claude-code': 2, codex: 1, foundry: 0, history: 1 });
    const [top] = report.rules;
    expect(top).toMatchObject({
      statement: 'Reuse the helper that already exists.',
      tags: ['reuse', 'overbuild'],
      count: 3,
      sessions: 3,
    });
    // The peer message, the subagent, the old session and the history duplicate are not counted.
    expect(seen.scan.join('\n')).not.toContain('Again: never write a new helper');
    expect(top!.evidence.map((item) => item.harness).sort()).toEqual([
      'claude-code',
      'claude-code',
      'codex',
    ]);
    // Secrets never reach a model or the report.
    expect(seen.scan.join('\n')).not.toContain('sk-ant-abc');
    expect(JSON.stringify(report)).not.toContain('sk-ant-abc');
    expect(report.usage.map((usage) => [usage.stage, usage.model])).toEqual([
      ['scan', 'haiku'],
      ['polish', 'opus'],
    ]);
    expect(report.usage[0]!.tokens.input).toBeGreaterThan(0);
  });

  test('share outputs carry rule text and counts, never what the person wrote', async () => {
    const { report } = await run();
    for (const share of [renderShareText(report), renderShareMarkdown(report)]) {
      expect(share).toContain('Reuse the helper that already exists.');
      expect(share).toContain('3');
      expect(share).not.toContain('Why would you');
      expect(share).not.toContain('/');
    }
    expect(renderReport(report)).toContain('×3');
    expect(renderReport(report, { quotes: true })).toContain('Why would you write a new helper?');
    expect(reportItems(report)[0]).toMatchObject({ count: 3, tags: ['reuse', 'overbuild'] });
  });

  test('a cached classification skips the scan model', async () => {
    const cache = new Map();
    await run({ cache });
    const { seen } = await run({ cache });
    expect(seen.scan).toEqual([]);
  });

  test('Archive is read first; a harness file only fills what it lacks or has moved past', async () => {
    const snapshot: ArchiveSnapshot = {
      schemaVersion: 1,
      sourceId: '00000000-0000-4000-8000-000000000000',
      source: 'foundry',
      sessionId: 'thread-1',
      title: 'Foundry thread',
      tags: [],
      goalIds: [],
      runIds: [],
      capturedAt: NOW,
      coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
      entries: [
        {
          id: 'f1',
          kind: 'assistant',
          text: 'Wrote another helper.',
          timestamp: Date.parse(at(8)),
          sourceRef: 'message:1',
        },
        {
          id: 'f2',
          kind: 'user',
          text: 'never write a helper that exists',
          timestamp: Date.parse(at(8, 1)),
          sourceRef: 'message:2',
        },
      ],
    };
    const archive = {
      list: async () => [
        {
          ...snapshot,
          id: 'arch-1',
          revision: 1,
          digest: 'd',
          entries: 2,
          models: [],
          suggestedTags: [],
          references: [],
        },
      ],
      read: async () => ({ id: 'arch-1', revision: 1, digest: 'd', snapshot, chunks: [] }),
    };
    const { report } = await run({ archive });
    expect(report.sources.foundry).toBe(1);
    expect(report.fromArchive).toBe(1);
    expect(report.rules[0]!.count).toBe(4);
  });
});
