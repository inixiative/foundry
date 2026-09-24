import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

// Repeatable controlled M0 stage runner. No installs, native CLIs or live endpoints.
const root = resolve(import.meta.dir, "../../../..");
const phase = process.argv[2] ?? "scenario";
const base = join(root, ".foundry/qa", `m0-${phase}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
await mkdir(base, { recursive: true });
const own = ["packages/foundry/src/agents/thread-runtime.ts", "packages/foundry/src/agents/flow-orchestrator.ts", "packages/foundry/src/agents/domain-librarian.ts",
  "packages/foundry/tests/domain-middleware-loop.test.ts", "packages/foundry/tests/helpers/m0-domain-loop.ts", "packages/foundry/tests/helpers/m0-check.ts"];
const dependencies = ["packages/foundry/src/agents/thread-factory.ts", "packages/foundry/src/agents/librarian.ts", "packages/foundry/src/persistence/knowledge-persistence.ts",
  "packages/foundry/src/persistence/local-session-store.ts", "packages/foundry/src/viewer/routes/runtime.ts", "packages/foundry/src/viewer/server.ts", "packages/foundry/src/viewer/config.ts"];
async function hashes(files: string[]) { return Promise.all(files.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") }))); }
const before = { owned: await hashes(own), dependencies: await hashes(dependencies) };
const scenario = ["packages/foundry/tests/domain-middleware-loop.test.ts"];
const focused = [...scenario, ...["owned-learning", "domain-learning", "learning-capacity", "native-learning-settlement", "knowledge-recovery", "tool-correlation", "thread-runtime", "flow-orchestrator"].map(f => `packages/foundry/tests/${f}.test.ts`)];
const commands = phase === "types" ? [["bun", "node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "ESNext", "--moduleResolution", "bundler", "--types", "bun", ...scenario, "packages/foundry/tests/helpers/m0-domain-loop.ts", "packages/foundry/tests/helpers/m0-check.ts"], ["git", "diff", "--check"]]
  : phase === "scenario" ? [["bun", "test", ...scenario]] : phase === "focused" ? [["bun", "test", ...focused]] : undefined;
if (!commands) throw Error("Choose scenario, focused or types");
const checks = [];
for (const [index, argv] of commands.entries()) {
  const child = Bun.spawn(argv, { cwd: root, env: { ...process.env, FOUNDRY_M0_OUTPUT_DIR: base }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const log = `check-${index}.log`; await writeFile(join(base, log), stdout + stderr);
  checks.push({ argv, exitCode, log, pass: Number(stderr.match(/\n\s*(\d+) pass/)?.[1] ?? 0), fail: Number(stderr.match(/\n\s*(\d+) fail/)?.[1] ?? 0), assertions: Number(stderr.match(/\n\s*(\d+) expect\(\) calls/)?.[1] ?? 0) });
}
const after = { owned: await hashes(own), dependencies: await hashes(dependencies) };
const report = { phase, scope: "ROOT production components with controlled providers; no installed/native or browser acceptance", before, after,
  ownedStable: JSON.stringify(before.owned) === JSON.stringify(after.owned), dependenciesStable: JSON.stringify(before.dependencies) === JSON.stringify(after.dependencies), checks };
await writeFile(join(base, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: join(base, "report.json"), ...report, before: undefined, after: undefined }));
