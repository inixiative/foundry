#!/usr/bin/env bun
import { REPEATS_USAGE, runRepeats } from './feedback/repeats-cli';

const USAGE = `foundry <command>

  repeats    the corrections you keep giving your coding agents (foundry repeats --help)`;

/** The `foundry` command. */
export async function runFoundryCli(args = Bun.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'repeats') return runRepeats(rest);
  if (!command || command === '--help' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

if (import.meta.main)
  runFoundryCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.message.includes('--'))
        console.error(`\n${REPEATS_USAGE}`);
      process.exitCode = 1;
    },
  );
