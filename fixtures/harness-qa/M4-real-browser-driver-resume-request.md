# Continue the partial owned browser driver after a confirmed terminal API error

This is a new continuation, not a replay of turn_70426df0-8628-4d6f-b2af-e1fce0f633be.
Parent verified your public native API error at 2026-09-07T23:54:12.137Z
(isApiErrorMessage=true, stop_sequence, server_error, ENOTFOUND), matching durable
Foundry agent error timestamp1788825252195, and empty live buffers on September8.
Your long-lived Claude process95751 remains present; the old task is terminal.

Continue in this same Foundry/native session. Own only the same four files:
scripts/owned-playwright-driver.ts, scripts/owned-browser-host.mjs,
packages/foundry/tests/owned-playwright-driver.test.ts, and
docs/M4-real-browser-driver-handoff.md. Read their current partial state and your
last controlled failures. The last log named green-controlled-1.log actually has
2pass/6fail/1skip; a later public command also reported six failures. Preserve
these failures. The handoff currently stops at the initial architecture record.

First reconcile prior owned resources from your public tool results. Parent's
read-only matching-name process inventory currently finds no owned-browser-host,
owned-driver-controlled, upgrade-server.mjs, unix-server.mjs or driver test process;
that is limited observation, not proof every resource was released. Do not signal
bare PIDs, restart a still-owned operation or silently abandon an unresolved child.

Astra9adab6e2 is now terminal: task_complete2026-09-07T21:24:13.066Z, matching
durable final1788816253088 and empty buffers revalidated on4407. Read its FULL
docs/M4-C-production-loop-correction-handoff.md before taking the real browser
slot. Parent will not run Chrome concurrently with this task.

Parent independently reproduced the Node/Bun HTTP upgrade distinction with two
browser-free owned servers, both terminated through their returned handles:
.foundry/qa/parent-http-upgrade-J5e3gd/report.json. Node emits upgrade101; Bun emits
response101 without upgrade; source hashes unchanged. This does not prove the
original mixed-launch stall's cause or a functioning driver.

Complete the minimal driver and its tests. Inspect the fake child's .mjs script
using CommonJS require, fd inheritance, and error diagnostics rather than treating
all failures as socket timing. Do not increase launch/readiness budgets. Also
address packaging: freezeCopy stores source files mode0444; the driver currently
passes the source host directly as executablePath. It must work with an immutable
non-executable source host, without chmod or writes in the candidate tree. The
parent owns a separate acceptance regression for this boundary. Respect the exact
selected Node binary, not just any node found in its directory through PATH.

Preserve acquired-child ownership through launch/attachment failure and late
outcomes; do not remove the only recovery endpoint or drop browser ownership just
because a cleanup race expired. Host loss must stay distinct from Chrome exit.
Keep helper2428c8b0 and its tests unchanged; do not broaden into a new broker.

Run controlled tests, strict types, and bounded isolated real Chrome normal and
stalled-close fallback with authoritative child exit. Retain per-resource cleanup
evidence and failed runs. Use apply_patch for manual edits. Return a final handoff
with exact source hashes, commands, outputs, resource outcomes and limitations.
No package install, candidate, native model/sample beyond this work session,
saved-server restart, account/binding/shared-browser changes or commit.

This is a bounded prerequisite, not the main product goal. Next remains actual
native expert pre/post learning and next-turn consumption in Foundry, configured
expert lifecycle, then explicit Herald publication. Each expert owns instructions,
domain knowledge and private per-thread interpretation; shared thread evidence is
not an authoritative interpretation. Do not add a new thread-state middleware.
