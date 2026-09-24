# Required Memory Retrieval Precondition

Supervisor reproduced a blocking selection/integration gap after the six earlier
memory cases passed. New ordinary regression:
fixtures/harness-qa/acceptance/memory-required-retrieval.test.ts.

Command: bun scripts/harness-check.ts G3
fixtures/harness-qa/acceptance/memory-required-retrieval.test.ts

Evidence: .foundry/qa/2026-09-07T02-15-57.608Z-G3/report.json (0pass/1fail).
Standalone strict TypeScript check of the new file passes. The production resolver,
factory and per-thread runtime dispatch to a controlled provider with no registered
retrieval tool. A26086-character mandatory rule is retained intact but omitted
from provider input. The model receives only a NOT INJECTED notice instructing it
to use a memory tool. Execution proceeds and returns success without the rule.

The regression allows either full delivery or an explicit memory/selection refusal
before provider execution. It does not require unbounded injection or a specific
implementation. A future tool-enabled path needs separate actual retrieval proof;
text claiming a tool exists is not that proof.

The native integration makes this consequential beyond the controlled fixture:
start.ts registers MemoryToolAdapter; the executor appends tools.summary() to
the prompt, but native providers bypass toolUseLoop. SessionBackedProvider creates
a native session with textOnly/maxTurns and sends a formatted prompt. It neither
registers Foundry's scoped tool handlers in that session nor handles memory calls.
CreateSessionOpts has no Foundry tool binding. Existing native shell access is
not the scoped MemoryToolAdapter and does not establish its ownership contract.

Required direction: guard mandatory context before work; expose real scoped
get/search to both native engines with tool-call/dispatch provenance and lifetime
ownership. Do not solve this by presenting nonexistent tools, dropping rules,
blindly dumping all audit records or treating direct disk access as scoped-tool
acceptance. API tool-loop support alone cannot satisfy the native gate.

Both opposite-model reviews were already active when this case was added. No
second request or interruption was sent. This record is for the next correction
after actual review completion. Memory rollout remains withheld; accepted count3.
