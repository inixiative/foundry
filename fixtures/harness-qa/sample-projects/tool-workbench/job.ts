import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

export function parseRun(args: string[]) {
  if (args.length !== 3) throw new Error("Usage: bun job.ts run NEW_DIRECTORY STEPS INTERVAL_MS");
  const [directory, rawSteps, rawInterval] = args;
  if (!directory || !/^\d+$/.test(rawSteps!) || !/^\d+$/.test(rawInterval!)) throw new Error("Expected directory and integer bounds");
  const steps = Number(rawSteps), intervalMs = Number(rawInterval);
  if (steps < 1 || steps > 120 || intervalMs < 1 || intervalMs > 1000) throw new Error("Steps: 1-120; interval: 1-1000ms");
  return { directory: resolve(directory), steps, intervalMs };
}

export function runJob(options: ReturnType<typeof parseRun>) {
  // An exclusive output directory prevents a repeated command from erasing evidence.
  mkdirSync(options.directory);
  const runId = randomUUID();
  let sequence = 0, completedSteps = 0, finished = false;
  const emit = (kind: string, details: Record<string, unknown> = {}) => {
    const event = { runId, pid: process.pid, sequence: sequence++, kind, timestamp: Date.now(), ...details };
    const line = JSON.stringify(event) + "\n";
    appendFileSync(join(options.directory, "events.jsonl"), line);
    process.stdout.write(line);
  };
  const finish = (outcome: "completed" | "signal-observed", signal?: string) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    process.off("SIGTERM", term); process.off("SIGINT", interrupt);
    const result = { runId, pid: process.pid, outcome, completedSteps, requestedSteps: options.steps, signal: signal ?? null };
    writeFileSync(join(options.directory, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    writeFileSync(join(options.directory, "report.md"), `# Controlled Job\n\nRun: ${runId}\n\nOutcome: ${outcome}\n\nSteps: ${completedSteps}/${options.steps}\n`, { flag: "wx" });
    emit(outcome, { completedSteps, signal: signal ?? null });
    process.exitCode = signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 0;
  };
  const term = () => finish("signal-observed", "SIGTERM");
  const interrupt = () => finish("signal-observed", "SIGINT");
  const timer = setInterval(() => {
    completedSteps++;
    emit("step", { completedSteps });
    if (completedSteps === options.steps) finish("completed");
  }, options.intervalMs);
  process.on("SIGTERM", term); process.on("SIGINT", interrupt);
  emit("ready", { steps: options.steps, intervalMs: options.intervalMs });
}

if (import.meta.main) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === "fail" && args.length === 0) {
      console.error("CONTROLLED_TOOL_FAILURE: deliberate fixture exit, no work started");
      process.exitCode = 7;
    } else if (mode === "run") runJob(parseRun(args));
    else throw new Error("Usage: bun job.ts fail | run NEW_DIRECTORY STEPS INTERVAL_MS");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
