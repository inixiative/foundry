import { fileURLToPath } from 'node:url';
import { type ArchiveClient, DEFAULT_URL } from '@inixiative/archive/remote';
import type { ArchiveSettings } from '@inixiative/archive/schemas';

/** What capture needs from this machine's Archive. */
export type ArchiveWriter = Pick<ArchiveClient, 'sourceId' | 'capture'>;
/** This machine's Archive client, or undefined until `archive up` has made a token. */
export type ArchiveConnector = () => ArchiveClient | undefined;

export interface ArchiveStatus {
  /** A local Archive token exists. */
  configured: boolean;
  /** The server answered an authenticated request. */
  reachable: boolean;
  url: string;
  /** Integrations the Archive references, read from its settings. */
  integrations?: ArchiveSettings['integrations'];
}

export const localArchiveUrl = () => process.env.ARCHIVE_URL ?? DEFAULT_URL;

export async function archiveStatus(client: ArchiveClient | undefined): Promise<ArchiveStatus> {
  const url = localArchiveUrl();
  if (!client) return { configured: false, reachable: false, url };
  try {
    const { integrations } = await client.settings();
    return { configured: true, reachable: true, url, integrations };
  } catch {
    return { configured: true, reachable: false, url };
  }
}

/**
 * Runs the Archive CLI in a subprocess. Foundry never imports it: it binds `@prisma/client`,
 * which would resolve Foundry's own generated client.
 */
export async function runArchiveCli(args: string[], stdio: 'inherit' | 'pipe' = 'inherit') {
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(import.meta.resolve('@inixiative/archive/cli')), ...args],
    { stdin: stdio === 'inherit' ? 'inherit' : 'ignore', stdout: stdio, stderr: stdio },
  );
  const [output, errors] = await Promise.all([
    child.stdout ? new Response(child.stdout).text() : '',
    child.stderr ? new Response(child.stderr).text() : '',
  ]);
  return { code: await child.exited, output, errors };
}

/** `archive up`: the machine's one local Archive in Docker Compose. */
export async function startLocalArchive() {
  const run = await runArchiveCli(['up'], 'pipe');
  if (run.code !== 0)
    throw Error(
      `archive up failed; check that Docker is running. ${run.errors.trim().split('\n').at(-1) ?? ''}`.trim(),
    );
}
