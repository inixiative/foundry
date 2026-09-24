import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDefaultProfile } from "./default-profiles";

export function assertPrivateProfile(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid()))
    throw Error("Native profile must be an owned private directory (0700), not a symlink");
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
