# Tool Workbench QA Project

No dependencies, credentials, network or production data. Prepare a fresh copy
per engine/run with `bun scripts/prepare-harness-project.ts tool-workbench` from
Foundry. Baseline inside that copy: `bun test job.test.ts` (four local cases).

## Native scenarios

1. Ask the session to run `bun job.ts fail`, inspect its real exit7/stderr, explain
   that the failure was intentional, then run `bun job.ts run complete-1 3 10`.
   Open complete-1/report.md and result.json in Foundry. Inspect native call/result
   identifiers and compare recorded output and file hashes; prose alone is not proof.
2. Ask it to run `bun job.ts run interrupted-1 120 1000`. Wait for the ready event
   with its PID/runId, then use Foundry's actual stop control. Verify native cancel
   acknowledgment separately from process exit and artifacts. A signal-observed
   result only proves that this tool saw SIGTERM/SIGINT, not that the native session
   acknowledged cancellation. SIGKILL may leave no result: retain ready/step evidence
   and classify the terminal outcome honestly. Never replay unknown-running work.
3. Continue on the same native binding, inspect the interrupted artifacts, and run
   `bun job.ts run continued-1 2 10`. Verify original records remain unchanged and
   all three artifacts for the new command are visible after browser reload.
4. At a settled boundary, fork through Foundry. Give each branch a different output
   directory and ask each to inspect only its own private thread fact. Verify real
   native lineage, retained branch evidence and context isolation. This tool does
   not implement or simulate native forking or a child agent.
5. Use an actual native child session to independently inspect a completed report.
   Inspect its identity, parent/call linkage, tool result and artifact visibility in
   Foundry. Missing native child support remains a failing capability, not a reason
   to substitute a second shell command and call it a subsession.

The command writes ordered events.jsonl, result.json and report.md to a NEW directory.
It refuses overwrite and caps ordinary runtime at120s. No automatic retry, background
spawn or credential use. The subprocess tests exercise only this fixture; they do
not accept Foundry stop/fork/subsession/tool-streaming behavior or latency parity.
Run each real scenario on both engines and preserve requested/observed model and
effort, source/package hashes, turns, browser artifacts and native outcomes.
