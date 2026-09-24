#!/usr/bin/env bun
/**
 * bun run vcr:refresh — the scheduled cadence (nightly, and after any claude, codex or
 * @inixiative/agent-session upgrade): the live tier, then the launchd tier. Exits non-zero
 * on any failure or drift so a scheduler can alert. Run it from a worktree, never from the
 * checkout the daemon runs, because it rewrites cassettes in place.
 */
import { refuseDaemonCheckout, repoRoot } from "./shared";

await refuseDaemonCheckout();
const live = await Bun.spawn([process.execPath, "run", `${repoRoot}/scripts/vcr/live.ts`], { stdout: "inherit", stderr: "inherit" }).exited;
const daemon = await Bun.spawn([process.execPath, "run", `${repoRoot}/scripts/vcr/daemon-smoke.ts`], { stdout: "inherit", stderr: "inherit" }).exited;
console.log(`\nrefresh: live ${live ? "FAILED" : "passed"}, launchd ${daemon ? "FAILED" : "passed"}${live || daemon ? "" : "; commit the refreshed cassettes"}`);
process.exit(live || daemon ? 1 : 0);
