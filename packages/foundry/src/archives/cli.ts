import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runCli } from '@inixiative/session-archive/cli';
import { LocalArchiveStore } from '@inixiative/session-archive/local';
import { FoundryCredentials } from '../providers/credentials';
import { ConfigStore } from '../viewer/config';
import { archiveDestinationSchema, connectDestination, readDestinations } from './config';
import {
  verifyArchiveDestination,
  publishArchive,
  routingPreview,
  searchRemotes,
  syncArchives,
} from './publish';

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
      'kastle-id': { type: 'string' },
      'connection-id': { type: 'string' },
      'credential-id': { type: 'string' },
      'token-env': { type: 'string' },
      'keep-id': { type: 'string', multiple: true },
      'kingdom-identity': { type: 'boolean' },
      query: { type: 'string' },
      id: { type: 'string' },
      destination: { type: 'string' },
      remote: { type: 'boolean' },
      watch: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  const config = String(v.config ?? join(process.env.FOUNDRY_CONFIG_DIR ?? '.foundry', 'archives.json'));
  const storePath = String(v.store ?? join(dirname(config), 'archives', 'archives.sqlite'));
  const credentials = new FoundryCredentials(
    dirname(resolve(config)),
    async () => (await new ConfigStore(dirname(resolve(config))).load()).kingdomRuntime,
  );
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (v.help) {
    console.log(
      'Foundry credentials: connect --kingdom-identity [--connection-id ID] --project-id PROJECT, or --credential-id UUID for a saved direct credential.',
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
  if (command === 'connect' || command === 'setup') {
    if (
      Number(Boolean(v['credential-id'])) +
        Number(Boolean(v['kingdom-identity'])) +
        Number(Boolean(v['token-env'])) >
      1
    )
      throw Error('Choose one credential source');
    const identity = v['kingdom-identity'] ? await credentials.kingdomIdentity() : undefined;
    const kind = identity ? 'kingdom' : String(v.kind ?? 'archive');
    const destination = archiveDestinationSchema.parse({
      kind,
      url: v.url ?? identity?.url,
      projectId: v['project-id'],
      ...(kind === 'kingdom'
        ? {
            kastleId: v['kastle-id'] ?? identity?.kastleId,
            connectionId: v['connection-id'],
            keepIds: v['keep-id'] ?? [],
          }
        : {}),
      ...(identity
        ? { credential: { type: 'kingdom-runtime' } }
        : v['credential-id']
          ? { credential: { type: 'managed', id: v['credential-id'] } }
          : { tokenEnv: v['token-env'] ?? 'ARCHIVE_TOKEN' }),
    });
    await verifyArchiveDestination(destination, credentials);
    output(connectDestination(config, destination));
    return;
  }
  if (command === 'search') {
    const results = await searchRemotes(readDestinations(config), String(v.query ?? ''), 2048, credentials);
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
  runFoundryArchiveCli().catch(() => {
    console.error('Archive command failed; check configuration and credential access.');
    process.exitCode = 1;
  });
