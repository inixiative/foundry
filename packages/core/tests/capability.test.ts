import { describe, test, expect } from "bun:test";
import { ActionQueue } from "../src/action-prompt";
import {
  CapabilityGate,
  CapabilityDeniedError,
  UNATTENDED_POLICY,
  SUPERVISED_POLICY,
  RESTRICTED_POLICY,
  type PermissionPolicy,
} from "../src/capability";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGate(policy: PermissionPolicy): { gate: CapabilityGate; queue: ActionQueue } {
  const queue = new ActionQueue();
  const gate = new CapabilityGate(policy, queue);
  return { gate, queue };
}

const ctx = { agentId: "agent-1", threadId: "t1" };

// ---------------------------------------------------------------------------
// CapabilityGate
// ---------------------------------------------------------------------------

describe("CapabilityGate", () => {
  // -- UNATTENDED_POLICY --

  describe("UNATTENDED_POLICY", () => {
    test("allows everything", async () => {
      const { gate } = makeGate(UNATTENDED_POLICY);

      const r1 = await gate.check("file:write", ctx);
      expect(r1.action).toBe("approved");

      const r2 = await gate.check("exec:shell", ctx);
      expect(r2.action).toBe("approved");

      const r3 = await gate.check("data:delete", ctx);
      expect(r3.action).toBe("approved");
    });

    test("require does not throw", async () => {
      const { gate } = makeGate(UNATTENDED_POLICY);
      await expect(gate.require("exec:shell", ctx)).resolves.toBeUndefined();
    });
  });

  // -- SUPERVISED_POLICY --

  describe("SUPERVISED_POLICY", () => {
    test("allows reads without prompting", async () => {
      const { gate } = makeGate(SUPERVISED_POLICY);

      const r = await gate.check("file:read", ctx);
      expect(r.action).toBe("approved");
      expect(r.by).toBe("policy");
    });

    test("allows cheap llm calls", async () => {
      const { gate } = makeGate(SUPERVISED_POLICY);

      const r = await gate.check("llm:call", ctx);
      expect(r.action).toBe("approved");
    });

    test("prompts for writes", async () => {
      const { gate, queue } = makeGate(SUPERVISED_POLICY);

      const promise = gate.check("file:write", ctx);

      await Bun.sleep(5);
      expect(queue.pendingCount()).toBe(1);

      const pending = queue.pending();
      expect(pending[0].capability).toBe("file:write");
      queue.resolve(pending[0].id, "approved");

      const r = await promise;
      expect(r.action).toBe("approved");
      expect(r.by).toBe("human");
    });

    test("prompts for shell exec", async () => {
      const { gate, queue } = makeGate(SUPERVISED_POLICY);

      const promise = gate.check("exec:shell", ctx);

      await Bun.sleep(5);
      expect(queue.pendingCount()).toBe(1);

      const pending = queue.pending();
      expect(pending[0].urgency).toBe("high"); // shell is high urgency
      queue.resolve(pending[0].id, "rejected");

      const r = await promise;
      expect(r.action).toBe("rejected");
    });

    test("require throws on rejection", async () => {
      const { gate, queue } = makeGate(SUPERVISED_POLICY);

      const promise = gate.require("file:delete", ctx);

      await Bun.sleep(5);
      queue.resolve(queue.pending()[0].id, "rejected");

      await expect(promise).rejects.toThrow(CapabilityDeniedError);
    });
  });

  // -- RESTRICTED_POLICY --

  describe("RESTRICTED_POLICY", () => {
    test("denies dangerous ops immediately", async () => {
      const { gate } = makeGate(RESTRICTED_POLICY);

      const r1 = await gate.check("exec:shell", ctx);
      expect(r1.action).toBe("rejected");

      const r2 = await gate.check("file:delete", ctx);
      expect(r2.action).toBe("rejected");

      const r3 = await gate.check("data:delete", ctx);
      expect(r3.action).toBe("rejected");
    });

    test("allows reads", async () => {
      const { gate } = makeGate(RESTRICTED_POLICY);

      const r = await gate.check("file:read", ctx);
      expect(r.action).toBe("approved");
    });

    test("require throws for denied capability", async () => {
      const { gate } = makeGate(RESTRICTED_POLICY);

      await expect(gate.require("exec:shell", ctx)).rejects.toThrow(CapabilityDeniedError);
      await expect(gate.require("exec:shell", ctx)).rejects.toThrow("exec:shell");
    });
  });

  // -- Custom policies --

  describe("custom policy", () => {
    test("explicit capability overrides default", async () => {
      const { gate } = makeGate({
        defaults: "deny",
        capabilities: { "file:write": "allow" },
      });

      const r1 = await gate.check("file:write", ctx);
      expect(r1.action).toBe("approved");

      const r2 = await gate.check("file:read", ctx);
      expect(r2.action).toBe("rejected"); // default is deny
    });

    test("cost threshold triggers prompt for expensive calls", async () => {
      const { gate, queue } = makeGate({
        defaults: "allow",
        capabilities: {},
        costThreshold: 1.0,
      });

      // Cheap call — allowed
      const r1 = await gate.check("llm:call", {
        ...ctx,
        meta: { estimatedCost: 0.5 },
      });
      expect(r1.action).toBe("approved");

      // Expensive call — prompts
      const promise = gate.check("llm:call", {
        ...ctx,
        meta: { estimatedCost: 2.5 },
      });

      await Bun.sleep(5);
      expect(queue.pendingCount()).toBe(1);
      queue.resolve(queue.pending()[0].id, "approved");

      const r2 = await promise;
      expect(r2.action).toBe("approved");
    });

    test("protected paths trigger prompt", async () => {
      const { gate, queue } = makeGate({
        defaults: "allow",
        capabilities: {},
        protectedPaths: [".env", "credentials", "prisma/migrations"],
      });

      // Normal file — allowed
      const r1 = await gate.check("file:write", {
        ...ctx,
        meta: { path: "src/index.ts" },
      });
      expect(r1.action).toBe("approved");

      // Protected file — prompts
      const promise = gate.check("file:write", {
        ...ctx,
        meta: { path: ".env.local" },
      });

      await Bun.sleep(5);
      expect(queue.pendingCount()).toBe(1);
      queue.resolve(queue.pending()[0].id, "approved");

      const r2 = await promise;
      expect(r2.action).toBe("approved");
    });

    test("custom capability strings work", async () => {
      const { gate } = makeGate({
        defaults: "deny",
        capabilities: { "custom:deploy": "allow" },
      });

      const r = await gate.check("custom:deploy", ctx);
      expect(r.action).toBe("approved");
    });
  });

  // -- Runtime policy changes --

  test("setPolicy updates behavior", async () => {
    const { gate } = makeGate(UNATTENDED_POLICY);

    const r1 = await gate.check("exec:shell", ctx);
    expect(r1.action).toBe("approved");

    gate.setPolicy(RESTRICTED_POLICY);

    const r2 = await gate.check("exec:shell", ctx);
    expect(r2.action).toBe("rejected");
  });

  // -- levelFor (sync check) --

  test("levelFor returns permission level without prompting", () => {
    const { gate } = makeGate(SUPERVISED_POLICY);

    expect(gate.levelFor("file:read")).toBe("allow");
    expect(gate.levelFor("file:write")).toBe("prompt"); // default for supervised
    expect(gate.levelFor("llm:call")).toBe("allow");
  });

  // -- Prompt message --

  test("prompt includes agent and capability in message", async () => {
    const { gate, queue } = makeGate(SUPERVISED_POLICY);

    const promise = gate.check("file:write", {
      agentId: "writer-bot",
      threadId: "t1",
      detail: "writing to /tmp/output.json",
    });

    await Bun.sleep(5);
    const pending = queue.pending();
    expect(pending[0].message).toContain("writer-bot");
    expect(pending[0].message).toContain("file:write");
    expect(pending[0].message).toContain("/tmp/output.json");

    queue.resolve(pending[0].id, "approved");
    await promise;
  });

  // -- Urgency mapping --

  test("delete capabilities get high urgency", async () => {
    const { gate, queue } = makeGate(SUPERVISED_POLICY);

    const promise = gate.check("data:delete", ctx);
    await Bun.sleep(5);

    expect(queue.pending()[0].urgency).toBe("high");
    queue.resolve(queue.pending()[0].id, "approved");
    await promise;
  });
});
