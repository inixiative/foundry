import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDefaultProfile } from "./default-profiles";

function assertPrivateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Native profile must be an owned private directory (0700), not a symlink");
}

export function assertPrivateProfile(directory: string): void {
  assertPrivateDirectory(directory);
  for (const name of ["auth.json", ".credentials.json", "config.toml", "settings.json"]) {
    try {
      const file = lstatSync(join(directory, name));
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0
        || (process.getuid && file.uid !== process.getuid()))
        throw Error("Native profile files must be owned private regular files (0600)");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** The user's own ~/.claude or ~/.codex, shared with their interactive sessions. Foundry does not
 * own its mode; it requires an owned real directory whose credential files are private. */
export function assertUserProfile(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Default native profile must be an owned directory, not a symlink");
  for (const name of ["auth.json", ".credentials.json"]) {
    try {
      const file = lstatSync(join(directory, name));
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0
        || (process.getuid && file.uid !== process.getuid()))
        throw Error("Native credential files must be owned private regular files (0600)");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Default login locations are referenced in place; every other profile must be Foundry-private. */
export function assertProfile(directory: string, runtime: "claude" | "codex"): void {
  if (isDefaultProfile(directory, runtime)) assertUserProfile(directory);
  else assertPrivateProfile(directory);
}

export function writeProfileConfiguration(directory: string, path: string, content: string): void {
  assertPrivateProfile(directory);
  writeAtomically(directory, path, content);
}

/** A Foundry-owned CODEX_HOME holding Foundry's config and the profile's `auth.json` by link, never by copy:
 * Codex rewrites auth.json in place, so a token refresh lands in the profile and every holder of the login sees it.
 * A copy would fork the login's single-use refresh token. Nothing else from the profile is reachable. */
export function writeCredentialHome(home: string, profile: string, config: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(home);
  writeAtomically(home, join(home, "config.toml"), config);
  const link = join(home, "auth.json"), target = join(profile, "auth.json");
  try { if (readlinkSync(link) === target) return; } catch { /* Missing, or not a link: replaced below. */ }
  const temporary = join(home, `.auth-${crypto.randomUUID()}`);
  symlinkSync(target, temporary);
  try { renameSync(temporary, link); } catch (error) { unlinkSync(temporary); throw error; }
}

function writeAtomically(directory: string, path: string, content: string): void {
  const temporary = join(directory, `.config-${crypto.randomUUID()}`);
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
