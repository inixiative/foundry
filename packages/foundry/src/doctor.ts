#!/usr/bin/env bun
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectReadiness } from './readiness';
import { ConfigStore } from './viewer/config';

/** Inspect existing settings without starting servers, agents or authentication flows. */
async function main() {
  const flags = process.argv.slice(2),
    offline = flags.includes('--offline'),
    args = flags.filter((arg) => arg !== '--offline');
  if (args.includes('--help')) {
    console.log(
      'Usage: bun run doctor [configuration-directory] [--offline]\nReads existing settings.json and checks local setup without starting agents or provider requests. Sends one Kingdom heartbeat and one search per archive destination; --offline skips them.',
    );
    return;
  }
  if (args.length > 1 || args[0]?.startsWith('--')) throw Error('Invalid arguments');
  const directory = resolve(args[0] ?? '.foundry');
  if (!(await stat(resolve(directory, 'settings.json'))).isFile()) throw Error('Missing settings');
  const config = await new ConfigStore(directory).load();
  const report = await inspectReadiness(config, {
    configDir: directory,
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
