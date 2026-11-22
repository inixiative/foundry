/**
 * @atlas
 * @kind helper
 * @partOf primitive:vcr
 */
// Foundry version probes delegating to @inixiative/vcr/freshness with FOUNDRY_VCR_PATH and
// MUSE_NO_AUTO_UPDATE=1 so probes resolve on the daemon PATH and never trigger self-updates.
import {
  compareVersions,
  fetchCliVersion,
  fetchHttpVersion,
  type HttpVersionOptions,
} from '@inixiative/vcr/freshness';

export { compareVersions };

type CliVersionOptions = {
  command?: string;
  regex?: RegExp;
};

/** Resolved on the PATH the live run uses (`FOUNDRY_VCR_PATH`), which is the daemon's resolution. */
export const cliVersion = (cmd: string, opts: CliVersionOptions = {}): Promise<string> => {
  const args = (opts.command ?? '--version').trim().split(/\s+/).filter(Boolean);
  return fetchCliVersion(cmd, {
    args,
    regex: opts.regex,
    pathEnv: process.env.FOUNDRY_VCR_PATH,
    // Muse and Antigravity launchers update themselves on a run unless told not to; a probe never moves a CLI.
    env: { MUSE_NO_AUTO_UPDATE: '1', AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
  });
};

export const fetchVersion = (url: string, opts: HttpVersionOptions = {}): Promise<string> =>
  fetchHttpVersion(url, opts);
