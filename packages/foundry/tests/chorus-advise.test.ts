// chorus-advise: one message through a thread built as the daemon builds it, returning what a fresh
// live Claude Code session would receive from the chorus (Oracle's `chorus` replay arm reads it).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ContextStack,
  Executor,
  FileMemory,
  type LLMMessage,
  type LLMProvider,
  type MessageDecoration,
} from '@inixiative/foundry-core';
import { CHORUS_RECEPTION, CHORUS_RECEPTION_LAYER } from '../src/agents/chorus-reception';
import { createSourceResolver } from '../src/agents/thread-factory';
import type { PhaseRecordInput } from '../src/agents/thread-runtime';
import { adviseOnce, chorusMessage, chorusPart } from '../src/feedback/chorus-advise';
import { type FoundryConfig, starterConfig } from '../src/viewer/config';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `foundry-${name}-`)));
  dirs.push(dir);
  return dir;
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const POINTER = 'Look over here: createLock (docs/claude/CONCURRENCY.md, Distributed Lock)';

/** A project whose repository enables a two-region chorus. */
function project(): string {
  const dir = tempDir('advise-project');
  write(join(dir, '.foundry', 'project.json'), JSON.stringify({ chorus: { enabled: true } }));
  for (const [id, title] of [
    ['concurrency-locks', 'Concurrency and locks'],
    ['lens-model', 'The lens model'],
  ] as const) {
    write(
      join(dir, '.foundry', 'regions', id, 'region.json'),
      JSON.stringify({ id, title, routing: `Is this about ${title}?`, concepts: [id] }),
    );
    write(
      join(dir, '.foundry', 'regions', id, 'knowledge.md'),
      `# ${title}\n\nKNOWLEDGE_${id}: what this region covers.\n`,
    );
  }
  return dir;
}

function config(path: string): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: 'WORKER_INSTRUCTIONS',
      provider: 'central',
      model: 'central-model',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  // Region Wardens run on the decision provider, as subscription-resolved settings route them.
  c.defaults.classifierProvider = 'flow';
  c.layers = {};
  c.sources = {};
  c.composition = { preset: 'none', nodes: {} };
  c.projects.P = { id: 'P', path };
  return c;
}

/** The decision host: the Cartographer routes nothing, concurrency-locks points, the rest stay silent. */
function decisions(calls: string[]): LLMProvider {
  return {
    id: 'flow',
    async complete(_messages: LLMMessage[], opts = {}) {
      const threadId = opts.threadId ?? '';
      calls.push(threadId);
      return {
        model: 'controlled',
        content: threadId.endsWith(':cartographer')
          ? JSON.stringify({ layers: [], domains: [], confidence: 1 })
          : threadId.includes('domain:concurrency-locks')
            ? JSON.stringify({ layers: [], snippets: [POINTER], confidence: 0.9 })
            : 'NO_COMMENT',
      };
    },
  };
}

test('one message through a live-built thread: the chimes on the message, the reception charter as the only standing chorus part', async () => {
  const dir = project();
  const c = config(dir);
  const calls: string[] = [];
  const journal: PhaseRecordInput[] = [];
  const advice = await adviseOnce({
    config: c,
    projectId: 'P',
    cwd: dir,
    message: 'Add a SET NX lock around the sync job',
    decisions: decisions(calls),
    resolveSource: createSourceResolver({
      memory: new FileMemory(join(tempDir('memory'), 'm')),
    }),
    threadId: 'advise-thread',
    journal: (record) => journal.push(record),
    log() {},
    warn() {},
  });
  // Every Warden was asked once, on its own primed session, plus the Cartographer.
  expect(calls.filter((id) => id.includes(':aux:domain:')).sort()).toEqual([
    'advise-thread:aux:domain:concurrency-locks',
    'advise-thread:aux:domain:lens-model',
  ]);
  expect(advice.decisions.map((d) => [d.domain, d.decision])).toEqual([
    ['concurrency-locks', 'contribute'],
    ['lens-model', 'no-comment'],
  ]);
  expect(advice.decisions[0]!.pointer).toMatchObject({ pointer: 'createLock', level: 'exact' });
  expect(advice.notes).toEqual([`The concurrency-locks Warden chimed in:\n- ${POINTER}`]);
  expect(advice.message).toBe(
    `Add a SET NX lock around the sync job\n\n---\n\nThe concurrency-locks Warden chimed in:\n- ${POINTER}`,
  );
  // The chorus's standing context is the reception charter alone, framed as a live session's system
  // prompt frames it; the executor's own instructions stay out (they are Foundry, not the chorus).
  expect(advice.systemAppend).toBe(`## Context: ${CHORUS_RECEPTION_LAYER}\n\n${CHORUS_RECEPTION}`);
  expect(advice.liveSystemPrompt).toContain(advice.systemAppend);
  expect(advice.liveSystemPrompt).toContain('WORKER_INSTRUCTIONS');
  expect(advice.systemAppend).not.toContain('WORKER_INSTRUCTIONS');
  expect(advice.standing.filter((p) => p.chorus).map((p) => p.id)).toEqual([
    CHORUS_RECEPTION_LAYER,
  ]);
  // The routing block is per-turn context: it rides the user prompt as `# System Context`, ahead of
  // the message, never the system prompt. The first prompt is exactly that.
  const routing = advice.decoration.blocks.find((b) => b.id === 'decoration:routing')!;
  expect(routing.placement).toBeUndefined();
  // The turn also carries the Librarian's thread state, a per-turn layer of every wrapped thread.
  expect(advice.turnText).toEndWith(`\n\n${routing.text}`);
  expect(advice.turnText).toStartWith('Current thread state.');
  expect(advice.nativePrompt).toBe(
    `# System Context\n\n${advice.turnText}\n\n# User Message\n\n${advice.message}`,
  );
  expect(advice.liveSystemPrompt).not.toContain(routing.text);
  // Every composed region has its decision and exact input; the orchestrator's live defaults ran.
  expect(advice.composed).toEqual(['concurrency-locks', 'lens-model']);
  expect(advice.decisions.every((d) => d.request.status === 'supplied')).toBe(true);
  expect(advice.timing).toMatchObject({ adviseTimeoutMs: 60_000, contributionBudget: null });
  expect(advice.primed).toBeUndefined();
  // The route and advice phase records, as the daemon journals them.
  expect(journal.map((r) => r.phase)).toEqual(['route', 'advice']);
});

test('prime warms every Warden with one decision on its own session before the message', async () => {
  const dir = project();
  const calls: string[] = [];
  let primedAt = -1;
  const advice = await adviseOnce({
    config: config(dir),
    projectId: 'P',
    cwd: dir,
    message: 'Add a SET NX lock around the sync job',
    decisions: decisions(calls),
    resolveSource: createSourceResolver({
      memory: new FileMemory(join(tempDir('memory'), 'm')),
    }),
    threadId: 'primed-thread',
    prime: true,
    onPrimed: () => {
      primedAt = calls.length;
    },
    log() {},
    warn() {},
  });
  const wardenCalls = calls.filter((id) => id.includes(':aux:domain:'));
  // Two calls per Warden on the same key: the priming decision, then the message's.
  expect(wardenCalls.filter((id) => id.endsWith('concurrency-locks'))).toHaveLength(2);
  expect(wardenCalls.filter((id) => id.endsWith('lens-model'))).toHaveLength(2);
  expect(calls.slice(0, primedAt).filter((id) => id.includes(':aux:domain:'))).toHaveLength(2);
  expect(advice.primed?.map((p) => [p.domain, p.outcome])).toEqual([
    ['concurrency-locks', 'answered'],
    ['lens-model', 'answered'],
  ]);
  // Priming reaches nothing: the message carries only its own advice.
  expect(advice.notes).toEqual([`The concurrency-locks Warden chimed in:\n- ${POINTER}`]);
});

test("the composed message is the executor's own for the same decoration", async () => {
  const decoration: MessageDecoration = {
    input: { hash: 'h', capturedAt: 0 },
    blocks: [
      { role: 'content', id: 'decoration:routing', text: 'Routing routed.' },
      {
        role: 'content',
        id: 'decoration:a',
        placement: 'after-message',
        text: 'The a Warden chimed in:\n- one',
      },
      {
        role: 'content',
        id: 'decoration:b',
        placement: 'after-message',
        text: 'The b Warden chimed in:\n- two',
      },
    ],
    participants: [],
    omissions: [],
    conflicts: [],
  };
  let sent: string | undefined;
  const executor = new Executor<string, string>({
    id: 'worker',
    stack: new ContextStack([]),
    handler: async (_context, payload) => {
      sent = payload;
      return '';
    },
  });
  await executor.run('the task', undefined, { annotations: { decoration } });
  expect(chorusMessage('the task', decoration)).toEqual({
    notes: ['The a Warden chimed in:\n- one', 'The b Warden chimed in:\n- two'],
    message: sent!,
  });
  // No chimes: the message as typed, as the executor sends it.
  await executor.run('quiet', undefined, {
    annotations: { decoration: { ...decoration, blocks: [decoration.blocks[0]!] } },
  });
  expect(chorusMessage('quiet', { ...decoration, blocks: [decoration.blocks[0]!] }).message).toBe(
    sent!,
  );
  expect(chorusPart(CHORUS_RECEPTION_LAYER, [])).toBe(true);
  expect(chorusPart('thread-knowledge:a', ['a'])).toBe(true);
  expect(chorusPart('instructions', ['a'])).toBe(false);
});
