# Lead the domain middleware loop in Foundry

The user has explicitly changed immediate priority: rock-solid pre/post-message
middleware learning and inspectable experience first; subscription pooling later.
Each layer is a domain expert with its OWN representation of this thread, distinct
from the shared factual thread record. The Herald should surface eligible knowledge
across threads, not replace per-domain understanding or broadcast private memory.
Read tickets/CORE-006-domain-middleware-loop.md and the current priority override in
CORE-003. Keep the full long-term goal, but stop widening native/SDK diagnostics
for now unless they demonstrably block this loop. Preserve your completed G5
handoff and every failure; no claim that installed readiness passed.

Implement the first concrete M0-M4 slice: a checked-in repeatable production-factory
two-domain/two-thread multi-turn scenario with actual pre/post-hook wiring and
recorded injection/learning evidence. Prove architecture and testing maintain
different thread interpretations, consume only their owned state in pre/post
reviews, preserve instructions and domain knowledge, and deliver committed learning
on the next turn without user repetition. Include unrelated-thread isolation,
immutable prior input, pending-nonblocking behavior and failure/stale/restart
controls using existing owned journal/lifecycle APIs. Reuse existing domain-learning
fixtures/helpers when suitable, but do not substitute disconnected unit passes for
the complete turn-to-turn workflow. No hand-setting learned memory to manufacture
the positive case: learning must traverse the production completion/review/commit path.

Write an initial checkpoint in docs/M0-domain-loop-handoff.md first, then checkpoint
after implementation and each test stage. ROOT ownership: thread-runtime.ts,
flow-orchestrator.ts, domain-librarian.ts and directly related lifecycle tests/new
M0 fixture only if a reproduced gap requires a runtime edit. Read current dirty
files; preserve others' changes. Parent owns independent acceptance fixtures.
Fable owns viewer UI, history routes and local-session-store; do not edit them,
providers, sibling package, configuration segments or any frozen candidate.

Also record the smallest justified next Herald publication/consumption boundary
from source. Parent found no production construction/use of Herald.summaryLayer;
verify rather than claiming it works. Do not wire global raw thread summaries into
all messages. No Herald production change in this first slice; its explicit scoped
publication contract needs this evidence and a coordinated ownership handoff.

Use controlled providers and no-model tests, exact commands/source hashes, focused
strict types and cleanup. Clearly separate source proof from live installed behavior.
No model probes beyond this ongoing Foundry work, native capture, root install,
live server restart, credential/account/binding change or commit. Do not self-accept
or increment the lead count. The parent will independently review artifacts and
the production runtime scenario, then authorize the next implementation slice.
