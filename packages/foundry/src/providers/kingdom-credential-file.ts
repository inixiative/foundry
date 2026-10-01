import { constants } from 'node:fs';
import { lstat, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { kingdomUrl } from './kingdom-client';
import { refreshSecretPattern, runSecretPattern, runtimeSecretPattern } from './kingdom-secrets';

export const installationCredentialSchema = z
  .object({ secret: z.string().regex(runtimeSecretPattern) })
  .strict();

export const runCredentialSchema = z
  .object({
    url: z.string().transform(kingdomUrl),
    bindingId: z.string().uuid(),
    refreshCredential: z.string().regex(refreshSecretPattern),
    expiresAt: z.string().datetime(),
    cachedToken: z
      .object({ secret: z.string().regex(runSecretPattern), expiresAt: z.string().datetime() })
      .optional(),
  })
  .strict();
export async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 65536 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error('Kingdom credential file must be an owned private regular file (0600)');
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const parent = await lstat(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw Error('Kingdom credential directory must be owned and private (0700)');
  const temporary = join(dirname(path), `.credential-${crypto.randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
