/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:viewer
 */
/**
 * A disposable, seeded viewer for looking at the UI without the daemon: a temp config dir, a few
 * projects, threads in several states (nested child, archived, starting, waiting on a prompt), one
 * conversation with a member, and an executor that answers. No Kingdom pairing, so no tunnel and
 * no token. Fictional data only.
 *
 *   VIEWER_PORT=3500 bun run scripts/viewer-preview.ts
 */
// A preview must never write to the machine's live Archive: point it at the in-memory fake.
import '../packages/foundry/tests/helpers/isolate-archive';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionQueue,
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  type NativeEvidence,
  Thread,
  TokenTracker,
} from '../packages/core/src/index';
import { ProjectRegistry } from '../packages/foundry/src/agents/project';
import type { ConversationService } from '../packages/foundry/src/conversations/service';
import { ConfigStore, defaultAgents, starterConfig } from '../packages/foundry/src/viewer/config';
import { createViewer } from '../packages/foundry/src/viewer/server';

type Seed = {
  id: string;
  name: string;
  status?: 'idle' | 'active' | 'waiting' | 'archived';
  parent?: string;
  branch?: string;
};

const PROJECTS: { id: string; label: string; tags: string[]; threads: Seed[] }[] = [
  {
    id: 'kingdom',
    label: 'Kingdom',
    tags: ['inixiative'],
    threads: [
      {
        id: 'k-thread-view',
        name: 'Lift owner-only thread view for Signet members',
        status: 'active',
        branch: 'feat/thread-view',
      },
      {
        id: 'k-signet-kind',
        name: 'Signet: release threads.ts kind enum',
        parent: 'k-thread-view',
      },
      { id: 'k-pool', name: 'Capacity pool picker', status: 'waiting' },
      { id: 'k-old', name: 'Old cookie cleanup', status: 'archived' },
    ],
  },
  {
    id: 'template',
    label: 'template',
    tags: ['inixiative', 'primitives'],
    threads: [
      { id: 't-regions', name: 'Rebuild template Warden regions', status: 'active' },
      { id: 't-split', name: 'Split primitive:shared into its primitives', parent: 't-regions' },
      { id: 't-locks', name: 'Locks: sibling table', parent: 't-regions' },
      { id: 't-review', name: 'Review: rules-builder relations (#19)' },
    ],
  },
  {
    id: 'acme-shop',
    label: 'acme-shop',
    tags: ['acme'],
    threads: [
      { id: 'a-checkout', name: 'Maya: checkout errors since 2:02', status: 'waiting' },
      { id: 'a-retry', name: 'Dana: retry limit, 3 or 5?' },
      { id: 'a-relations', name: 'ACME-523 to-many relations in lens where' },
    ],
  },
  {
    id: 'archive',
    label: 'Archive',
    tags: ['inixiative'],
    threads: [{ id: 'r-routing', name: 'Archive routing: agentic pass', status: 'active' }],
  },
];

/** Build and serve the seeded viewer. Returns the URL and a disposer. */
export async function createViewerPreview(port = 0) {
  const root = mkdtempSync(join(tmpdir(), 'foundry-viewer-preview-'));
  const main = new Thread('main', new ContextStack(), { description: 'Global work' });
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async () => 'Done. I followed the payments guide and kept the retry limit at 3.',
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  const queue = new ActionQueue();
  const projects = new ProjectRegistry();
  const seeded = new Map<string, Thread>();
  for (const p of PROJECTS) {
    const path = join(root, p.id);
    mkdirSync(path, { recursive: true });
    const project = projects.register({
      id: p.id,
      path,
      label: p.label,
      tags: p.tags,
      runtime: 'claude-code',
    });
    for (const s of p.threads) {
      const thread = new Thread(s.id, new ContextStack(), {
        description: s.name,
        projectId: p.id,
        ...(s.parent ? { parentThreadId: s.parent } : {}),
        ...(s.branch ? { branch: s.branch } : {}),
      });
      // Seeded children are subagents (only subagents nest in the rail).
      if (s.parent) thread.meta.spawn = { via: 'native-claude', observed: true };
      if (s.status === 'archived') thread.archive();
      else if (s.status) thread.meta.status = s.status;
      project.addThread(thread);
      seeded.set(s.id, thread);
    }
  }
  const configStore = new ConfigStore(join(root, '.foundry'));
  const config = starterConfig('controlled', 'controlled');
  config.agents = defaultAgents();
  config.setupComplete = true;
  // A real install keeps its projects in settings as well as the registry; without them every
  // Project settings page reads "not registered".
  for (const p of PROJECTS)
    config.projects[p.id] = { id: p.id, path: join(root, p.id), label: p.label, tags: p.tags };
  await configStore.save(config);
  const viewer = createViewer({
    harness,
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    tokenTracker: new TokenTracker(),
    configStore,
    configDir: join(root, '.foundry'),
    projectRegistry: projects,
    actionQueue: queue,
  });
  seedPlanAndWork(viewer, seeded, join(root, 'kingdom'));
  // One thread waits on an approval; one has a member who posted.
  void queue.prompt({
    kind: 'approval',
    message: 'Allow git push origin feat/thread-view?',
    agentId: 'worker',
    threadId: 'k-pool',
    capability: 'git.push',
    urgency: 'high',
  });
  const signetId = crypto.randomUUID();
  viewer.conversations?.admit({
    type: 'thread.request',
    requestId: crypto.randomUUID(),
    signetId,
    acceptedRevision: 1,
    member: { signetId, displayName: "Sam's agent" },
    terms: { view: 'thread', delivery: 'note', outbound: 'review', floor: { mayTake: false } },
    operation: 'thread.prompt',
    input: { threadId: 'main', postId: crypto.randomUUID(), text: 'Can you keep our test name?' },
  } as Parameters<ConversationService['admit']>[0]);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: viewer.fetch,
    websocket: viewer.websocket,
  });
  return {
    url: `http://localhost:${server.port}`,
    dispose: () => {
      server.stop(true);
      viewer.localStore?.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Preview',
      GIT_AUTHOR_EMAIL: 'preview@example.test',
      GIT_COMMITTER_NAME: 'Preview',
      GIT_COMMITTER_EMAIL: 'preview@example.test',
    },
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
};

const toolUse = (toolName: string, toolInput: Record<string, unknown>) =>
  ({
    schema: 1,
    nativeOutcome: 'unknown',
    kind: 'tool_use',
    toolName,
    toolInput,
  }) as NativeEvidence;

/**
 * The lead Kingdom thread gets a real branch (two commits ahead of main) and two recorded turns
 * whose plan tool and file writes fill its Plan and Work tabs; its subagent was spawned on turn 1.
 */
function seedPlanAndWork(
  viewer: ReturnType<typeof createViewer>,
  threads: Map<string, Thread>,
  repo: string,
) {
  const lead = threads.get('k-thread-view');
  const store = viewer.localStore;
  if (!lead || !store) return;
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'kingdom\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feat/thread-view');
  for (const [file, message] of [
    ['grant.ts', 'Split the owner-only condition'],
    ['grant.test.ts', 'Add the own-asks-thread 403 case'],
  ] as const) {
    writeFileSync(join(repo, file), `// ${message}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', message);
  }
  lead.meta.cwd = repo;
  const child = threads.get('k-signet-kind');
  if (child) child.meta.parentTurnId = 'kt-1';
  const todos = (items: Array<[string, string]>) =>
    toolUse('TodoWrite', { todos: items.map(([content, status]) => ({ content, status })) });
  const turns: Array<[string, string, NativeEvidence[]]> = [
    [
      'kt-1',
      'Members should read the whole thread; answering prompts stays owner-only.',
      [
        todos([
          ['Find where the owner-only rule lives', 'in_progress'],
          ['Split view from prompt.resolve', 'pending'],
          ['Cover own → thread with a 403 test', 'pending'],
        ]),
      ],
    ],
    [
      'kt-2',
      'Go ahead and split it.',
      [
        todos([
          ['Find where the owner-only rule lives', 'completed'],
          ['Split view from prompt.resolve', 'completed'],
          ['Cover own → thread with a 403 test', 'in_progress'],
        ]),
        toolUse('Edit', { file_path: 'apps/api/src/validateThreadsGrant.ts' }),
        toolUse('Write', { file_path: 'apps/api/src/validateThreadsGrant.test.ts' }),
      ],
    ],
  ];
  turns.forEach(([id, ask, history], i) => {
    store.beginTurn(lead, id, ask);
    store.completeTurn(
      lead,
      id,
      'Done.',
      { nativeHistory: history },
      { id: `trace-${id}`, messageId: id, startedAt: i + 1, root: {}, summary: {}, spans: [] },
    );
  });
}

if (import.meta.main) {
  const preview = await createViewerPreview(Number(process.env.VIEWER_PORT ?? 3500));
  console.log(`VIEWER_PREVIEW=${preview.url}`);
  const stop = () => {
    preview.dispose();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
