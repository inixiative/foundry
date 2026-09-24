import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexTextProvider } from "../src/providers/codex-text-provider";
import { buildSubscriptionDecisions, type DecisionPressure, type SubscriptionDecisionConfig } from "../src/providers/subscription-decisions";
import { defaultProfileSource } from "../src/providers/default-profiles";
import { NativeAuthentication } from "../src/providers/native-authentication";
import { DECISION_PRIORITY } from "../src/providers/decision-priority";
import { codexTransport } from "./helpers/subscription-transport";

const roots: string[] = [];
const home = process.env.HOME;
afterEach(async () => {
  process.env.HOME = home;
  await Bun.sleep(10);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scheduler(transport: ReturnType<typeof codexTransport>, bounds: Partial<SubscriptionDecisionConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "subscription-scheduling-")); roots.push(root);
  mkdirSync(join(root, ".codex"), { mode: 0o700 }); process.env.HOME = root;
  const directory = join(root, "receipts"); mkdirSync(directory, { mode: 0o700 });
  const pressure: DecisionPressure[] = [];
  const decisions = buildSubscriptionDecisions({ directory, source: defaultProfileSource("codex"), model: "gpt-5.6-luna",
    maxCalls: 10_000, maxQueued: 256, maxQueuedPerThread: 32, maxConcurrent: 8, callTimeoutMs: 20_000,
    onPressure: event => pressure.push(event), ...bounds }, cfg => buildCodexTextProvider(cfg, transport));
  return { root, decisions, pressure };
}
/** Each answer echoes its prompt's label, so completion order is observable. */
const labelled = (delayMs: number) => codexTransport({ delayMs, response: prompt => prompt.match(/label:(\S+)/)?.[1] ?? "?" });
const ask = (decisions: ReturnType<typeof scheduler>["decisions"], label: string, thread: string, priority?: number) =>
  decisions.provider.complete([{ role: "user", content: `label:${label}` }], { threadId: `${thread}:aux:domain:x`, ...(priority === undefined ? {} : { priority }) })
    .then(result => result.content, (error: Error) => `rejected:${error.message}`);

test("decisions run concurrently up to the cap on one shared Codex login, and every holder is released", async () => {
  const transport = labelled(60);
  const { root, decisions } = scheduler(transport, { maxConcurrent: 3 });
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 7 }, (_, i) => ask(decisions, `d${i}`, `T${i}`)));
  expect(results).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6"]);
  expect(transport.peak).toBe(3);
  expect(Date.now() - started).toBeLessThan(7 * 60);
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(false);
  expect(decisions.snapshot()).toMatchObject({ closed: false, running: 0, queued: 0, attempts: 7 });
});

test("a blocked turn outranks guards, which outrank learning review", async () => {
  const order: string[] = [];
  const { decisions } = scheduler(labelled(30), { maxConcurrent: 1 });
  const first = ask(decisions, "running", "A").then(label => order.push(label));
  const queued = [
    ask(decisions, "review", "A", DECISION_PRIORITY.review).then(label => order.push(label)),
    ask(decisions, "guard", "B", DECISION_PRIORITY.guard).then(label => order.push(label)),
    ask(decisions, "turn", "C").then(label => order.push(label)),
  ];
  await Promise.all([first, ...queued]);
  expect(order).toEqual(["running", "turn", "guard", "review"]);
});

test("within a priority, a busy thread cannot starve another", async () => {
  const order: string[] = [];
  const { decisions } = scheduler(labelled(20), { maxConcurrent: 1 });
  const calls = [...Array.from({ length: 5 }, (_, i) => ask(decisions, `busy${i}`, "busy")), ask(decisions, "quiet", "quiet")];
  await Promise.all(calls.map(call => call.then(label => order.push(label))));
  expect(order.indexOf("quiet")).toBeLessThanOrEqual(2);
});

test("background classes leave capacity for turns", async () => {
  const transport = labelled(80);
  const { decisions } = scheduler(transport, { maxConcurrent: 4 });
  const guards = Array.from({ length: 6 }, (_, i) => ask(decisions, `g${i}`, `G${i}`, DECISION_PRIORITY.guard));
  await Bun.sleep(30);
  expect(decisions.snapshot().running).toBe(3);
  const turn = ask(decisions, "turn", "T");
  await Bun.sleep(30);
  expect(decisions.snapshot().running).toBe(4);
  expect(await turn).toBe("turn");
  await Promise.all(guards);
  expect(transport.peak).toBe(4);
});

test("full queues shed lower-priority waits instead of refusing a turn", async () => {
  const { decisions, pressure } = scheduler(labelled(60), { maxConcurrent: 1, maxQueued: 2, maxQueuedPerThread: 2 });
  const running = ask(decisions, "running", "A");
  const guards = [ask(decisions, "g1", "B", DECISION_PRIORITY.guard), ask(decisions, "g2", "C", DECISION_PRIORITY.guard)];
  const turn = ask(decisions, "turn", "D");
  expect(await guards[0]).toContain("shed under load");
  expect(pressure).toEqual([{ kind: "shed", threadId: "B", priority: DECISION_PRIORITY.guard, queued: 1 }]);
  const second = ask(decisions, "turn2", "E");
  expect(await ask(decisions, "refused", "F", DECISION_PRIORITY.review)).toContain("admission closed or full");
  // A second turn sheds the remaining guard too; with only turns queued, the review is refused.
  expect(await guards[1]).toContain("shed under load");
  expect([await running, await turn, await second]).toEqual(["running", "turn", "turn2"]);
  expect(decisions.snapshot()).toMatchObject({ closed: false, shed: 2 });
});

test("a rate limit backs off and signals, without closing admission or retrying", async () => {
  const limited = codexTransport({ failure: "You've hit your usage limit. Try again later." });
  const { decisions, pressure } = scheduler(limited, { rateLimitBackoffMs: 150 });
  expect(await ask(decisions, "one", "A")).toContain("rate limited; no fallback or retry");
  expect(limited.launches).toHaveLength(1);
  expect(pressure).toMatchObject([{ kind: "rate-limited", backoffMs: 150 }]);
  expect(decisions.snapshot()).toMatchObject({ closed: false });
  expect(decisions.snapshot().backoffUntil).toBeGreaterThan(Date.now());
  const started = Date.now();
  expect(await ask(decisions, "two", "A")).toContain("rate limited");
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  expect(limited.launches).toHaveLength(2);
  expect(pressure.at(-1)).toMatchObject({ kind: "rate-limited", backoffMs: 300 });
});

test("shared decision holders and an exclusive worker lock exclude each other on one profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "subscription-lock-")); roots.push(root);
  mkdirSync(join(root, ".codex"), { mode: 0o700 }); process.env.HOME = root;
  const source = defaultProfileSource("codex");
  const shared = new NativeAuthentication({ directory: join(root, "auth"), sources: [source], defaultSourceId: source.id, shared: true });
  const exclusive = new NativeAuthentication({ directory: join(root, "auth"), sources: [source], defaultSourceId: source.id });
  const a = await shared.prepare("a", "codex"), b = await shared.prepare("b", "codex");
  a.launch(["codex"], {}); b.launch(["codex"], {});
  const worker = await exclusive.prepare("worker", "codex");
  expect(() => worker.launch(["codex"], {})).toThrow("in use");
  a.release(); b.release();
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(false);
  const owned = await exclusive.prepare("worker", "codex");
  owned.launch(["codex"], {});
  const late = await shared.prepare("late", "codex");
  expect(() => late.launch(["codex"], {})).toThrow("in use");
  expect(existsSync(join(root, ".codex", ".foundry-auth-shared"))).toBe(true);
  owned.release();
});

/** 10 threads, each a turn (classifier, router, cartographer, 4 experts) then 3 tool calls
 * (3 guards each) and 2 background reviews, arriving together. */
async function load(bounds: Partial<SubscriptionDecisionConfig>) {
  const { decisions } = scheduler(codexTransport({ delayMs: 25 }), bounds);
  const turnWaits: number[] = [], results: string[] = [];
  let peakQueue = 0;
  const probe = setInterval(() => { peakQueue = Math.max(peakQueue, decisions.snapshot().queued); }, 2);
  const call = (thread: string, priority: number, track?: number[]) => {
    const started = Date.now();
    return decisions.provider.complete([{ role: "user", content: "x" }], { threadId: `${thread}:aux:domain:x`, priority })
      .then(() => { track?.push(Date.now() - started); results.push("ok"); }, (error: Error) => { results.push(error.message); });
  };
  await Promise.all(Array.from({ length: 10 }, async (_, t) => {
    const thread = `thread-${t}`;
    await Promise.all(Array.from({ length: 7 }, () => call(thread, DECISION_PRIORITY.turn, turnWaits)));
    await Promise.all([...Array.from({ length: 9 }, () => call(thread, DECISION_PRIORITY.guard)),
      ...Array.from({ length: 2 }, () => call(thread, DECISION_PRIORITY.review))]);
  }));
  clearInterval(probe);
  turnWaits.sort((a, b) => a - b);
  return { calls: results.length, rejected: results.filter(r => r !== "ok").length, peakQueue,
    turnP50: turnWaits[Math.floor(turnWaits.length / 2)] ?? 0, turnMax: turnWaits.at(-1) ?? 0 };
}

test("load: 10 threads with tool calls, before (serial, 8 queued) and after (defaults)", async () => {
  const before = await load({ maxConcurrent: 1, maxQueued: 8, maxQueuedPerThread: 8 });
  const serial = await load({ maxConcurrent: 1 });
  const after = await load({});
  console.log(JSON.stringify({ before, serialUnbounded: serial, after }));
  expect(before.rejected).toBeGreaterThan(100);
  expect(after).toMatchObject({ calls: 180, rejected: 0 });
  expect(after.turnMax * 3).toBeLessThan(serial.turnMax);
}, 30_000);
