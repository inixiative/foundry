#!/usr/bin/env bun
/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:setup
 */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localArchive } from '@inixiative/archive/remote';
import { inspectReadiness, type ReadinessIssue } from './readiness';
import { ConfigStore } from './viewer/config';

/** Shape migrations applied on load: nothing to run, the next settings save writes the current shape. */
export const migrationIssues = (migrations: readonly string[]): ReadinessIssue[] =>
  migrations.map((migration) => ({
    severity: 'warning',
    scope: 'global',
    code: 'settings-migrated',
    message: `settings.json was loaded through a shape migration (${migration}); the next settings save writes the current shape. Nothing to run by hand.`,
  }));

/** Inspect existing settings without starting servers, agents or authentication flows. */
async function main() {
  const flags = process.argv.slice(2),
    offline = flags.includes('--offline'),
    args = flags.filter((arg) => arg !== '--offline');
  if (args.includes('--help')) {
    console.log(
      'Usage: bun run doctor [configuration-directory] [--offline]\nReads existing settings.json and checks local setup without starting agents or provider requests. Asks each paired Kingdom which Signets it lists and sends one request to the local Archive; --offline skips them.',
    );
    return;
  }
  if (args.length > 1 || args[0]?.startsWith('--')) throw Error('Invalid arguments');
  const directory = resolve(args[0] ?? '.foundry');
  if (!(await stat(resolve(directory, 'settings.json'))).isFile()) throw Error('Missing settings');
  const store = new ConfigStore(directory);
  const config = await store.load();
  const report = await inspectReadiness(config, {
    configDir: directory,
    archive: () => localArchive(),
    ...(offline ? {} : { transport: fetch }),
  });
  report.issues.push(...migrationIssues(store.migrations));
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
