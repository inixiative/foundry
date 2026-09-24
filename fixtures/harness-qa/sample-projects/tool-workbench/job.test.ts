import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRun } from "./job";

const cli = join(import.meta.dir, "job.ts");
test("bounds are explicit and malformed or extra arguments are refused", () => {
  expect(parseRun(["out", "2", "1"])).toMatchObject({ steps: 2, intervalMs: 1 });
  for (const args of [["out", "0", "1"], ["out", "121", "1"], ["out", "2", "1001"], ["out", "2.5", "1"], ["out", "2", "1", "extra"]]) {
    expect(() => parseRun(args)).toThrow();
  }
});

test("controlled tool failure returns its actual nonzero exit and creates no job", async () => {
  const child = Bun.spawn([process.execPath, cli, "fail"], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(7);
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toContain("CONTROLLED_TOOL_FAILURE");
});

test("completed job produces correlated ordered events and inspectable artifacts without overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundry-tool-sample-"));
  const output = join(root, "run");
  try {
    const child = Bun.spawn([process.execPath, cli, "run", output, "2", "1"], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const eventsText = await readFile(join(output, "events.jsonl"), "utf8");
    const events = eventsText.trim().split("\n").map(line => JSON.parse(line));
    const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
    expect(events.map(e => e.kind)).toEqual(["ready", "step", "step", "completed"]);
    expect(events.map(e => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(events.every(e => e.runId === result.runId && e.pid === child.pid)).toBe(true);
    expect(result).toMatchObject({ outcome: "completed", completedSteps: 2, requestedSteps: 2, signal: null });
    expect(await readFile(join(output, "report.md"), "utf8")).toContain(result.runId);
    const repeat = Bun.spawn([process.execPath, cli, "run", output, "2", "1"], { stdout: "pipe", stderr: "pipe" });
    expect(await repeat.exited).toBe(1);
    expect(await readFile(join(output, "events.jsonl"), "utf8")).toBe(eventsText);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owned SIGTERM observation is separate from native cancellation acknowledgment", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundry-tool-signal-"));
  const output = join(root, "run");
  const child = Bun.spawn([process.execPath, cli, "run", output, "120", "1000"], { stdout: "pipe", stderr: "pipe" });
  let exited = false;
  try {
    const reader = child.stdout.getReader();
    let received = "";
    while (!received.includes("\n")) {
      const part = await reader.read();
      if (part.done) throw Error("Child exited before ready");
      received += new TextDecoder().decode(part.value);
    }
    expect(JSON.parse(received.split("\n")[0]!).kind).toBe("ready");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143); exited = true;
    reader.releaseLock();
    const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
    expect(result).toMatchObject({ outcome: "signal-observed", signal: "SIGTERM", pid: child.pid });
    expect(result.completedSteps).toBeLessThan(result.requestedSteps);
    expect(result.nativeCancellationAcknowledged).toBeUndefined();
  } finally {
    if (!exited) { child.kill("SIGKILL"); await child.exited; }
    await rm(root, { recursive: true, force: true });
  }
});
