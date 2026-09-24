import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionQueue, ContextStack, EventStream, Executor, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { ProjectRegistry } from "../src/agents/project";
import { createViewer, startViewer } from "../src/viewer/server";
import { createWebSocketServer } from "../src/ws/handler";
import { getConnectionStats } from "../src/ws/lifecycle";
import { connectStreams } from "./helpers/data-stream";
import { StreamBufferRegistry } from "../src/viewer/stream-buffer";
// @ts-expect-error native browser module
import { applyTurnFrame } from "../src/viewer/ui/live-state.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** A viewer whose `main` executor streams "first " then waits for `release()` before "second". */
function fixture(options: { actionQueue?: ActionQueue; tunnelToken?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-data-streams-"));
  let release!: () => void;
  let hold = new Promise<void>(resolve => { release = resolve; });
  const main = new Thread("main", new ContextStack());
  main.register(new Executor({ id: "worker", stack: main.stack, handler: async (_context, payload, meta) => {
    meta?.onDelta?.("first ");
    await hold;
    meta?.onDelta?.("second");
    return `done:${payload}`;
  } }));
  const other = new Thread("other", new ContextStack());
  const projectThread = new Thread("in-project", new ContextStack(), { projectId: "P" });
  const projects = new ProjectRegistry();
  projects.register({ id: "P", label: "Project", path: dir, tags: [], runtime: "claude-code" });
  projects.get("P")!.addThread(projectThread);
  const harness = new Harness(main); harness.setDefaultExecutor("worker");
  const events = new EventStream();
  const viewer = createViewer({ harness, eventStream: events, interventions: new InterventionLog(main.signals), configDir: dir,
    localStore: null, projectRegistry: projects, actionQueue: options.actionQueue,
    ...(options.tunnelToken ? { tunnel: { port: 4400, token: options.tunnelToken, configDir: dir } } : {}) });
  viewer.directory.add(other);
  cleanup.push(async () => { release(); await viewer.analyticsReady.catch(() => {}); rmSync(dir, { force: true, recursive: true }); });
  const post = (path: string, body: unknown, method = "POST") => viewer.app.request(path, { method,
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = (id: string, clientId?: string | null, threadId = "main") => post("/api/messages/send", { id, threadId, message: id, clientId });
  return { viewer, events, main, other, projects, post, send,
    release: () => { release(); hold = new Promise<void>(resolve => { release = resolve; }); } };
}

const listeners = (events: EventStream) => (events as unknown as { _listeners: unknown[] })._listeners.length;

test("open answers opened then a snapshot, appends follow in order, and close ends delivery", async () => {
  const f = fixture();
  const client = connectStreams(f.viewer);
  await client.open("thread:main");
  expect(client.frames()).toEqual([
    { type: "connected", connectionId: client.socket.data.connectionId },
    { type: "opened", stream: "thread:main" },
    { category: "data", action: "snapshot", stream: "thread:main", payload: { threadId: "main", turns: [] } },
  ]);

  expect((await f.send("t1", client.socket.data.clientId)).status).toBe(202);
  await client.next(frame => frame.payload?.kind === "delta", "first delta");
  f.release();
  const terminal = await client.terminal("main", "t1");
  expect(terminal).toMatchObject({ type: "done", threadId: "main", output: "done:t1" });

  const appends = client.data("thread:main").filter(frame => frame.action === "append").map(frame => frame.payload);
  expect(appends[0]).toMatchObject({ kind: "turn", turn: { messageId: "t1", status: "accepted", content: "" } });
  expect(appends.filter(p => p.kind === "delta").map(p => p.text)).toEqual(["first ", "second"]);
  // The requester's full terminal arrives before the bounded turn's own terminal.
  const completed = appends.findIndex(p => p.kind === "turn" && p.turn.status === "completed");
  expect(appends.findIndex(p => p.kind === "done")).toBeGreaterThan(0);
  expect(completed).toBeGreaterThan(appends.findIndex(p => p.kind === "done"));
  expect(appends.find(p => p.kind === "turn" && p.turn.status === "completed").turn.content).toBe("done:t1");

  await client.close("thread:main");
  expect(client.frames().at(-1)).toEqual({ type: "closed", stream: "thread:main" });
  const before = client.frames().length;
  expect((await f.send("t2")).status).toBe(202);
  f.release();
  await Bun.sleep(20);
  expect(client.frames().length).toBe(before);
  expect(f.viewer.socket.streams.isOpen("thread:main")).toBe(false);
});

test("only the requesting connection receives the full result; watchers get the bounded turn", async () => {
  const f = fixture();
  const sender = connectStreams(f.viewer), watcher = connectStreams(f.viewer), bystander = connectStreams(f.viewer);
  await sender.open("thread:main"); await watcher.open("thread:main");
  // Naming a connection that does not hold the stream delivers nothing to it.
  expect((await f.send("private", bystander.socket.data.clientId)).status).toBe(202);
  f.release();
  await watcher.next(frame => frame.payload?.kind === "turn" && frame.payload.turn.status === "completed", "bounded terminal");
  expect(bystander.frames().some(frame => frame.category === "data")).toBe(false);
  expect((await f.send("owned", sender.socket.data.clientId)).status).toBe(202);
  f.release();
  const full = await sender.terminal("main", "owned");
  expect(full.meta.injection.userMessage).toBe("owned");
  await watcher.next(frame => frame.payload?.kind === "turn" && frame.payload.turn.messageId === "owned" && frame.payload.turn.status === "completed", "bounded terminal");
  expect(watcher.frames().some(frame => frame.payload?.kind === "done" || frame.payload?.kind === "error")).toBe(false);
  expect(JSON.stringify(watcher.frames())).not.toContain("injection");
});

test("opens are authorized: unknown streams, missing threads/projects and a failed admit are rejected", async () => {
  const f = fixture();
  const client = connectStreams(f.viewer);
  for (const stream of ["nope", "thread:missing", "events:missing", "threads:missing-project", "x".repeat(300)]) {
    await client.open(stream);
    expect(client.frames().at(-1)).toEqual({ type: "openRejected", stream });
  }
  expect(getConnectionStats(f.viewer.socket.registry)).toEqual({ connections: 1, streams: 0 });
  // Malformed frames are dropped without a reply; ping still answers.
  await f.viewer.websocket.message(client.socket, "not json");
  await f.viewer.websocket.message(client.socket, JSON.stringify({ action: "open" }));
  await f.viewer.websocket.message(client.socket, JSON.stringify({ action: "ping" }));
  expect(client.frames().at(-1)).toEqual({ type: "pong" });

  const denied = createWebSocketServer({ families: f.viewer.streams.families, admit: async () => false });
  const refused = connectStreams(denied);
  await refused.open("prompts");
  expect(refused.frames().at(-1)).toEqual({ type: "openRejected", stream: "prompts" });
  expect(getConnectionStats(denied.registry)).toEqual({ connections: 1, streams: 0 });
});

test("backpressure answers a dropped frame with an error so the client can retry the open", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = createWebSocketServer({ families: f.viewer.streams.families, admit: async () => { await gate; return true; } });
  const client = connectStreams(slow);
  const pending = Array.from({ length: 32 }, () => client.open("prompts"));
  await client.open("threads");
  expect(client.frames().at(-1)).toEqual({ type: "error", action: "open", stream: "threads" });
  release();
  await Promise.all(pending);
  expect(client.frames().filter(frame => frame.type === "opened")).toHaveLength(32);
});

test("a live turn's content keeps a 32 KiB tail on the server and in every viewer applying its frames", () => {
  const frames: any[] = [];
  const registry = new StreamBufferRegistry({ active: () => true,
    publish: (_threadId, payload) => frames.push({ category: "data", action: "append", stream: "thread:T", payload }) });
  const buffer = registry.open("M", "T");
  for (let i = 0; i < 40; i++) buffer.append(`${i}:`.padEnd(1024, "x"));
  const viewer = frames.reduce((turns: any, frame: any) => applyTurnFrame(turns, frame), new Map()).get("M");
  expect(buffer.snapshot().truncated).toBe(true);
  expect(viewer.content).toBe(buffer.snapshot().content);
  expect(viewer.truncated).toBe(true);
  expect(frames.filter(frame => frame.payload.kind === "turn")).toHaveLength(2); // accepted, then the first truncation
});

test("socket close closes every stream on it; a producer stops only when its last connection goes", async () => {
  const f = fixture({ actionQueue: new ActionQueue() });
  const baseline = listeners(f.events);
  const a = connectStreams(f.viewer), b = connectStreams(f.viewer);
  for (const stream of ["thread:main", "events:main", "threads", "prompts"]) await a.open(stream);
  await b.open("thread:main");
  expect(getConnectionStats(f.viewer.socket.registry)).toEqual({ connections: 2, streams: 4 });
  expect(listeners(f.events)).toBe(baseline + 3); // thread journal notices, events, thread list

  a.disconnect();
  expect(getConnectionStats(f.viewer.socket.registry)).toEqual({ connections: 1, streams: 1 });
  expect(listeners(f.events)).toBe(baseline + 1);
  expect(f.viewer.socket.streams.isOpen("thread:main")).toBe(true);
  expect((await f.send("shared", b.socket.data.clientId)).status).toBe(202);
  f.release();
  expect((await b.terminal("main", "shared")).type).toBe("done");
  expect(a.frames().some(frame => frame.payload?.turnId === "shared")).toBe(false);

  b.disconnect();
  expect(getConnectionStats(f.viewer.socket.registry)).toEqual({ connections: 0, streams: 0 });
  expect(listeners(f.events)).toBe(baseline);
});

test("re-opening after a reconnect yields a fresh snapshot of the turn so far, then its live appends", async () => {
  const f = fixture();
  const first = connectStreams(f.viewer);
  await first.open("thread:main");
  expect((await f.send("resume", first.socket.data.clientId)).status).toBe(202);
  await first.next(frame => frame.payload?.kind === "delta", "first delta");
  first.disconnect(); // dropped connection: nothing buffered for it, nothing replayed

  // The same tab reconnects: a new connection, the same client id.
  const again = connectStreams(f.viewer, first.socket.data.clientId);
  const otherTab = connectStreams(f.viewer);
  await otherTab.open("thread:main");
  await again.open("thread:main");
  const snapshot = again.data("thread:main")[0];
  expect(snapshot).toMatchObject({ action: "snapshot", payload: { turns: [{ messageId: "resume", status: "running", content: "first " }] } });
  f.release();
  // The full result follows the tab to its new connection; another tab sees only the bounded turn.
  expect((await again.terminal("main", "resume")).output).toBe("done:resume");
  await otherTab.next(frame => frame.payload?.kind === "turn" && frame.payload.turn.status === "completed", "bounded terminal");
  expect(otherTab.frames().some(frame => frame.payload?.kind === "done")).toBe(false);
  expect(first.frames().some(frame => frame.payload?.kind === "done")).toBe(false);
  expect(again.deltas("main", "resume")).toEqual(["second"]);

  // Re-opening a stream already open on this connection re-sends a fresh snapshot.
  await again.open("thread:main");
  expect(again.data("thread:main").at(-1)).toMatchObject({ action: "snapshot", payload: { turns: [{ messageId: "resume", status: "completed" }] } });
  expect(getConnectionStats(f.viewer.socket.registry)).toEqual({ connections: 2, streams: 1 });
});

test("thread list streams are scoped and send only real changes", async () => {
  const f = fixture();
  const global = connectStreams(f.viewer), project = connectStreams(f.viewer);
  await global.open("threads");
  await project.open("threads:P");
  expect(global.data("threads")[0].payload.threads.map((t: any) => t.threadId).sort()).toEqual(["main", "other"]);
  expect(project.data("threads:P")[0].payload).toMatchObject({ projectId: "P", threads: [{ threadId: "in-project" }] });

  expect((await f.post("/api/threads", { id: "created", description: "New work" })).status).toBe(201);
  expect(global.data("threads").at(-1).payload).toMatchObject({ thread: { threadId: "created", meta: { description: "New work" } } });
  const count = global.data("threads").length;
  expect((await f.post("/api/threads/created", { description: "Renamed" }, "PATCH")).status).toBe(200);
  expect(global.data("threads").at(-1).payload.thread.meta.description).toBe("Renamed");
  expect(global.data("threads")).toHaveLength(count + 1);
  expect((await f.post("/api/threads/created", { description: "Renamed" }, "PATCH")).status).toBe(200);
  expect(global.data("threads")).toHaveLength(count + 1);
  expect(project.data("threads:P")).toHaveLength(1);

  // Events naming a thread re-check only that thread; a status change is sent once.
  f.other.meta.status = "active";
  f.events.push({ kind: "journal", threadId: "other", turnId: null, timestamp: Date.now() });
  f.events.push({ kind: "journal", threadId: "other", turnId: null, timestamp: Date.now() });
  expect(global.data("threads").slice(count + 1).map(frame => frame.payload.thread.meta.status)).toEqual(["active"]);
});

test("prompts stream carries pending prompts and their settlement", async () => {
  const queue = new ActionQueue();
  const f = fixture({ actionQueue: queue });
  const client = connectStreams(f.viewer);
  await client.open("prompts");
  expect(client.data("prompts")[0].payload).toEqual({ prompts: [] });
  const answer = queue.prompt({ kind: "approval", message: "Proceed?", agentId: "worker", threadId: "main" });
  const pending = client.data("prompts").at(-1).payload.prompt;
  expect(pending).toMatchObject({ message: "Proceed?", status: "pending", threadId: "main" });
  expect((await f.post(`/api/prompts/${pending.id}/resolve`, { action: "approved" })).status).toBe(200);
  expect((await answer).action).toBe("approved");
  expect(client.data("prompts").at(-1).payload.prompt).toMatchObject({ id: pending.id, status: "approved" });
  const late = connectStreams(f.viewer);
  await late.open("prompts");
  expect(late.data("prompts")[0].payload).toEqual({ prompts: [] });
});

test("event streams are scoped to a thread, with runtime errors still delivered", async () => {
  const f = fixture();
  f.events.push({ kind: "journal", threadId: "main", turnId: "before", timestamp: 1 });
  f.events.push({ kind: "journal", threadId: "other", turnId: "before-other", timestamp: 2 });
  const scoped = connectStreams(f.viewer), runtime = connectStreams(f.viewer);
  await scoped.open("events:main");
  await runtime.open("events");
  expect(scoped.data("events:main")[0].payload.events.map((e: any) => e.turnId)).toEqual(["before"]);
  expect(runtime.data("events")[0].payload.events.map((e: any) => e.turnId)).toEqual(["before", "before-other"]);
  f.events.push({ kind: "journal", threadId: "other", turnId: "foreign", timestamp: 3 });
  f.events.push({ kind: "journal", threadId: "main", turnId: "owned", timestamp: 4 });
  f.events.pushError("harness", "runtime failure");
  const appended = (frames: any[]) => frames.filter(frame => frame.action === "append").map(frame => frame.payload.event.turnId ?? frame.payload.event.kind);
  expect(appended(scoped.data("events:main"))).toEqual(["owned", "error"]);
  expect(appended(runtime.data("events"))).toEqual(["foreign", "owned", "error"]);
  // The thread stream carries only the notices that change that thread's history.
  const thread = connectStreams(f.viewer);
  await thread.open("thread:main");
  f.events.push({ kind: "journal", threadId: "main", turnId: "journal", timestamp: 5 });
  f.events.push({ kind: "journal", threadId: "other", turnId: "not-mine", timestamp: 6 });
  f.events.push({ kind: "layer", threadId: "main", event: { type: "warm", layerId: "l", timestamp: 7 } as never });
  expect(thread.data("thread:main").filter(frame => frame.action === "append").map(frame => frame.payload.event.turnId)).toEqual(["journal"]);
});

test("the upgrade is authorized like HTTP: loopback, or the tunnel credential, and same origin", async () => {
  const local = fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: local.viewer.fetch, websocket: local.viewer.websocket });
  cleanup.push(() => { server.stop(true); });
  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("upgrade refused")); });
  ws.onmessage = event => frames.push(JSON.parse(String(event.data)));
  ws.send(JSON.stringify({ action: "open", stream: "thread:main" }));
  const deadline = performance.now() + 4000;
  while (!frames.some(frame => frame.action === "snapshot") && performance.now() < deadline) await Bun.sleep(5);
  expect(frames.map(frame => frame.type ?? frame.action)).toEqual(["connected", "opened", "snapshot"]);
  ws.close();

  const fakeServer = { upgrade: () => true } as never;
  expect((await local.viewer.fetch(new Request("http://evil.test/ws"), fakeServer))!.status).toBe(401);
  expect((await local.viewer.fetch(new Request("http://127.0.0.1/ws", { headers: { origin: "https://evil.test" } }), fakeServer))!.status).toBe(403);

  const token = "t".repeat(48);
  const tunneled = fixture({ tunnelToken: token });
  expect((await tunneled.viewer.fetch(new Request("http://127.0.0.1/ws"), fakeServer))!.status).toBe(401);
  expect((await tunneled.viewer.fetch(new Request("http://127.0.0.1/ws", { headers: { authorization: "Bearer wrong" } }), fakeServer))!.status).toBe(401);
  expect(await tunneled.viewer.fetch(new Request("http://127.0.0.1/ws", { headers: { authorization: `Bearer ${token}` } }), fakeServer)).toBeUndefined();
});

test("losing Kingdom authorization closes sockets on the next append or open and refuses upgrades", async () => {
  const root = await mkdtemp(join(tmpdir(), "kingdom-streams-"));
  let allowed = true;
  const kingdom = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (!allowed) return new Response("denied", { status: 401 });
    if (new URL(request.url).pathname === "/api/v1/access/pollRuntimeJob") return Response.json({ data: null });
    return Response.json({ data: { installationId: id, kastleId: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(Date.now() + 60000).toISOString() } });
  } });
  const id = crypto.randomUUID(), credentialFile = join(root, "runtime.json");
  await writeFile(credentialFile, JSON.stringify({ secret: `kastle_runtime_${"0".repeat(43)}` }), { mode: 0o600 });
  const thread = new Thread("kingdom-main", new ContextStack()), events = new EventStream();
  const viewer = await startViewer({ port: 0, configDir: root, analyticsDir: join(root, "analytics"), localStore: null,
    harness: new Harness(thread), eventStream: events, interventions: new InterventionLog(thread.signals),
    kingdomRuntime: { url: `http://127.0.0.1:${kingdom.port}`, installationId: id, credentialFile } });
  cleanup.push(async () => { viewer.server.stop(true); kingdom.stop(true); await rm(root, { recursive: true, force: true }); });
  const url = `ws://127.0.0.1:${viewer.server.port}/ws`;
  const until = async (check: () => boolean) => { const end = performance.now() + 4000; while (!check() && performance.now() < end) await Bun.sleep(5); };
  const connect = async () => {
    const ws = new WebSocket(url), frames: any[] = [];
    const state = { ws, frames, closed: null as { code: number; reason: string } | null };
    ws.onmessage = event => frames.push(JSON.parse(String(event.data)));
    ws.onclose = event => { state.closed = { code: event.code, reason: event.reason }; };
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("upgrade refused")); });
    return state;
  };

  // Append path: an event arriving after authorization is lost closes the socket instead of being delivered.
  const watcher = await connect();
  watcher.ws.send(JSON.stringify({ action: "open", stream: "events" }));
  await until(() => watcher.frames.some(frame => frame.type === "opened"));
  allowed = false;
  expect((await fetch(`http://127.0.0.1:${viewer.server.port}/api/threads`)).status).toBe(503);
  events.pushError("harness", "after revocation");
  await until(() => watcher.closed !== null);
  expect(watcher.closed).toEqual({ code: 1008, reason: "Kingdom runtime unavailable" });
  expect(watcher.frames.some(frame => frame.payload?.event?.message === "after revocation")).toBe(false);

  // Open path: an open that fails the Kingdom check closes the socket rather than rejecting one stream.
  allowed = true;
  const opener = await connect();
  allowed = false;
  opener.ws.send(JSON.stringify({ action: "open", stream: "prompts" }));
  await until(() => opener.closed !== null);
  expect(opener.closed).toEqual({ code: 1008, reason: "Kingdom runtime unavailable" });
  expect(opener.frames.some(frame => frame.type === "openRejected" || frame.type === "opened")).toBe(false);

  const refused = new WebSocket(url);
  const outcome = await new Promise<string>(resolve => { refused.onopen = () => resolve("open"); refused.onerror = () => resolve("refused"); });
  expect(outcome).toBe("refused");
});

