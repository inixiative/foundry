#!/usr/bin/env bun
/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:setup
 */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localArchive } from '@inixiative/archive/remote';
import { inspectReadiness } from './readiness';
import { Keychain, providerKeyEnvironment } from './secrets/keychain';
import { ConfigStore, foundryConfigDir } from './viewer/config';

/** The running daemon's `GET /api/warden-hosts/health?fresh=1`, printed; exit 1 unless every chorus is healthy. */
async function printWardenHostHealth(projectId: string | undefined) {
  const port = Number(process.env.VIEWER_PORT ?? 4500);
  const query = new URLSearchParams({ fresh: '1', ...(projectId ? { project: projectId } : {}) });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/warden-hosts/health?${query}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    });
    const health = (await response.json()) as { ok?: unknown };
    console.log(JSON.stringify(health, null, 2));
    process.exitCode = response.ok && health.ok === true ? 0 : 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        { ok: false, reason: `Foundry's daemon did not answer on port ${port}: ${String(error)}` },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

/** Inspect existing settings without starting servers, agents or authentication flows. */
async function main() {
  const flags = process.argv.slice(2),
    offline = flags.includes('--offline'),
    args = flags.filter((arg) => arg !== '--offline');
  if (args.includes('--help')) {
    console.log(
      "Usage: bun run doctor [configuration-directory] [--offline]\n       bun run doctor --chorus [project-id]\nReads existing settings.json and checks local setup without starting agents or provider requests. Asks each paired Kingdom which Signets it lists, sends one request to the local Archive and asks Muse Code whether it is signed in (muse usage, no model turn); --offline skips them.\n--chorus asks the running daemon (VIEWER_PORT, default 4500) for every chorus's Layer 1 and Layer 2 health, each remote Chorus asked fresh, and exits 1 when one is failed or degraded or the daemon does not answer.",
    );
    return;
  }
  if (args[0] === '--chorus') {
    if (args.length > 2) throw Error('Invalid arguments');
    await printWardenHostHealth(args[1]);
    return;
  }
  if (args.length > 1 || args[0]?.startsWith('--')) throw Error('Invalid arguments');
  const directory = args[0] ? resolve(args[0]) : foundryConfigDir();
  if (!(await stat(resolve(directory, 'settings.json'))).isFile()) throw Error('Missing settings');
  const store = new ConfigStore(directory);
  const config = await store.load();
  const report = await inspectReadiness(config, {
    configDir: directory,
    environment: await providerKeyEnvironment(new Keychain({ configDir: directory })),
    archive: () => localArchive(),
    ...(offline ? {} : { transport: fetch }),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.configurationReady ? 0 : 1;
}
if (import.meta.main)
  await main().catch(() => {
    console.log(
      JSON.stringify(
        {
          configurationReady: false,
          liveAccess: 'unverified',
          profiles: [],
          issues: [
            {
              severity: 'error',
              scope: 'global',
              code: 'settings-unavailable',
              message:
                'Existing settings.json could not be loaded. Check the directory and configuration; no agents were started.',
            },
          ],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
