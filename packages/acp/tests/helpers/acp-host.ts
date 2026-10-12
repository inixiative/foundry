import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClientConnection,
  client,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { newAcpCapability, writeAcpLaunch } from '@inixiative/foundry/client';
import type { createViewer } from '../../../foundry/src/viewer/server';

const CLI = join(import.meta.dir, '../../src/cli.ts');

/** Serve a viewer's HTTP and socket on an ephemeral loopback port and publish its ACP launch file, as the daemon does. */
export function serveDaemon(
  viewer: Pick<ReturnType<typeof createViewer>, 'fetch' | 'websocket'>,
  launchAt?: string,
) {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-acp-host-'));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: viewer.fetch,
    websocket: viewer.websocket,
  });
  const launchPath = launchAt ?? join(dir, 'acp-launch.json');
  writeAcpLaunch(launchPath, { port: server.port!, capability: newAcpCapability() });
  return {
    launchPath,
    stop() {
      server.stop(true);
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

/**
 * An ACP host: spawns `foundry-acp` the way Paseo and T3 do (a child process, ACP over its
 * stdio) and records every `session/update` it receives, per session, in arrival order.
 */
export function spawnFoundryAcp(launchPath: string) {
  const proc = Bun.spawn(['bun', CLI], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FOUNDRY_ACP_LAUNCH: launchPath },
  });
  let stderr = '';
  void (async () => {
    for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk);
  })();
  const toAgent = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      proc.stdin.end();
    },
  });
  const updates = new Map<string, SessionUpdate[]>();
  const permissions: Array<{ request: RequestPermissionRequest; signal: AbortSignal }> = [];
  let answer: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> = () =>
    new Promise(() => {});
  const connection: ClientConnection = client({ name: 'conformance-host' })
    .onRequest('session/request_permission', (ctx) => {
      permissions.push({ request: ctx.params, signal: ctx.signal });
      return answer(ctx.params);
    })
    .onNotification('session/update', (ctx) => {
      const notification = ctx.params as SessionNotification;
      const list = updates.get(notification.sessionId) ?? [];
      list.push(notification.update);
      updates.set(notification.sessionId, list);
    })
    .connect(ndJsonStream(toAgent, proc.stdout as ReadableStream<Uint8Array>));
  return {
    agent: connection.agent,
    /** Turn updates; the session's command list is under `all`. */
    updates: (sessionId: string) =>
      (updates.get(sessionId) ?? []).filter((u) => u.sessionUpdate !== 'available_commands_update'),
    all: (sessionId: string) => updates.get(sessionId) ?? [],
    permissions,
    /** How the host answers `session/request_permission` (default: never). */
    answerPermissions(fn: typeof answer) {
      answer = fn;
    },
    stderr: () => stderr,
    async close() {
      connection.close();
      proc.kill();
      await proc.exited;
    },
  };
}

export async function until(check: () => unknown, label: string, ms = 8_000) {
  const end = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > end) throw Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

/** The updates a host would render: the kind, plus the fields that identify each. */
export function shape(update: SessionUpdate) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return { chunk: update.content.type === 'text' ? update.content.text : update.content.type };
    case 'tool_call':
      return { call: update.toolCallId, kind: update.kind, status: update.status };
    case 'tool_call_update':
      return { update: update.toolCallId, status: update.status };
    default:
      return { other: update.sessionUpdate };
  }
}
