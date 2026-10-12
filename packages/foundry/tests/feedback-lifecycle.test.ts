import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionQueue, ContextStack, Thread } from '@inixiative/foundry-core';
import type { RouteResult } from '../src/agents/cartographer';
import { applyChange, guardPersonalFile, revertChange, roleFilePath } from '../src/feedback/apply';
import { FeedbackLifecycle } from '../src/feedback/lifecycle';
import { routeFeedback } from '../src/feedback/routing';
import { type ClassifyCorrection, FeedbackService } from '../src/feedback/service';
import { lintStatement, parseMatch, ruleMarker } from '../src/feedback/sharpen';
import { validateFeedbackSettings } from '../src/feedback/types';
import { assess } from '../src/feedback/view';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { type AgentSettingsConfig, type FoundryConfig, starterConfig } from '../src/viewer/config';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });

const warden = (domain: string): AgentSettingsConfig => ({
  id: `${domain}-warden`,
  kind: 'decider',
  flowRole: 'domain-advising',
  domain,
  prompt: `INSTRUCTIONS_${domain}`,
  provider: 'expert',
  model: 'haiku',
  tools: false,
  visibleLayers: [`${domain}-reference`],
  ownedLayers: [`${domain}-reference`],
  peers: [],
  maxDepth: 1,
  enabled: true,
});
function config(feedback?: FoundryConfig['feedback']): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.agents = { 'convention-warden': warden('convention') };
  c.layers = {
    'convention-reference': {
      id: 'convention-reference',
      domain: 'convention',
      segment: 'domain-knowledge',
      prompt: 'Conventions',
      sourceIds: [],
      writers: ['convention-warden'],
      staleness: 0,
      enabled: true,
    },
  };
  if (feedback) c.feedback = feedback;
  return c;
}

const RULE = 'When a change is green on the agentic side, merge it yourself.';

function setup(
  options: {
    feedback?: FoundryConfig['feedback'];
    classify?: ClassifyCorrection;
    route?: RouteResult;
    match?: { itemId: string; confidence: number } | null;
  } = {},
) {
  const root = tempDir('feedback-project-');
  const project = join(root, 'repo');
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-q');
  const home = tempDir('feedback-home-');
  const store = new LocalSessionStore(join(tempDir('feedback-store-'), 'sessions.sqlite'));
  cleanup.push(() => store.close());
  const thread = new Thread('t1', new ContextStack(), { projectId: 'P' });
  store.beginTurn(thread, 'turn-0', 'please do the change');
  store.completeTurn(
    thread,
    'turn-0',
    'Done. Shall I open a PR for you to merge?',
    {},
    {
      id: 'trace-0',
      messageId: 'turn-0',
      startedAt: 1,
      root: {},
      summary: { id: 'trace-0' },
      spans: [],
    },
  );
  const queue = new ActionQueue();
  const invalidated: string[] = [];
  const classifyCalls: Array<{ text: string; before: string; priority: number }> = [];
  const service = new FeedbackService({
    store,
    config: () => config(options.feedback),
    queue,
    thread: (id) => (id === thread.id ? thread : undefined),
    cartographer: () => ({
      route: async () =>
        options.route ?? { layers: [], domains: ['convention'], confidence: 0.9, source: 'model' },
    }),
    classify:
      options.classify ??
      (async (input) => {
        classifyCalls.push(input);
        return {
          isCorrection: true,
          category: 'approach',
          statements: [RULE],
          sharp: true,
          requestHash: 'h',
          providerId: 'fake',
        };
      }),
    match: async () => ({ match: options.match ?? null, requestHash: 'm', providerId: 'fake' }),
    invalidate: (role) => invalidated.push(role),
    roots: () => ({ home, project, org: root }),
  });
  return { service, store, thread, queue, invalidated, project, home, root, classifyCalls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('settings validation names the field', () => {
  expect(() => validateFeedbackSettings('feedback', { tuning: 'tell' })).toThrow('feedback.tuning');
  expect(() => validateFeedbackSettings('feedback', { blockOn: ['opener'] })).toThrow('blockOn');
  expect(() => validateFeedbackSettings('feedback', { extra: 1 })).toThrow('unknown field extra');
  validateFeedbackSettings('feedback', {
    tuning: 'block',
    blockOn: ['repeat'],
    blockTimeoutMs: 5000,
  });
});

test('a rule is sharp only when it is one bounded, unhedged sentence', () => {
  expect(lintStatement(RULE)).toEqual({ ok: true });
  expect(lintStatement('Try to be more careful with tests.').ok).toBe(false);
  expect(lintStatement('Merge it. Then deploy it.').ok).toBe(false);
  expect(lintStatement('x'.repeat(161)).ok).toBe(false);
  expect(lintStatement(`Never do this (${'fb_0123456789ab'}).`).ok).toBe(false);
});

test('a match answer names a known candidate with a bounded confidence', () => {
  const candidates = [{ id: 'fb_aaaaaaaaaaaa' }];
  expect(parseMatch('{"itemId":"fb_aaaaaaaaaaaa","confidence":0.8}', candidates)).toEqual({
    itemId: 'fb_aaaaaaaaaaaa',
    confidence: 0.8,
  });
  expect(parseMatch('{"itemId":"fb_bbbbbbbbbbbb","confidence":0.8}', candidates)).toBeNull();
  expect(parseMatch('{"itemId":"fb_aaaaaaaaaaaa","confidence":3}', candidates)).toBeNull();
  expect(parseMatch('not json', candidates)).toBeNull();
});

test('routing maps Cartographer domains to Warden roles, and weak routing goes to main', async () => {
  const route = (result: RouteResult) =>
    routeFeedback({
      cartographer: { route: async () => result },
      config: config(),
      itemId: 'fb_x',
      statement: RULE,
      category: 'convention',
      hasProject: true,
    });
  expect(
    await route({ layers: [], domains: ['convention'], confidence: 0.9, source: 'model' }),
  ).toMatchObject({
    roles: ['convention-warden'],
    slot: 'instructions',
    level: 'project-personal',
  });
  expect(
    (
      await route({
        layers: [],
        domains: ['convention'],
        confidence: 0.1,
        source: 'keyword-fallback',
      })
    ).roles,
  ).toEqual(['main']);
  expect(
    (await route({ layers: [], domains: ['unknown'], confidence: 0.9, source: 'model' })).roles,
  ).toEqual(['main']);
});

test('role files resolve per rung; personal repo files are kept out of git', () => {
  const root = tempDir('feedback-paths-');
  const project = join(root, 'repo');
  mkdirSync(project);
  git(project, 'init', '-q');
  const roots = { home: join(root, 'home'), project, org: root };
  expect(roleFilePath('computer', 'convention-warden', 'instructions', roots)).toBe(
    join(root, 'home', '.foundry/roles/convention-warden/instructions.md'),
  );
  expect(roleFilePath('project-personal', 'main', 'domainKnowledge', roots)).toBe(
    join(project, '.foundry/roles/main/domainKnowledge.local.md'),
  );
  expect(() => roleFilePath('computer', '../escape', 'instructions', roots)).toThrow(
    'Invalid role',
  );

  const path = roleFilePath('project-personal', 'convention-warden', 'instructions', roots);
  guardPersonalFile(path);
  expect(readFileSync(join(project, '.git/info/exclude'), 'utf8')).toContain(
    '.foundry/roles/**/*.local.md',
  );
  mkdirSync(join(project, '.foundry/roles/convention-warden'), { recursive: true });
  writeFileSync(path, 'x\n');
  expect(git(project, 'status', '--porcelain').stdout.toString()).toBe('');
  // A tracked file is never edited.
  const tracked = join(project, '.foundry/roles/main/instructions.local.md');
  mkdirSync(join(project, '.foundry/roles/main'), { recursive: true });
  writeFileSync(tracked, 'tracked\n');
  git(project, 'add', '-f', tracked);
  expect(() => guardPersonalFile(tracked)).toThrow('tracked');
});

test('apply appends one line with the item id; revert removes exactly that line', () => {
  const root = tempDir('feedback-apply-');
  const roots = { home: root };
  const first = applyChange({
    itemId: 'fb_111111111111',
    changeId: 'c1',
    statement: RULE,
    role: 'convention-warden',
    slot: 'instructions',
    level: 'computer',
    roots,
  });
  applyChange({
    itemId: 'fb_222222222222',
    changeId: 'c2',
    statement: 'Never add backwards compatibility shims.',
    role: 'convention-warden',
    slot: 'instructions',
    level: 'computer',
    roots,
  });
  expect(first.line).toBe(`- ${RULE} (fb_111111111111)`);
  expect(() => applyChange({ ...first, statement: RULE, roots, level: 'project' })).toThrow(
    'pull request',
  );
  const reverted = revertChange(first);
  expect(reverted.found).toBe(true);
  const text = readFileSync(first.path, 'utf8');
  expect(text).not.toContain('fb_111111111111');
  expect(text).toContain('fb_222222222222');
  expect(revertChange(first).found).toBe(false);
});

test('a detected correction is captured, routed and tuned without holding the turn (ask)', async () => {
  const { service, thread, queue, store, classifyCalls } = setup();
  service.turnAccepted(thread, 'turn-1', 'No, merge it yourself once green, I told you already.');
  await service.held('turn-1');
  await settle();
  expect(classifyCalls[0]?.before).toContain('Shall I open a PR');
  const [prompt] = queue.pending();
  expect(prompt?.kind).toBe('choice');
  expect(prompt?.meta?.feedback).toMatchObject({ blocking: false });
  expect(prompt?.message).toContain('convention-warden');
  const [item] = service.lifecycle.items;
  expect(item).toMatchObject({
    statement: RULE,
    sharp: true,
    status: 'open',
    category: 'approach',
  });
  expect(item?.detection?.kind).toBe('repeat');
  expect(item?.route).toMatchObject({ roles: ['convention-warden'], level: 'org-personal' });
  // Every step is a journal row, and a fresh fold over them is the same item.
  const phases = store.feedbackPhases({ projectId: 'P' }).map((p) => p.phase);
  expect(phases).toEqual(['feedback-capture', 'feedback-route']);
  expect(new FeedbackLifecycle(store.feedbackPhases()).get(item!.id)).toEqual(item);
});

test('apply writes the rule to the routed Warden, invalidates its layers, and undo reverts it', async () => {
  const { service, thread, queue, invalidated, root, store } = setup();
  service.turnAccepted(thread, 'turn-1', 'From now on merge it yourself once green.');
  await settle();
  const [prompt] = queue.pending();
  queue.resolve(prompt!.id, 'apply');
  await settle();
  const [item] = service.lifecycle.items;
  expect(item?.status).toBe('applied');
  const change = item!.changes[0]!;
  expect(change.path).toBe(join(root, '.foundry/roles/convention-warden/instructions.local.md'));
  expect(readFileSync(change.path, 'utf8')).toContain(`${RULE} ${ruleMarker(item!.id)}`);
  expect(invalidated).toEqual(['convention-warden']);

  // Use: a later advice call whose Warden segments carry the rule counts as exposure.
  store.appendPhase(thread, {
    id: 'phase-advice',
    turnId: 'turn-2',
    dispatchId: null,
    phase: 'advice',
    record: {
      participants: [
        {
          domain: 'convention',
          decision: 'contribute',
          segments: { instructions: readFileSync(change.path, 'utf8') },
        },
        { domain: 'docs', decision: 'abstain', segments: { instructions: 'other' } },
      ],
    },
  });
  expect(service.uses(item!.id)).toMatchObject([
    { threadId: 't1', turnId: 'turn-2', phase: 'advice', roles: ['convention-warden'] },
  ]);

  service.undo(item!.id, change.changeId);
  expect(readFileSync(change.path, 'utf8')).not.toContain(item!.id);
  expect(service.lifecycle.get(item!.id)?.status).toBe('open');
  expect(service.uses(item!.id)).toEqual([]);
});

test('edit replaces the statement and level before applying; committed levels are refused', async () => {
  const { service, thread, queue, home } = setup();
  service.turnAccepted(thread, 'turn-1', 'Never ask me before merging agentic repos.');
  await settle();
  const [prompt] = queue.pending();
  queue.resolve(prompt!.id, 'edit', {
    input: JSON.stringify({
      statement: 'Never ask before merging green agentic changes.',
      level: 'computer',
    }),
  });
  await settle();
  const [item] = service.lifecycle.items;
  expect(item?.statement).toBe('Never ask before merging green agentic changes.');
  expect(item?.changes[0]?.path).toBe(
    join(home, '.foundry/roles/convention-warden/instructions.md'),
  );
});

test('blocking tuning holds the turn until answered, and times out to deferred', async () => {
  const { service, thread, queue } = setup({
    feedback: { tuning: 'block', blockTimeoutMs: 1_000 },
  });
  service.turnAccepted(thread, 'turn-1', 'Again: merge it yourself.');
  let released = false;
  const held = service.held('turn-1').then(() => {
    released = true;
  });
  await settle();
  expect(released).toBe(false);
  const [prompt] = queue.pending();
  expect(prompt?.meta?.feedback).toMatchObject({ blocking: true });
  queue.resolve(prompt!.id, 'apply');
  await held;
  expect(service.lifecycle.items[0]?.status).toBe('applied');

  service.turnAccepted(thread, 'turn-2', 'Again, never do that.');
  await service.held('turn-2');
  expect(service.lifecycle.items.some((item) => item.status === 'deferred')).toBe(true);
}, 5_000);

test('blockOn escalates a repeat marker to blocking while tuning stays ask', async () => {
  const { service, thread, queue } = setup({ feedback: { blockOn: ['repeat'] } });
  service.turnAccepted(
    thread,
    'turn-1',
    'How many times do I have to say this, merge it yourself.',
  );
  await settle();
  expect(queue.pending()[0]?.meta?.feedback).toMatchObject({ blocking: true });
  service.turnAccepted(thread, 'turn-2', 'From now on merge it yourself.');
  await settle();
  expect(queue.pending()[1]?.meta?.feedback).toMatchObject({ blocking: false });
});

test('not a correction, no detector hit, or capture off: nothing is journalled', async () => {
  const notCorrection: ClassifyCorrection = async () => ({
    isCorrection: false,
    category: 'other',
    statements: [],
    sharp: false,
    requestHash: 'h',
    providerId: 'fake',
  });
  const a = setup({ classify: notCorrection });
  a.service.turnAccepted(a.thread, 'turn-1', 'Never mind, thanks.');
  a.service.turnAccepted(a.thread, 'turn-2', 'Please add a settings page.');
  await settle();
  expect(a.store.feedbackPhases()).toEqual([]);
  const b = setup({ feedback: { capture: false } });
  b.service.turnAccepted(b.thread, 'turn-1', 'Again, merge it yourself.');
  await settle();
  expect(b.store.feedbackPhases()).toEqual([]);
});

test('an unsharp correction asks for the rule instead of offering apply', async () => {
  const { service, thread, queue } = setup({
    classify: async () => ({
      isCorrection: true,
      category: 'other',
      statements: [],
      sharp: false,
      requestHash: 'h',
      providerId: 'fake',
    }),
  });
  service.turnAccepted(thread, 'turn-1', "No, that's not it.");
  await settle();
  const [prompt] = queue.pending();
  expect(prompt?.options?.map((o) => o.id)).not.toContain('apply');
  expect(service.lifecycle.items[0]?.sharp).toBe(false);
});

test('one message carrying several rules becomes one item per rule', async () => {
  const { service, thread } = setup({
    classify: async () => ({
      isCorrection: true,
      category: 'convention',
      statements: [RULE, 'Never add backwards compatibility shims.'],
      sharp: true,
      requestHash: 'h',
      providerId: 'fake',
    }),
  });
  service.turnAccepted(thread, 'turn-1', 'Again: merge it yourself, and never add compat shims.');
  await settle();
  expect(service.lifecycle.items.map((i) => i.statement).sort()).toEqual(
    ['Never add backwards compatibility shims.', RULE].sort(),
  );
});

test('a recurrence of an applied rule is counted on the item and re-tuned', async () => {
  const first = setup();
  first.service.turnAccepted(first.thread, 'turn-1', 'From now on merge it yourself.');
  await settle();
  first.queue.resolve(first.queue.pending()[0]!.id, 'apply');
  await settle();
  const itemId = first.service.lifecycle.items[0]!.id;
  // Same store, new service: the fold is rebuilt from the journal, then the same rule comes back.
  const again = new FeedbackService({
    store: first.store,
    config: () => config(),
    queue: first.queue,
    thread: () => first.thread,
    cartographer: () => undefined,
    classify: async () => ({
      isCorrection: true,
      category: 'approach',
      statements: [RULE],
      sharp: true,
      requestHash: 'h',
      providerId: 'fake',
    }),
    match: async () => ({
      match: { itemId, confidence: 0.9 },
      requestHash: 'm',
      providerId: 'fake',
    }),
    invalidate: () => {},
    roots: () => ({ home: first.home, project: first.project, org: first.root }),
  });
  expect(again.lifecycle.get(itemId)?.status).toBe('applied');
  again.turnAccepted(first.thread, 'turn-3', 'Again, merge it yourself!');
  await settle();
  const item = again.lifecycle.get(itemId);
  expect(item?.recurrences).toHaveLength(1);
  expect(again.lifecycle.items).toHaveLength(1);
  const prompt = first.queue.pending().at(-1);
  expect(prompt?.message).toContain('repeats rule');
});

test('an explicit /correction is captured without the detector', async () => {
  const { service, thread } = setup();
  const items = await service.intervention(thread, 'Merge it yourself once green.');
  expect(items[0]).toMatchObject({ originKind: 'intervention', statement: RULE });
});

test('assessment: stage, attention and exposure-based confidence come from the journal evidence', async () => {
  const { service, thread, queue, store } = setup();
  service.turnAccepted(thread, 'turn-1', 'From now on merge it yourself.');
  await settle();
  const id = service.lifecycle.items[0]!.id;
  const view = () => {
    const item = service.lifecycle.get(id)!;
    return assess(item, service.uses(id));
  };
  expect(view()).toMatchObject({
    stage: 'routed',
    attention: 'in progress',
    confidence: { value: null },
  });
  queue.resolve(queue.pending()[0]!.id, 'apply');
  await settle();
  expect(view()).toMatchObject({ stage: 'applied', confidence: { value: 0, basis: 'exposure' } });
  const path = service.lifecycle.get(id)!.changes[0]!.path;
  for (const n of [1, 2, 3])
    store.appendPhase(thread, {
      id: `advice-${n}`,
      turnId: `turn-${n + 1}`,
      dispatchId: null,
      phase: 'advice',
      record: {
        participants: [
          { domain: 'convention', segments: { instructions: readFileSync(path, 'utf8') } },
        ],
      },
    });
  expect(view()).toMatchObject({
    stage: 'holding',
    attention: 'healthy',
    confidence: { value: 0.5 },
  });
});

test('assessment: an applied rule that recurs needs attention; an unsharp one does too', () => {
  const lifecycle = new FeedbackLifecycle();
  const capture = (itemId: string, at: number, sharp = true) =>
    lifecycle.apply({
      threadId: 't',
      turnId: `turn-${at}`,
      phase: 'feedback-capture',
      storedAt: at,
      record: {
        itemId,
        statement: RULE,
        sharp,
        category: 'approach',
        tags: [],
        quote: 'q',
        before: '',
        origin: 'detected',
      },
    });
  capture('fb_a', 1);
  lifecycle.apply({
    threadId: 't',
    turnId: null,
    phase: 'feedback-apply',
    storedAt: 2,
    record: {
      itemId: 'fb_a',
      changeId: 'c',
      role: 'main',
      slot: 'instructions',
      level: 'computer',
      path: '/x',
      line: 'l',
    },
  });
  capture('fb_a', 3);
  expect(assess(lifecycle.get('fb_a')!, [])).toMatchObject({
    stage: 'recurred',
    attention: 'needs attention',
    recurredSince: 1,
    confidence: { value: 0.25 },
  });
  capture('fb_b', 4, false);
  expect(assess(lifecycle.get('fb_b')!, [])).toMatchObject({
    stage: 'captured',
    attention: 'needs attention',
  });
});
