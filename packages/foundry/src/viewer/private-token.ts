import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export function privateTunnelToken(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid()))
    throw Error("Tunnel credential directory must be owned and private");
  chmodSync(directory, 0o700);
  const path = join(directory, "tunnel-token");
  let created = false;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw Error("Tunnel credential unavailable");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 || (process.getuid && stat.uid !== process.getuid()))
      throw Error("Tunnel credential must be an owned regular file");
    fchmodSync(fd, 0o600);
    if (created) writeSync(fd, randomBytes(32).toString("hex"), 0, "utf8");
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw Error("Tunnel credential is invalid");
    return token;
  } finally { closeSync(fd); }
}
