import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runCli } from '@inixiative/session-archive/cli';
import { LocalArchiveStore } from '@inixiative/session-archive/local';
import { FoundryCredentials } from '../providers/credentials';
import { createTerminalPrompts } from '../setup/prompts';
import { ConfigStore } from '../viewer/config';
import { archiveDestinationSchema, readDestinations } from './config';
import {
  publishArchive,
  routingPreview,
  saveArchiveConnection,
  searchRemotes,
  syncArchives,
} from './publish';
import { runArchiveSetup } from './setup';

export async function runFoundryArchiveCli(args = Bun.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      store: { type: 'string' },
      config: { type: 'string' },
      url: { type: 'string' },
      kind: { type: 'string' },
      'project-id': { type: 'string' },
      'connection-id': { type: 'string' },
      'owner-model': { type: 'string' },
      'organization-id': { type: 'string' },
      'space-id': { type: 'string' },
      'credential-id': { type: 'string' },
      'token-env': { type: 'string' },
      'kingdom-identity': { type: 'boolean' },
      query: { type: 'string' },
      id: { type: 'string' },
      destination: { type: 'string' },
      remote: { type: 'boolean' },
      watch: { type: 'boolean' },
      help: { type: 'boolean' },
      'kingdom-url': { type: 'string' },
      kingdom: { type: 'string' },
      name: { type: 'string' },
      project: { type: 'string', multiple: true },
      connection: { type: 'string' },
      'archive-url': { type: 'string' },
      'archive-token-env': { type: 'string' },
      yes: { type: 'boolean' },
      'no-open': { type: 'boolean' },
    },
  });
  const command = positionals[0];
  const config = String(
    v.config ?? join(process.env.FOUNDRY_CONFIG_DIR ?? '.foundry', 'archives.json'),
  );
  const storePath = String(v.store ?? join(dirname(config), 'archives', 'archives.sqlite'));
  const credentials = new FoundryCredentials(
    dirname(resolve(config)),
    async () => (await new ConfigStore(dirname(resolve(config))).load()).kingdomRuntimes,
  );
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (v.help) {
    console.log(
      'Foundry credentials: connect --kingdom-identity [--kingdom ID|URL] [--connection-id ID] [--owner-model M --organization-id UUID --space-id UUID] --project-id PROJECT, or --credential-id UUID for a saved direct credential.\n' +
        'Guided setup: setup [--kingdom ID|URL] [--kingdom-url URL] [--name NAME] [--project ID]... [--connection ID|kingdom] [--archive-url URL --archive-token-env VAR] [--yes] [--no-open]; pairs Kingdom if needed and connects each registered project without a destination on the selected Kingdom.',
    );
    return runCli(['--help']);
  }
  if (
    !['connect', 'setup', 'sync', 'routes', 'publish'].includes(command) &&
    !(command === 'search' && v.remote)
  ) {
    return runCli([
      ...args,
      ...(!v.store ? ['--store', storePath] : []),
      ...(!v.config ? ['--config', config] : []),
    ]);
  }
  if (
    command === 'setup' &&
    !['url', 'kind', 'project-id', 'kingdom-identity', 'credential-id', 'token-env'].some(
      (key) => v[key] !== undefined,
    )
  ) {
    const prompts = !v.yes && process.stdin.isTTY ? createTerminalPrompts() : undefined;
    try {
      const result = await runArchiveSetup({
        configDir: dirname(resolve(config)),
        archivesPath: config,
        prompts,
        kingdom: v.kingdom as string | undefined,
        kingdomUrl: v['kingdom-url'] as string | undefined,
        name: v.name as string | undefined,
        projects: v.project as string[] | undefined,
        connection: v.connection as string | undefined,
        archiveUrl: v['archive-url'] as string | undefined,
        archiveTokenEnv: v['archive-token-env'] as string | undefined,
        open: !v['no-open'],
      });
      output(result);
      if (result.projects.some((project) => project.status === 'failed')) process.exitCode = 1;
    } finally {
      prompts?.close();
    }
    return;
  }
  if (command === 'connect' || command === 'setup') {
    if (
      Number(Boolean(v['credential-id'])) +
        Number(Boolean(v['kingdom-identity'])) +
        Number(Boolean(v['token-env'])) >
      1
    )
      throw Error('Choose one credential source');
    const identity = v['kingdom-identity']
      ? await credentials.kingdomIdentity(v.kingdom as string | undefined)
      : undefined;
    const kind = identity ? 'kingdom' : String(v.kind ?? 'archive');
    const destination = archiveDestinationSchema.parse({
      kind,
      url: v.url ?? identity?.url,
      projectId: v['project-id'],
      ...(kind === 'kingdom'
        ? {
            connectionId: v['connection-id'],
            ownerModel: v['owner-model'],
            organizationId: v['organization-id'],
            spaceId: v['space-id'],
          }
        : {}),
      ...(identity
        ? { credential: { type: 'kingdom-runtime', owner: identity.owner } }
        : v['credential-id']
          ? { credential: { type: 'managed', id: v['credential-id'] } }
          : { tokenEnv: v['token-env'] ?? 'ARCHIVE_TOKEN' }),
    });
    output(await saveArchiveConnection(config, destination, credentials));
    return;
  }
  if (command === 'search') {
    const results = await searchRemotes(
      readDestinations(config),
      String(v.query ?? ''),
      2048,
      credentials,
    );
    output(results);
    if (results.some((r) => 'error' in r)) process.exitCode = 1;
    return;
  }
  const store = new LocalArchiveStore(storePath);
  try {
    if (command === 'routes') output(routingPreview(store, readDestinations(config)));
    else if (command === 'publish') {
      if (!v.id || !v.destination) throw Error('Publish requires --id and --destination');
      output(
        await publishArchive(
          store,
          String(v.id),
          archiveDestinationSchema.parse(JSON.parse(readFileSync(String(v.destination), 'utf8'))),
          fetch,
          credentials,
        ),
      );
    } else {
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        do {
          const results = await syncArchives(store, readDestinations(config), credentials);
          output(results);
          if (!v.watch && results.some((r) => r.status.startsWith('failed'))) process.exitCode = 1;
          for (let i = 0; v.watch && !stopped && i < 30; i++) await Bun.sleep(1000);
        } while (v.watch && !stopped);
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    }
  } finally {
    store.close();
  }
}
if (import.meta.main)
  runFoundryArchiveCli().catch((error) => {
    console.error(
      Bun.argv[2] === 'setup' && error instanceof Error && error.name === 'Error'
        ? error.message
        : 'Archive command failed; check configuration and credential access.',
    );
    process.exitCode = 1;
  });
