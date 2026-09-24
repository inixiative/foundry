#!/usr/bin/env bun
// Runs inside the throwaway LaunchAgent. Reports what launchd gave it, then the live smoke.
import { writeFileSync } from "node:fs";
import { $ } from "bun";
import { SMOKE, repoRoot } from "./shared";

const reportPath = process.argv[2]!;
const which = async (command: string) => (await $`/usr/bin/which ${command}`.quiet().nothrow().text()).trim() || null;
const version = async (command: string) => {
  const started = Date.now();
  const run = await $`${command} --version`.quiet().nothrow();
  return { output: run.stdout.toString().trim().split("\n")[0] ?? "", exitCode: run.exitCode, ms: Date.now() - started };
};
const facts = {
  environmentKeys: Object.keys(process.env).sort(),
  terminal: !!process.env.TERM_PROGRAM || !!process.env.TERM,
  claude: { path: await which("claude"), version: await version("claude") },
  codex: { path: await which("codex"), version: await version("codex") },
  node: { path: await which("node") },
};

const child = Bun.spawn([process.execPath, "test", "--timeout", "120000", SMOKE.file, "-t", SMOKE.filter], {
  cwd: repoRoot, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
writeFileSync(reportPath, JSON.stringify({ exitCode, facts }, null, 2));
