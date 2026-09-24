#!/usr/bin/env bun
/** bun run vcr:accept — adopt reviewed live drift: each `.pending.json` replaces its cassette. */
import { renameSync } from "node:fs";
import { display, driftOf, pendingCassettes } from "./shared";

const pending = pendingCassettes();
if (!pending.length) console.log("No pending live drift.");
for (const path of pending) {
  const cassette = path.replace(/\.pending\.json$/, ".json");
  console.log(`  ${display(cassette)}\n    ${driftOf(cassette, path).join("\n    ")}`);
  renameSync(path, cassette);
}
if (pending.length) console.log(`\nAccepted ${pending.length} recording(s). Run \`bun run test\` to replay them, then commit.`);
