import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionQueue, ContextStack, Thread, ToolRegistry } from '@inixiative/foundry-core';
import type { HostedSignet } from '@inixiative/signet';
import { ConversationService } from '../src/conversations/service';
import type { HeldRecord } from '../src/conversations/types';
import { createFoundryMcp } from '../src/mcp/server';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { CONVERSATION_TOOL_DESCRIPTION, ConversationTool } from '../src/tools/conversation';
import {
  KingdomPostTool,
  kingdomPostDelivery,
  registerKingdomPost,
} from '../src/tools/kingdom-post';
import { heldSignet, mockKingdom, userOwner } from './helpers/kingdom-installation';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(
  require.resolve('@modelcontextprotocol/sdk/inMemory.js')
);

// The agent's conversation tools (CONVERSATIONS.md §4.5) on the Foundry MCP bridge every runtime
// gets (Claude through withNativeBridge, Codex through the app-server bridge): the host's
// send_to_member and pass_conch, and the joining side's kingdom_post, held in its own handler before
// anything leaves. Real MCP server and client, real journal, a scripted Kingdom for the post.

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function until(predicate: () => boolean, label: string, ms = 3000) {
  const end = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > end) throw Error(`deadline: ${label}`);
    await Bun.sleep(5);
  }
}

const projectId = 'project-conversations';

function hostedMember(threadId: string, outbound: 'review' | 'auto'): HostedSignet {
  return {
    signetId: crypto.randomUUID(),
    integrationId: crypto.randomUUID(),
    name: 'JobCo',
    revision: 1,
    lifecycle: 'ongoing',
    expiresAt: null,
    maxRequests: null,
    maxConcurrent: 1,
    recipient: { recipientModel: 'User', id: crypto.randomUUID(), displayName: 'JobCo' },
    resources: [
      {
        resourceId: crypto.randomUUID(),
        kind: 'threads',
        operations: ['thread.prompt', 'thread.read'],
        lens: {
          threads: { form: 'ids', ids: [threadId] },
          view: 'own',
          delivery: 'note',
          outbound,
        },
      },
    ],
  };
}

async function bridge(opts: {
  outbound?: 'review' | 'auto';
  agentMayPass?: boolean;
  register?: (tools: ToolRegistry, service: ConversationService) => void | Promise<void>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-tools-'));
  const store = new LocalSessionStore(join(dir, 'sessions.sqlite'));
  const thread = new Thread('thread_tools', new ContextStack(), { projectId });
  const member = hostedMember(thread.id, opts.outbound ?? 'auto');
  const queue = new ActionQueue();
  const tools = new ToolRegistry();
  const service = new ConversationService({
    store,
    thread: (id) => (id === thread.id ? thread : undefined),
    turns: () => null,
    queue,
    project: () => ({
      id: projectId,
      path: dir,
      conversations: { floor: 'conch', conch: { agentMayPass: opts.agentMayPass ?? false } },
    }),
    hosted: () => [member],
    subscriptions: () => [],
    deliverPost: kingdomPostDelivery(tools),
  });
  tools.register(new ConversationTool(() => service), CONVERSATION_TOOL_DESCRIPTION);
  await opts.register?.(tools, service);
  const mcp = createFoundryMcp({ thread, tools });
  const client = new Client({ name: 'conversation-tools', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    service.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError, text: (result.content as Array<{ text: string }>)[0]!.text };
  };
  return { thread, store, service, queue, member, client, call };
}

test('send_to_member is the only text that leaves: auto releases at once, review holds it in the handler; pass_conch needs the owner leave', async () => {
  const auto = await bridge({ outbound: 'auto' });
  const names = (await auto.client.listTools()).tools.map((tool: any) => tool.name);
  expect(names).toEqual(expect.arrayContaining(['send_to_member', 'pass_conch']));
  expect(names).not.toContain('kingdom_post');
  expect(await auto.call('send_to_member', { member: 'JobCo', text: 'Hi JobCo' })).toEqual({
    isError: false,
    text: 'Sent to JobCo.',
  });
  const rows = auto.store.phasesOf(auto.thread.id, 'outbound-held');
  expect(rows.map((row) => (row.record as unknown as HeldRecord).status)).toEqual(['released']);
  expect(await auto.call('send_to_member', { member: 'Nobody', text: 'x' })).toMatchObject({
    isError: true,
  });
  expect((await auto.call('pass_conch', { member: 'JobCo' })).text).toContain('agentMayPass');

  const review = await bridge({ outbound: 'review', agentMayPass: true });
  const held = await review.call('send_to_member', { member: 'JobCo', text: 'Held text' });
  expect(held.text).toContain("Held for the owner's review");
  expect(review.queue.pending().map((prompt) => prompt.meta?.conversationHeld)).toMatchObject([
    { kind: 'send', text: 'Held text', toName: 'JobCo' },
  ]);
  expect(await review.call('pass_conch', { member: 'JobCo' })).toEqual({
    isError: false,
    text: 'The conch is with JobCo.',
  });
  expect((await review.call('pass_conch', { member: null })).text).toBe(
    'The conch is with the host.',
  );
});

test('kingdom_post holds the post for the owner before anything leaves, then posts it once through the held Signet', async () => {
  const executions: any[] = [];
  const remoteThread = 'thread_remote';
  let resourceId = '';
  let integrationId = '';
  const kingdom = mockKingdom({
    onSignet(action, body, presented) {
      if (action === 'describe')
        return {
          signetId: presented.signetId,
          integrationId,
          name: 'Host conversation',
          expiresAt: null,
          provider: 'foundry',
          lifecycle: 'ongoing',
          taskId: null,
          currentRevision: 1,
          remainingRequests: null,
          operations: [
            {
              key: 'thread.prompt',
              name: 'Post',
              resources: [
                {
                  id: resourceId,
                  name: 'threads',
                  kind: 'threads',
                  integrationId,
                  lens: {
                    threads: { form: 'ids', ids: [remoteThread] },
                    view: 'own',
                    delivery: 'note',
                    outbound: 'review',
                  },
                },
              ],
            },
          ],
        };
      if (action === 'execute') {
        executions.push(body);
        return {
          executionId: crypto.randomUUID(),
          result: { accepted: true, journalSeq: 1, duplicate: false },
        };
      }
      return new Response(null, { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'kingdom-post-'));
  cleanup.push(() => {
    kingdom.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const held = await heldSignet(kingdom, dir, userOwner());
  integrationId = held.integrationId;
  resourceId = crypto.randomUUID();
  const source = {
    id: crypto.randomUUID(),
    name: 'Host conversation',
    url: kingdom.url,
    credentialFile: held.credentialFile,
    integrationId,
    signetId: held.signetId,
    projectIds: [projectId],
  };
  const f = await bridge({
    register: (tools, service) => registerKingdomPost(tools, [source], () => service),
  });
  expect(f.client).toBeDefined();
  const names = (await f.client.listTools()).tools.map((tool: any) => tool.name);
  expect(names).toContain('kingdom_post');
  const answer = await f.call('kingdom_post', {
    accessId: source.id,
    threadId: remoteThread,
    text: 'Our client wants the role.',
  });
  expect(answer).toEqual({
    isError: false,
    text: "Held for the owner's review; it is posted once released.",
  });
  // Nothing left: the post waits in the journal and the owner's prompt.
  expect(executions).toHaveLength(0);
  const prompt = f.queue.pending()[0]!;
  expect(prompt.meta?.conversationHeld).toMatchObject({
    kind: 'post',
    remoteThreadId: remoteThread,
  });
  // A source outside this project is refused before anything is held.
  const tool = new KingdomPostTool([{ ...source, projectIds: ['elsewhere'] }], () => f.service);
  expect(
    (
      await tool
        .scoped({ projectId, threadId: f.thread.id })
        .post('post', { accessId: source.id, threadId: remoteThread, text: 'x' })
    ).ok,
  ).toBe(false);

  f.service.submitHeld(
    (prompt.meta!.conversationHeld as { heldId: string }).heldId,
    'edit',
    'Our client wants the role; details follow.',
  );
  await until(() => executions.length === 1, 'posted');
  expect(executions[0]).toMatchObject({
    operation: 'thread.prompt',
    signetId: held.signetId,
    integrationId,
    input: {
      resourceId,
      threadId: remoteThread,
      text: 'Our client wants the role; details follow.',
      postId: expect.any(String),
    },
  });
  await until(
    () => f.store.phasesOf(f.thread.id, 'outbound-delivered').length === 1,
    'delivery journalled',
  );
  expect(f.store.phasesOf(f.thread.id, 'outbound-delivered')[0]!.record).toMatchObject({
    executionId: expect.any(String),
  });
});
