/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeAuthenticationSource } from './native-authentication';

export type NativeProfileSource = Extract<NativeAuthenticationSource, { mode: 'native-profile' }>;
type Runtime = NativeAuthenticationSource['runtime'];

/** Stable local identities for the user's own logins; references only, never account names. */
const DEFAULT_SOURCES: Record<Runtime, { id: string; integrationId: string; directory: string }> = {
  claude: {
    id: '5b0c1a0d-7d1e-4c1a-9e00-00000000c1a0',
    integrationId: '5b0c1a0d-7d1e-4c1a-9e00-00000000c1a1',
    directory: '.claude',
  },
  codex: {
    id: '5b0c1a0d-7d1e-4c1a-9e00-00000000c0d0',
    integrationId: '5b0c1a0d-7d1e-4c1a-9e00-00000000c0d1',
    directory: '.codex',
  },
};

/** HOME, as the claude and codex CLIs resolve it. */
export function defaultProfileDirectory(runtime: Runtime): string {
  return join(process.env.HOME || homedir(), DEFAULT_SOURCES[runtime].directory);
}

/** The runtime's standard login location, referenced in place. */
export function defaultProfileSource(runtime: Runtime): NativeProfileSource {
  const { id, integrationId } = DEFAULT_SOURCES[runtime];
  return {
    id,
    integrationId,
    runtime,
    mode: 'native-profile',
    profileDirectory: defaultProfileDirectory(runtime),
  };
}

export function isDefaultProfile(directory: string, runtime: Runtime): boolean {
  // A login not created yet is still the default location; selecting it explicitly changes Claude's credential entry.
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(directory) === real(defaultProfileDirectory(runtime));
}

/** Child environment selecting a profile. The default location is selected by omission:
 * setting CLAUDE_CONFIG_DIR, even to ~/.claude, makes Claude use a different credential entry. */
export function profileEnvironment(runtime: Runtime, directory: string): Record<string, string> {
  if (isDefaultProfile(directory, runtime)) return {};
  return { [runtime === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: directory };
}

/** Replace any inherited profile selection with the given profile's. */
export function withProfile(
  env: Record<string, string | undefined>,
  runtime: Runtime,
  directory: string,
): Record<string, string | undefined> {
  const { CLAUDE_CONFIG_DIR: _claude, CODEX_HOME: _codex, ...rest } = env;
  return { ...rest, ...profileEnvironment(runtime, directory) };
}
