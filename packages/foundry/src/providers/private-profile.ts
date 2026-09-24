import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
