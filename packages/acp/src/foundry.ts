#!/usr/bin/env bun
/**
 * @atlas
 * @kind service
 * @partOf feature:acp
 */
/** `foundry` from a foundry-acp install: Foundry's own command line (`foundry repeats`). */
import { runFoundryCli } from '@inixiative/foundry/cli';

process.exitCode = await runFoundryCli(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
