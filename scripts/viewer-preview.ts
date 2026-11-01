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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionQueue,
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
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
      if (s.status === 'archived') thread.archive();
      else if (s.status) thread.meta.status = s.status;
      project.addThread(thread);
    }
  }
  const configStore = new ConfigStore(join(root, '.foundry'));
  const config = starterConfig('controlled', 'controlled');
  config.agents = defaultAgents();
  config.setupComplete = true;
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
    lens: {
      threads: { form: 'ids', ids: ['main'] },
      view: 'thread',
      delivery: 'note',
      outbound: 'review',
    },
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
