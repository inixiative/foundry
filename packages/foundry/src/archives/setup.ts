import { join } from 'node:path';
import { FoundryCredentials } from '../providers/credentials';
import {
  defaultKingdomUrl,
  defaultRuntimeName,
  kingdomStatus,
  pairKingdom,
} from '../providers/kingdom-cli';
import { viewerRunning } from '../providers/kingdom-pairing';
import type { SetupPrompts } from '../setup/prompts';
import { ConfigStore } from '../viewer/config';
import { readDestinations } from './config';
import { listKingdomConnections, saveArchiveConnection } from './publish';

export interface ArchiveSetupOptions {
  configDir: string;
  /** Defaults to `<configDir>/archives.json`. */
  archivesPath?: string;
  /** Omitted: non-interactive; flags decide. */
  prompts?: SetupPrompts;
  /** Pair with this Kingdom when not connected. */
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
type Choice =
  | { kind: 'kingdom'; connectionId?: string }
  | { kind: 'archive'; url: string; secret: string };
export type ProjectSetupResult = {
  projectId: string;
  status: 'configured' | 'connected' | 'skipped' | 'failed';
  reason?: string;
};

/** Guided path from nothing to a paired Kingdom and a verified destination per registered project. */
export async function runArchiveSetup(options: ArchiveSetupOptions) {
  const { configDir, prompts, transport = fetch, log = console.error } = options;
  const archivesPath = options.archivesPath ?? join(configDir, 'archives.json');
  let kingdom: { status: string; url?: string; installationId?: string } = await kingdomStatus(
    configDir,
    transport,
  );
  let written = false;

  if (kingdom.status !== 'connected') {
    log(
      kingdom.status === 'unavailable'
        ? `Kingdom runtime at ${kingdom.url} is unavailable (revoked, expired or unreachable).`
        : 'This Foundry is not paired with Kingdom.',
    );
    let url = options.kingdomUrl;
    if (
      prompts &&
      (await prompts.confirm(
        kingdom.status === 'unavailable' ? 'Pair again?' : 'Pair with Kingdom now?',
        true,
      ))
    )
      url = await prompts.ask('Kingdom API address', url ?? (await defaultKingdomUrl(configDir)));
    else if (prompts) url = undefined;
    if (url) {
      const name =
        options.name ??
        (prompts ? await prompts.ask('Foundry name', defaultRuntimeName()) : undefined);
      kingdom = await pairKingdom({
        configDir,
        url,
        name,
        open: options.open,
        replace: true,
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
  if (!targets.length)
    log('No registered projects yet. Start Foundry in a project, then run bun run archive setup.');
  const credentials = new FoundryCredentials(
    configDir,
    async () => (await new ConfigStore(configDir).load()).kingdomRuntime,
  );
  let listed: { url: string; connections: KingdomConnection[] } | undefined;
  if (kingdom.status === 'connected') {
    try {
      const result = await listKingdomConnections(credentials, transport);
      listed = {
        url: result.url,
        connections: Array.isArray(result.connections)
          ? result.connections.filter(
              (c: unknown): c is KingdomConnection =>
                typeof (c as KingdomConnection)?.id === 'string',
            )
          : [],
      };
    } catch {
      log(
        'Kingdom archive connections are unavailable; only direct Archive servers can be connected now.',
      );
    }
  }

  const projects: ProjectSetupResult[] = [];
  for (const projectId of targets) {
    const project = config.projects[projectId];
    const label = project?.label ?? project?.path ?? projectId;
    if (destinations.some((d) => d.projectId === projectId)) {
      projects.push({ projectId, status: 'configured' });
      continue;
    }
    const matches = listed?.connections.filter((c) => c.projectId === projectId) ?? [];
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
              url: listed!.url,
              projectId,
              ...(choice.connectionId ? { connectionId: choice.connectionId } : {}),
              credential: { type: 'kingdom-runtime' },
            }
          : { kind: 'archive', url: choice.url, projectId, secret: choice.secret },
        credentials,
        transport,
      );
      written = true;
      projects.push({ projectId, status: 'connected' });
      log(`Connected ${label}.`);
    } catch {
      projects.push({
        projectId,
        status: 'failed',
        reason: 'Verification failed; nothing was saved. Check the destination and its credential.',
      });
      log(`Could not connect ${label}; verification failed and nothing was saved.`);
    }
  }
  const restartViewer = written && (await viewerRunning(undefined, transport));
  if (restartViewer)
    log(
      'A Foundry viewer is running; restart it (bun run daemon:start restarts the daemon) to load the new configuration.',
    );
  return {
    kingdom: {
      status: kingdom.status,
      ...(kingdom.url ? { url: kingdom.url, installationId: kingdom.installationId } : {}),
    },
    projects,
    restartViewer,
  };
}

function chooseFromFlags(
  options: ArchiveSetupOptions,
  matches: KingdomConnection[],
  kingdom: boolean,
): Choice | string {
  if (options.connection === 'kingdom' && kingdom) return { kind: 'kingdom' };
  if (options.connection && options.connection !== 'kingdom') {
    if (matches.some((c) => c.id === options.connection))
      return { kind: 'kingdom', connectionId: options.connection };
  } else if (matches.length === 1) return { kind: 'kingdom', connectionId: matches[0]!.id };
  else if (matches.length > 1)
    return 'Several Kingdom connections carry this project; pass --connection.';
  if (options.archiveUrl) {
    const variable = options.archiveTokenEnv ?? 'ARCHIVE_TOKEN';
    const secret = process.env[variable];
    if (!secret) throw Error(`Set ${variable} to the Archive token, or pass --archive-token-env.`);
    return { kind: 'archive', url: options.archiveUrl, secret };
  }
  if (options.connection)
    return `Kingdom connection ${options.connection} does not carry this project.`;
  return kingdom
    ? 'No Kingdom connection carries this project.'
    : 'Kingdom is not connected and no --archive-url was given.';
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
      (c) =>
        [
          `Kingdom connection: ${c.name ?? c.id} (${c.id})`,
          async () => ({ kind: 'kingdom' as const, connectionId: c.id }),
        ] as [string, () => Promise<Choice>],
    ),
    ...(kingdom
      ? [
          ['Kingdom-stored archives', async () => ({ kind: 'kingdom' as const })] as [
            string,
            () => Promise<Choice>,
          ],
        ]
      : []),
    [
      'Direct Archive server (URL + token)',
      async () => {
        const url = await prompts.ask('Archive URL');
        const secret = await prompts.secret('Archive access token (hidden)');
        return url && secret
          ? { kind: 'archive' as const, url, secret }
          : 'Archive URL and token are required.';
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
