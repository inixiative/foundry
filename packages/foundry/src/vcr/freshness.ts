/**
 * @atlas
 * @kind service
 * @partOf primitive:vcr
 */
// Foundry's freshness policy wrapper over @inixiative/vcr/freshness: binds Foundry's scrubber,
// daemon PATH / MUSE_NO_AUTO_UPDATE version probes, and legacy top-level `recorded.agentSession`
// checks on existing committed cassettes.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  acceptPendingCassettes,
  blessFreshnessPolicy,
  checkCassetteFreshness,
  compareVersions,
  diffCassetteDrift,
  diffVolatileCassetteNotices,
  discardPendingCassettes,
  type FreshnessPolicy,
  fetchCassettePaths,
  fetchFreshnessPolicy,
  fetchInstalledVersions,
  fetchPendingCassettes,
  PENDING_CASSETTE_SUFFIX,
  policyPathForDirectory,
} from '@inixiative/vcr/freshness';
import { findLeaks, foundryScrubber } from './scrub';
import type { Fixture } from './vcr';

export {
  acceptPendingCassettes,
  blessFreshnessPolicy,
  diffCassetteDrift,
  diffVolatileCassetteNotices,
  discardPendingCassettes,
  fetchCassettePaths,
  fetchPendingCassettes,
  PENDING_CASSETTE_SUFFIX,
};

export type Policy = FreshnessPolicy;
export type Finding = { cassette: string; problem: string };

export const policyPath = policyPathForDirectory;
export const readPolicy = fetchFreshnessPolicy;

export const cassettes = (fixturesDir: string): string[] =>
  fetchCassettePaths(fixturesDir, { includePending: true });

/** Installed versions of the stamped CLIs, where this machine has them (CI has none). */
export const installedVersions = (clis: readonly string[]): Promise<Record<string, string>> =>
  fetchInstalledVersions(clis, {
    pathEnv: process.env.FOUNDRY_VCR_PATH,
    env: { MUSE_NO_AUTO_UPDATE: '1', AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
  });

const AGENT_SESSION_PKG = '@inixiative/agent-session';

export function checkFreshness(
  fixturesDir: string,
  options: { now?: number; installed?: Record<string, string>; agentSession?: string } = {},
): Finding[] {
  const policy = readPolicy(fixturesDir);
  const rawFindings = checkCassetteFreshness(fixturesDir, {
    now: options.now,
    policy,
    installed: options.installed,
    packageVersions: options.agentSession
      ? { [AGENT_SESSION_PKG]: options.agentSession }
      : undefined,
    scrubber: foundryScrubber,
  });

  const findings: Finding[] = [];
  const leakReported = new Set<string>();

  for (const finding of rawFindings) {
    if (finding.code === 'unscrubbed_secret') {
      // Only runs on the leak error path (0 extra reads on clean runs) to preserve Foundry's
      // deduplicated `contains <leak>` labels since FreshnessFinding omits LeakFinding.kind.
      if (leakReported.has(finding.cassette)) continue;
      leakReported.add(finding.cassette);
      const raw = readFileSync(join(fixturesDir, finding.cassette), 'utf8');
      for (const leak of findLeaks(raw)) {
        findings.push({ cassette: finding.cassette, problem: `contains ${leak}` });
      }
      continue;
    }
    const problem = finding.problem.replace(
      `recorded with ${AGENT_SESSION_PKG} `,
      'recorded through agent-session ',
    );
    findings.push({ cassette: finding.cassette, problem });
  }

  // Existing committed cassettes stamped top-level `recorded.agentSession` before adopting
  // `recorded.metadata['@inixiative/agent-session']`. Check them with the same validation and
  // version policy without double-reporting cassettes that carry metadata.
  const blessedSession = policy.blessed[AGENT_SESSION_PKG];
  for (const path of fetchCassettePaths(fixturesDir, { includePending: false })) {
    let fixture: Fixture;
    try {
      fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
    } catch {
      continue;
    }
    const recorded = fixture.recorded;
    if (
      typeof fixture.status !== 'number' ||
      !Number.isFinite(fixture.status) ||
      !recorded?.recordedAt ||
      !recorded.cli ||
      !recorded.agentSession ||
      recorded.metadata?.[AGENT_SESSION_PKG] !== undefined
    ) {
      continue;
    }
    const cassette = relative(fixturesDir, path);
    if (blessedSession && compareVersions(recorded.agentSession, blessedSession) < 0) {
      findings.push({
        cassette,
        problem: `recorded through agent-session ${recorded.agentSession}; blessed is ${blessedSession}`,
      });
    }
    if (options.agentSession && compareVersions(recorded.agentSession, options.agentSession) < 0) {
      findings.push({
        cassette,
        problem: `recorded through agent-session ${recorded.agentSession}; installed is ${options.agentSession}`,
      });
    }
  }

  return findings;
}
