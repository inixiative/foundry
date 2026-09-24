// The freshness policy, enforced by `bun run test`: a cassette is evidence about the live
// CLIs only while it is recent and was recorded on the CLI people actually run.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Fixture } from "./vcr";
import { findLeaks } from "./scrub";
import { cliVersion, compareVersions } from "./versions";

export type Policy = {
  /** Oldest recording `bun run test` accepts. The nightly refresh keeps every cassette well inside it. */
  maxAgeDays: number;
  /** Oldest CLI/package version a recording may come from; `test:live` raises these to what it recorded on. */
  blessed: Record<string, string>;
};

export type Finding = { cassette: string; problem: string };

export const policyPath = (fixturesDir: string) => join(fixturesDir, "policy.json");
export const readPolicy = (fixturesDir: string): Policy => JSON.parse(readFileSync(policyPath(fixturesDir), "utf8"));

export function cassettes(fixturesDir: string): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".json") && path !== policyPath(fixturesDir)) out.push(path);
    }
  };
  if (existsSync(fixturesDir)) walk(fixturesDir);
  return out.sort();
}

/** Installed versions of the stamped CLIs, where this machine has them (CI has none). */
export async function installedVersions(clis: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(clis.map(async cli => { try { out[cli] = await cliVersion(cli); } catch { /* Not installed here. */ } }));
  return out;
}

export function checkFreshness(fixturesDir: string, options: { now?: number; installed?: Record<string, string>; agentSession?: string } = {}): Finding[] {
  const policy = readPolicy(fixturesDir);
  const now = options.now ?? Date.now();
  const findings: Finding[] = [];
  for (const path of cassettes(fixturesDir)) {
    const cassette = relative(fixturesDir, path);
    const problem = (text: string) => findings.push({ cassette, problem: text });
    if (path.endsWith(".pending.json")) { problem("unreviewed live drift; review it, then `bun run vcr:accept` or fix the code"); continue; }
    const text = readFileSync(path, "utf8");
    for (const leak of findLeaks(text)) problem(`contains ${leak}`);
    let fixture: Fixture;
    try { fixture = JSON.parse(text); } catch { problem("is not JSON"); continue; }
    const recorded = fixture.recorded;
    if (!recorded?.recordedAt) { problem("has no recording stamp"); continue; }
    const ageDays = (now - Date.parse(recorded.recordedAt)) / 86_400_000;
    if (!(ageDays <= policy.maxAgeDays)) problem(`recorded ${Math.floor(ageDays)} days ago; the limit is ${policy.maxAgeDays}`);
    if (recorded.cli) {
      if (!fixture.version) problem(`has no ${recorded.cli} version`);
      else {
        const blessed = policy.blessed[recorded.cli];
        if (blessed && compareVersions(fixture.version, blessed) < 0) problem(`recorded on ${recorded.cli} ${fixture.version}; blessed is ${blessed}`);
        const installed = options.installed?.[recorded.cli];
        if (installed && compareVersions(fixture.version, installed) < 0) problem(`recorded on ${recorded.cli} ${fixture.version}; installed is ${installed}`);
      }
    }
    const blessedSession = policy.blessed["@inixiative/agent-session"];
    if (recorded.cli && recorded.agentSession) {
      if (blessedSession && compareVersions(recorded.agentSession, blessedSession) < 0) problem(`recorded through agent-session ${recorded.agentSession}; blessed is ${blessedSession}`);
      if (options.agentSession && compareVersions(recorded.agentSession, options.agentSession) < 0) problem(`recorded through agent-session ${recorded.agentSession}; installed is ${options.agentSession}`);
    }
  }
  return findings;
}
