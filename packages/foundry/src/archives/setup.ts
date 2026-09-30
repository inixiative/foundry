import { join } from 'node:path';
import { FoundryCredentials } from '../providers/credentials';
import { defaultKingdomUrl, defaultRuntimeName, kingdomStatus, pairKingdom, type KingdomRuntimeStatus } from '../providers/kingdom-cli';
import { kingdomUrl } from '../providers/kingdom-client';
import { selectKingdomRuntime } from '../providers/kingdom-runtime-connection';
import { viewerRunning } from '../providers/kingdom-pairing';
import type { SetupPrompts } from '../setup/prompts';
import { ConfigStore } from '../viewer/config';
import { destinationUrl, readDestinations } from './config';
import { listKingdomConnections, saveArchiveConnection } from './publish';

export interface ArchiveSetupOptions {
  configDir: string;
  /** Defaults to `<configDir>/archives.json`. */
  archivesPath?: string;
  /** Omitted: non-interactive; flags decide. */
  prompts?: SetupPrompts;
  /** Paired Kingdom (id or API origin) whose destinations to set up; required when several are paired. */
  kingdom?: string;
  /** Pair with this Kingdom when no paired Kingdom is at this address. */
  kingdomUrl?: string;
  name?: string;
  /** Defaults to every registered project. */
  projects?: string[];
  /** Kingdom connection ID, or `kingdom` for Kingdom-stored archives. */
  connection?: string;
  /** Direct Archive server for projects no Kingdom connection carries. */
  archiveUrl?: string;
  /** Environment variable holding the direct Archive token; saved as a managed credential. */
  archiveTokenEnv?: string;
  open?: boolean;
  transport?: typeof fetch;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface KingdomConnection {
  id: string;
  name?: string;
  projectId?: string | null;
}
type Choice = { kind: 'kingdom'; connectionId?: string } | { kind: 'archive'; url: string; secret: string };
export type ProjectSetupResult = {
  projectId: string;
  status: 'configured' | 'connected' | 'skipped' | 'failed';
  reason?: string;
};

/** Guided path from nothing to a paired Kingdom and a verified destination per registered project on it. */
export async function runArchiveSetup(options: ArchiveSetupOptions) {
  const { configDir, prompts, transport = fetch, log = console.error } = options;
  const archivesPath = options.archivesPath ?? join(configDir, 'archives.json');
  const paired = await kingdomStatus(configDir, transport);
  let kingdom: { status: string; id?: string; url?: string; owner?: string; installationId?: string } =
    await chooseKingdom(options, paired.runtimes);
  let written = false;

  if (kingdom.status !== 'connected') {
    log(
      kingdom.status === 'unavailable'
        ? `Kingdom runtime at ${kingdom.url} is unavailable (revoked, expired or unreachable).`
        : paired.runtimes.length
          ? `No paired Kingdom is at ${options.kingdomUrl}.`
          : 'This Foundry is not paired with Kingdom.',
    );
    let url = options.kingdomUrl;
    if (prompts && (await prompts.confirm(kingdom.status === 'unavailable' ? 'Pair again?' : 'Pair with Kingdom now?', true)))
      url = kingdom.url ?? (await prompts.ask('Kingdom API address', url ?? defaultKingdomUrl()));
    else if (prompts) url = undefined;
    if (url) {
      const name = options.name ?? (prompts ? await prompts.ask('Foundry name', defaultRuntimeName()) : undefined);
      kingdom = await pairKingdom({
        configDir,
        url,
        name,
        open: options.open,
        ...(kingdom.id ? { replace: true, kingdom: kingdom.id } : {}),
        transport,
        log,
        sleep: options.sleep,
      });
      written = true;
    }
  }

  const config = await new ConfigStore(configDir).load();
  const destinations = readDestinations(archivesPath);
  const targets = options.projects?.length ? options.projects : Object.keys(config.projects);
  if (!targets.length) log('No registered projects yet. Start Foundry in a project, then run bun run archive setup.');
  const credentials = new FoundryCredentials(
    configDir,
    async () => (await new ConfigStore(configDir).load()).kingdomRuntimes,
  );
  const runtime = kingdom.status === 'connected' ? { id: kingdom.id!, url: kingdom.url!, owner: kingdom.owner! } : undefined;
  let listed: KingdomConnection[] | undefined;
  if (runtime) {
    try {
      const result = await listKingdomConnections(credentials, runtime.id, transport);
      listed = Array.isArray(result.connections)
        ? result.connections.filter((c: unknown): c is KingdomConnection => typeof (c as KingdomConnection)?.id === 'string')
        : [];
    } catch {
      log('Kingdom archive connections are unavailable; only direct Archive servers can be connected now.');
    }
  }
  // Destinations are per paired Kingdom: one on another Kingdom leaves this one to set up.
  const configured = (projectId: string) =>
    destinations.some(
      (d) =>
        d.projectId === projectId &&
        (!runtime ||
          d.kind === 'archive' ||
          (d.credential?.type === 'kingdom-runtime'
            ? d.credential.owner === runtime.owner && destinationUrl(d.url).origin === runtime.url
            : destinationUrl(d.url).origin === runtime.url)),
    );

  const projects: ProjectSetupResult[] = [];
  for (const projectId of targets) {
    const project = config.projects[projectId];
    const label = project?.label ?? project?.path ?? projectId;
    if (configured(projectId)) {
      projects.push({ projectId, status: 'configured' });
      continue;
    }
    const matches = listed?.filter((c) => c.projectId === projectId) ?? [];
    let choice: Choice | string;
    try {
      choice = prompts
        ? await promptChoice(prompts, label, projectId, matches, !!listed)
        : chooseFromFlags(options, matches, !!listed);
    } catch (error) {
      projects.push({ projectId, status: 'failed', reason: (error as Error).message });
      continue;
    }
    if (typeof choice === 'string') {
      projects.push({ projectId, status: 'skipped', reason: choice });
      continue;
    }
    try {
      await saveArchiveConnection(
        archivesPath,
        choice.kind === 'kingdom'
          ? {
              kind: 'kingdom',
              url: runtime!.url,
              projectId,
              ...(choice.connectionId ? { connectionId: choice.connectionId } : {}),
              credential: { type: 'kingdom-runtime', owner: runtime!.owner },
            }
          : { kind: 'archive', url: choice.url, projectId, secret: choice.secret },
        credentials,
        transport,
      );
      written = true;
      projects.push({ projectId, status: 'connected' });
      log(`Connected ${label}.`);
    } catch {
      projects.push({ projectId, status: 'failed', reason: 'Verification failed; nothing was saved. Check the destination and its credential.' });
      log(`Could not connect ${label}; verification failed and nothing was saved.`);
    }
  }
  const restartViewer = written && (await viewerRunning(undefined, transport));
  if (restartViewer) log('A Foundry viewer is running; restart it (bun run daemon:start restarts the daemon) to load the new configuration.');
  return {
    kingdom: {
      status: kingdom.status,
      ...(kingdom.url ? { id: kingdom.id, url: kingdom.url, installationId: kingdom.installationId } : {}),
    },
    projects,
    restartViewer,
  };
}

/**
 * The paired Kingdom to set up: `--kingdom`, else the one at `--kingdom-url`, else the only one, else a prompt.
 * No match (and `--kingdom-url` names an unpaired address) means pairing a new one.
 */
async function chooseKingdom(options: ArchiveSetupOptions, runtimes: KingdomRuntimeStatus[]) {
  if (options.kingdom) return selectKingdomRuntime(runtimes, options.kingdom);
  const url = options.kingdomUrl ? kingdomUrl(options.kingdomUrl) : undefined;
  const candidates = url ? runtimes.filter((runtime) => runtime.url === url) : runtimes;
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length) return { status: 'disconnected' };
  if (!options.prompts) throw Error('Several Kingdoms are paired; choose one with --kingdom ID|URL (bun run kingdom status lists them).');
  const index = await options.prompts.choose(
    'Which Kingdom should these archives publish through?',
    candidates.map((runtime) => `${runtime.url} as ${runtime.owner} (${runtime.id}, ${runtime.status})`),
    0,
  );
  return candidates[index]!;
}

function chooseFromFlags(options: ArchiveSetupOptions, matches: KingdomConnection[], kingdom: boolean): Choice | string {
  if (options.connection === 'kingdom' && kingdom) return { kind: 'kingdom' };
  if (options.connection && options.connection !== 'kingdom') {
    if (matches.some((c) => c.id === options.connection)) return { kind: 'kingdom', connectionId: options.connection };
  } else if (matches.length === 1) return { kind: 'kingdom', connectionId: matches[0]!.id };
  else if (matches.length > 1) return 'Several Kingdom connections carry this project; pass --connection.';
  if (options.archiveUrl) {
    const variable = options.archiveTokenEnv ?? 'ARCHIVE_TOKEN';
    const secret = process.env[variable];
    if (!secret) throw Error(`Set ${variable} to the Archive token, or pass --archive-token-env.`);
    return { kind: 'archive', url: options.archiveUrl, secret };
  }
  if (options.connection) return `Kingdom connection ${options.connection} does not carry this project.`;
  return kingdom ? 'No Kingdom connection carries this project.' : 'Kingdom is not connected and no --archive-url was given.';
}

async function promptChoice(
  prompts: SetupPrompts,
  label: string,
  projectId: string,
  matches: KingdomConnection[],
  kingdom: boolean,
): Promise<Choice | string> {
  const choices: [string, () => Promise<Choice | string>][] = [
    ...matches.map(
      (c) => [`Kingdom connection: ${c.name ?? c.id} (${c.id})`, async () => ({ kind: 'kingdom' as const, connectionId: c.id })] as [string, () => Promise<Choice>],
    ),
    ...(kingdom ? [['Kingdom-stored archives', async () => ({ kind: 'kingdom' as const })] as [string, () => Promise<Choice>]] : []),
    [
      'Direct Archive server (URL + token)',
      async () => {
        const url = await prompts.ask('Archive URL');
        const secret = await prompts.secret('Archive access token (hidden)');
        return url && secret ? { kind: 'archive' as const, url, secret } : 'Archive URL and token are required.';
      },
    ],
    ['Skip', async () => 'Skipped.'],
  ];
  const index = await prompts.choose(
    `Where should archives for ${label} (${projectId}) publish?`,
    choices.map(([text]) => text),
    matches.length ? 0 : choices.length - 1,
  );
  return choices[index]![1]();
}
