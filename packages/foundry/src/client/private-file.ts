import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

const MAX_PRIVATE_BYTES = 65_536;

/**
 * Read a private JSON object without following symlinks: a regular file, mode 0600 or tighter,
 * at most 64 KiB. Errors name `label` and never include the file's contents.
 */
export function readPrivateJson(path: string, label: string): Record<string, unknown> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP') throw new Error(`${label} is a symlink; refusing to follow it`);
    throw new Error(`${label} cannot be opened (${code ?? 'unknown error'})`);
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if ((stat.mode & 0o077) !== 0)
      throw new Error(`${label} mode must be 0600; group/other bits are set`);
    if (stat.size > MAX_PRIVATE_BYTES) throw new Error(`${label} is too large`);
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    text = buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

/**
 * Replace a private JSON file atomically: a fresh 0600 file beside it (never through a symlink),
 * renamed over the old one. The directory is created 0700 when missing.
 */
export function writePrivateJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, JSON.stringify(value));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
