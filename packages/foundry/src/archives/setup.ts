import { localArchive } from '@inixiative/archive/remote';
import type { SetupPrompts } from '../setup/prompts';
import {
  type ArchiveConnector,
  type ArchiveStatus,
  archiveStatus,
  startLocalArchive,
} from './local';

export interface ArchiveSetupOptions {
  /** Omitted: non-interactive; the local Archive is started without asking. */
  prompts?: SetupPrompts;
  connect?: ArchiveConnector;
  up?: () => Promise<void>;
  log?: (line: string) => void;
}

export type ArchiveSetupResult = ArchiveStatus & { started: boolean; error?: string };

/** Setting up an Archive: this machine's one local Archive (`archive up`), running and reachable. */
export async function runArchiveSetup(
  options: ArchiveSetupOptions = {},
): Promise<ArchiveSetupResult> {
  const {
    prompts,
    connect = () => localArchive(),
    up = startLocalArchive,
    log = console.error,
  } = options;
  const hosted = () =>
    log(
      'Hosted Archives connect through Kingdom; the local Archive publishes to them. Foundry writes only to the local Archive.',
    );
  const before = await archiveStatus(connect());
  if (before.reachable) {
    log(`The local Archive is running at ${before.url}.`);
    hosted();
    return { ...before, started: false };
  }
  log(
    before.configured
      ? `The local Archive at ${before.url} is not answering.`
      : 'No local Archive is set up on this machine.',
  );
  if (prompts && !(await prompts.confirm('Start the local Archive now (Docker Compose)?', true)))
    return { ...before, started: false };
  log('Starting the local Archive (archive up)…');
  try {
    await up();
  } catch (error) {
    const message = (error as Error).message;
    log(message);
    return { ...(await archiveStatus(connect())), started: false, error: message };
  }
  const after = await archiveStatus(connect());
  log(
    after.reachable
      ? `The local Archive is running at ${after.url}.`
      : `The local Archive started but does not answer at ${after.url}.`,
  );
  if (after.reachable) hosted();
  return { ...after, started: true };
}
