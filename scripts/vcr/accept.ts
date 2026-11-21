#!/usr/bin/env bun
/**
 * @atlas
 * @kind entrypoint
 * @partOf primitive:vcr
 */
/** bun run vcr:accept — adopt reviewed live drift: each `.pending.json` replaces its cassette. */
import { acceptPendingCassettes, FOUNDRY_SIGNATURE_OPTIONS } from '../../packages/foundry/src/vcr';
import { display, fixturesDir } from './shared';

const accepted = acceptPendingCassettes(fixturesDir, FOUNDRY_SIGNATURE_OPTIONS);
if (!accepted.length) console.log('No pending live drift.');
for (const { cassette, differences } of accepted) {
  console.log(`  ${display(cassette)}\n    ${differences.join('\n    ')}`);
}
if (accepted.length)
  console.log(
    `\nAccepted ${accepted.length} recording(s). Run \`bun run test\` to replay them, then commit.`,
  );
