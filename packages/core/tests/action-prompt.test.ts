import { describe, test, expect } from "bun:test";
import { ActionQueue, type ActionPrompt, type ActionResolution } from "../src/action-prompt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueue(): ActionQueue {
  return new ActionQueue();
}

// ---------------------------------------------------------------------------
// ActionQueue
// ---------------------------------------------------------------------------

describe("ActionQueue", () => {
  // -- Prompt + resolve flow --

  test("prompt blocks until resolved", async () => {
    const q = makeQueue();
    let resolved = false;

    const promise = q.prompt({
      kind: "approval",
      message: "Delete the database?",
      agentId: "agent-1",
      threadId: "t1",
    }).then((r) => {
      resolved = true;
      return r;
    });

    // Not yet resolved
    await Bun.sleep(10);
    expect(resolved).toBe(false);
    expect(q.pendingCount()).toBe(1);

    // Resolve it
    const pending = q.pending();
    expect(pending).toHaveLength(1);
    q.resolve(pending[0].id, "approved");

    const result = await promise;
    expect(resolved).toBe(true);
    expect(result.action).toBe("approved");
    expect(result.by).toBe("human");
  });

  test("reject resolution", async () => {
    const q = makeQueue();

    const promise = q.prompt({
      kind: "approval",
      message: "Costly operation",
      agentId: "agent-1",
      threadId: "t1",
    });

    await Bun.sleep(5);
    const pending = q.pending();
    q.resolve(pending[0].id, "rejected");

    const result = await promise;
    expect(result.action).toBe("rejected");
  });

  test("choice prompt resolves with selected option", async () => {
    const q = makeQueue();

    const promise = q.prompt({
      kind: "choice",
      message: "Which approach?",
      agentId: "agent-1",
      threadId: "t1",
      options: [
        { id: "fast", label: "Fast but risky" },
        { id: "safe", label: "Safe but slow" },
        { id: "nuclear", label: "Delete everything", dangerous: true },
      ],
    });

    await Bun.sleep(5);
    const pending = q.pending();
    expect(pending[0].options).toHaveLength(3);

    q.resolve(pending[0].id, "safe");

    const result = await promise;
    expect(result.action).toBe("safe");

    // Prompt should be marked approved since a valid option was picked
    const prompt = q.get(pending[0].id);
    expect(prompt?.status).toBe("approved");
  });

  test("input prompt includes user text", async () => {
    const q = makeQueue();

    const promise = q.prompt({
      kind: "input",
      message: "Enter the API key",
      agentId: "agent-1",
      threadId: "t1",
    });

    await Bun.sleep(5);
    const pending = q.pending();
    q.resolve(pending[0].id, "approved", { input: "sk-secret-123" });

    const result = await promise;
    expect(result.action).toBe("approved");
    expect(result.input).toBe("sk-secret-123");
  });

  // -- Timeout --

  test("prompt expires after timeout", async () => {
    const q = makeQueue();

    const result = await q.prompt({
      kind: "approval",
      message: "Quick!",
      agentId: "agent-1",
      threadId: "t1",
      timeoutMs: 50,
    });

    expect(result.action).toBe("rejected");
    expect(result.by).toBe("timeout");

    const prompt = q.pending();
    expect(prompt).toHaveLength(0);
  });

  // -- Policy auto-resolve --

  test("policy auto-resolves before blocking", async () => {
    const q = makeQueue();

    q.addPolicy((prompt) => {
      if (prompt.capability === "file:read") {
        return { by: "policy", action: "approved", timestamp: Date.now() };
      }
      return null;
    });

    const result = await q.prompt({
      kind: "approval",
      message: "Read a file",
      agentId: "agent-1",
      threadId: "t1",
      capability: "file:read",
    });

    expect(result.action).toBe("approved");
    expect(result.by).toBe("policy");
    // Should not be in pending since it was auto-resolved
    expect(q.pendingCount()).toBe(0);
  });

  test("policy returns null lets prompt pend", async () => {
    const q = makeQueue();

    q.addPolicy(() => null);

    const promise = q.prompt({
      kind: "approval",
      message: "Need human",
      agentId: "agent-1",
      threadId: "t1",
    });

    await Bun.sleep(5);
    expect(q.pendingCount()).toBe(1);

    q.resolve(q.pending()[0].id, "approved");
    const result = await promise;
    expect(result.action).toBe("approved");
  });

  test("remove policy", async () => {
    const q = makeQueue();

    const remove = q.addPolicy(() => ({
      by: "policy" as const,
      action: "approved",
      timestamp: Date.now(),
    }));

    // With policy
    const r1 = await q.prompt({
      kind: "approval",
      message: "test",
      agentId: "a",
      threadId: "t",
    });
    expect(r1.by).toBe("policy");

    // Remove policy
    remove();

    // Now it should pend
    const promise = q.prompt({
      kind: "approval",
      message: "test2",
      agentId: "a",
      threadId: "t",
      timeoutMs: 50,
    });

    await Bun.sleep(5);
    expect(q.pendingCount()).toBe(1);

    const r2 = await promise; // will timeout
    expect(r2.by).toBe("timeout");
  });

  // -- Listeners --

  test("listener notified on new prompt", async () => {
    const q = makeQueue();
    const received: ActionPrompt[] = [];

    q.onPrompt((p) => received.push(p));

    const promise = q.prompt({
      kind: "approval",
      message: "hello",
      agentId: "a",
      threadId: "t",
      timeoutMs: 50,
    });

    await Bun.sleep(5);
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe("hello");

    await promise;
  });

  test("remove listener", async () => {
    const q = makeQueue();
    const received: ActionPrompt[] = [];

    const remove = q.onPrompt((p) => received.push(p));
    remove();

    const promise = q.prompt({
      kind: "approval",
      message: "should not notify",
      agentId: "a",
      threadId: "t",
      timeoutMs: 50,
    });

    await Bun.sleep(5);
    expect(received).toHaveLength(0);
    await promise;
  });

  test("listener errors do not block prompts", async () => {
    const q = makeQueue();

    q.onPrompt(() => { throw new Error("bad listener"); });

    const promise = q.prompt({
      kind: "approval",
      message: "still works",
      agentId: "a",
      threadId: "t",
      timeoutMs: 50,
    });

    await Bun.sleep(5);
    expect(q.pendingCount()).toBe(1);
    await promise;
  });

  // -- Queries --

  test("forThread returns prompts filtered by thread", async () => {
    const q = makeQueue();

    // Auto-resolve all
    q.addPolicy(() => ({ by: "policy" as const, action: "approved", timestamp: Date.now() }));

    await q.prompt({ kind: "approval", message: "a", agentId: "a", threadId: "t1" });
    await q.prompt({ kind: "approval", message: "b", agentId: "a", threadId: "t2" });
    await q.prompt({ kind: "approval", message: "c", agentId: "a", threadId: "t1" });

    expect(q.forThread("t1")).toHaveLength(2);
    expect(q.forThread("t2")).toHaveLength(1);
    expect(q.forThread("t3")).toHaveLength(0);
  });

  test("pendingCount filters by thread", async () => {
    const q = makeQueue();

    const p1 = q.prompt({ kind: "approval", message: "a", agentId: "a", threadId: "t1", timeoutMs: 500 });
    const p2 = q.prompt({ kind: "approval", message: "b", agentId: "a", threadId: "t2", timeoutMs: 500 });

    await Bun.sleep(5);
    expect(q.pendingCount()).toBe(2);
    expect(q.pendingCount("t1")).toBe(1);
    expect(q.pendingCount("t2")).toBe(1);

    q.resolve(q.pending()[0].id, "approved");
    expect(q.pendingCount()).toBe(1);

    q.resolve(q.pending()[0].id, "approved");
    await p1;
    await p2;
  });

  // -- Resolve edge cases --

  test("resolve returns false for unknown prompt", () => {
    const q = makeQueue();
    expect(q.resolve("nonexistent", "approved")).toBe(false);
  });

  test("resolve returns false for already-resolved prompt", async () => {
    const q = makeQueue();

    const promise = q.prompt({
      kind: "approval",
      message: "test",
      agentId: "a",
      threadId: "t",
    });

    await Bun.sleep(5);
    const id = q.pending()[0].id;
    expect(q.resolve(id, "approved")).toBe(true);
    expect(q.resolve(id, "rejected")).toBe(false); // already resolved

    await promise;
  });

  // -- Prune --

  test("prune removes old resolved prompts", async () => {
    const q = makeQueue();

    q.addPolicy(() => ({ by: "policy" as const, action: "approved", timestamp: Date.now() }));

    await q.prompt({ kind: "approval", message: "old", agentId: "a", threadId: "t" });
    await q.prompt({ kind: "approval", message: "old2", agentId: "a", threadId: "t" });

    // Wait a tick so timestamps are in the past
    await Bun.sleep(5);

    // Prune with 1ms age = remove prompts older than 1ms
    const pruned = q.prune(1);
    expect(pruned).toBe(2);
    expect(q.forThread("t")).toHaveLength(0);
  });

  // -- Urgency and meta --

  test("urgency defaults to normal", async () => {
    const q = makeQueue();
    q.addPolicy(() => ({ by: "policy" as const, action: "approved", timestamp: Date.now() }));

    await q.prompt({ kind: "approval", message: "test", agentId: "a", threadId: "t" });

    const prompts = q.forThread("t");
    expect(prompts[0].urgency).toBe("normal");
  });

  test("custom urgency and meta preserved", async () => {
    const q = makeQueue();
    q.addPolicy(() => ({ by: "policy" as const, action: "approved", timestamp: Date.now() }));

    await q.prompt({
      kind: "approval",
      message: "test",
      agentId: "a",
      threadId: "t",
      urgency: "critical",
      meta: { cost: 4.50, model: "claude-opus-4-20250514" },
    });

    const prompts = q.forThread("t");
    expect(prompts[0].urgency).toBe("critical");
    expect(prompts[0].meta?.cost).toBe(4.50);
  });
});
