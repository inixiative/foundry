import { expect, test } from "bun:test";

// Immutable real captures; offline assertions make no model calls. These tasks
// were independent, so this is continuation evidence, not a retention benchmark.
const root = new URL("../../../../agent-session/fixtures/s0/s1-continuation-20260907T041000Z/", import.meta.url);
const hashes = {
  claude: "36932ab6a4642d033f8475911cad6421faf653dae2d7a350d5afffe81fc08ed2",
  "codex-mcp": "5f6d23a1ff1234e1fb0b31f2dd77ad530c8093da38e2ae350dd1f1fcec10ded7",
};

for (const engine of ["claude", "codex-mcp"] as const) {
  test(`real ${engine} capture has two correlated native completions in one owned process`, async () => {
    const file = Bun.file(new URL(`${engine}-continuation/recording.json`, root));
    expect(new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex")).toBe(hashes[engine]);
    const r = await file.json();
    const c = r.capture;
    expect(r.evidenceSource).toBe("native-cli");
    expect(r.package.source).toBe("sibling checkout, not installed in Foundry");
    expect(c.spawnCount).toBe(1);
    expect(c.admittedSends).toBe(2);
    expect(c.observedTurnWrites).toBe(2);
    expect(c.turns).toHaveLength(2);
    expect(c.processExited).toBe(true);
    expect(c.observerErrors).toEqual([]);
    expect(c.diagnostics.observerFailures).toEqual({ synchronous: 0, asynchronous: 0 });
    expect(r.after).toEqual(r.before);
    expect(r.after.unchanged).toBe(true);
    const admissionIds = c.turns.map((t: any) => t.attempt.admissionId);
    expect(new Set(admissionIds).size).toBe(2);
    const bindings = c.turns.map((t: any) => t.attempt.threadId ?? t.attempt.nativeSessionId);
    expect(bindings[0]).toMatch(/^ref-/);
    expect(bindings[1]).toBe(bindings[0]);
    if (engine === "codex-mcp") expect(c.turns[0].attempt.turnId).not.toBe(c.turns[1].attempt.turnId);
    const wire = c.stdout.frames.map((f: any) => ({ index: f.index, message: f.value?.params?.msg ?? f.value }));
    for (const [i, turn] of c.turns.entries()) {
      expect(turn.localSend).toBe("resolved");
      expect(turn.nativeWait).toBe("known");
      expect(turn.attempt.nativeOutcome).toBe("completed");
      const events = c.normalized.filter((e: any) => e.admissionId === turn.attempt.admissionId);
      const results = events.filter((e: any) => e.kind === "result");
      expect(results).toHaveLength(1);
      expect(results[0].nativeOutcome).toBe("completed");
      const terminal = results[0].raw;
      expect(terminal.type).toBe(engine === "claude" ? "result" : "task_complete");
      const matching = wire.filter((f: any) => f.index >= turn.firstFrame && f.index < turn.endFrameExclusive
        && f.message?.type === terminal.type
        && (engine === "claude" ? f.message.uuid === turn.attempt.terminal.eventId : f.message.turn_id === turn.attempt.turnId));
      expect(matching).toHaveLength(1);
      const starts = events.filter((e: any) => e.kind === "tool_use");
      const outputs = events.filter((e: any) => e.kind === "tool_result");
      expect(starts).toHaveLength(1);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].callId).toBe(starts[0].callId);
      expect(outputs[0].toolOutput).toContain("1.3.14");
      expect(outputs[0].toolOutput).toContain(i === 0 ? "S1_FIRST_SENTINEL_29" : "S1_SECOND_SENTINEL_83");
      expect(turn.attempt.content).toContain(i === 0 ? "S1_FIRST_DONE" : "S1_SECOND_DONE");
    }
    const configs = wire.filter((f: any) => f.message?.type === "session_configured"
      || (f.message?.type === "system" && f.message?.subtype === "init"));
    expect(configs.length).toBeGreaterThan(0);
    expect(configs.some((f: any) => f.message.model === (engine === "claude" ? "claude-fable-5-1" : "gpt-6-astra"))).toBe(true);
    expect(c.accountIdentity).toBe("unknown");
    expect(c.subscriptionContinuity).toBe("unknown");
  });
}
