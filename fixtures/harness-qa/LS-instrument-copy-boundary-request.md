# Instrument the actual fixture-copy boundary without changing its behavior

Continue CORE-006's full goal. Your LA6fa32af2 is terminal native08:51:07.588Z,
durable1788857467613/empty, and parent read the FULL final handoff. Parent reviewed
the full final composition delta and independently passed21tests/341assertions,
types/diff, stable source, G3 08:53:04.690Z-b9d0dc69. The unchanged parent queued
guard fixture passed alongside your default10s/15s expiry and ownership controls
and initial policy. The prepared parent queue request was never dispatched because
you independently fixed that issue. Do not repeat it. Your final combined
120pass/4fail/4skip gate remains failed; no native or release acceptance.

Own LS diagnostic preparation, not another production repair or uninstrumented
stress rerun. Parent read integrated-failure-boundaries.json and the fixture source.
Source fixture contact-migration has only four regular files (README, checker,
baseline test, implementation; roughly8KB). Existing
packages/foundry/tests/m4-browser-order-diagnostic.test.ts records marks only after
awaits and starts its event-loop lag sampler AFTER both copies. Thus it cannot
measure event-loop liveness DURING the observed stall, and an early failure can
prevent its final report. It also exercises a separate reproduction, not the
actual cp awaited by the failing protected tests. These are concrete diagnostic
gaps, not proof of an iCloud/Bun/kernel mechanism or a production bug.

Build a narrowly gated, test-process-only diagnostic preload/helper plus NEW
self-tests and docs/LS-copy-boundary-diagnostic-handoff.md. Leave existing protected
native-domain-loop/m4c/diagnostic tests, their defaults/assertions/timeouts, fixture
files, production composition/runtime/providers/drivers and all installed/live
state unchanged. Do not rename or move old evidence. No native models, Chrome,
installation, account/binding changes, root restart, process tracing or process kill.

The diagnostic must wrap the ACTUAL node:fs/promises cp calls imported by the
protected runner/test modules in an explicitly opted-in fresh Bun test process,
not copy a separate sample and assume it observed the original. Verify the
instrumentation reached an independently imported named cp binding on this runtime.
Do not substitute a different copy algorithm or mock a successful copy for the
measurement. Preserve exact original arguments, result/rejection object and
original promise behavior as far as instrumentation permits; document unavoidable
observer overhead. Rejected operations must still fail their callers unchanged.

Record invocation identity, scoped source/destination, wall and monotonic start/end,
pending duration, and event-loop liveness sampled BEFORE and THROUGH the original
await. Pending copies must leave an initial retained record even if the protected
test times out; settlement after a test timeout stays a late original, not a new
attempt or passing test. Distinguish sampler silence from evidence of a live loop,
and an awaited-boundary delay from a proven syscall/filesystem cause. Instrument
nearby mkdir/mkdtemp only if necessary to disambiguate the existing boundary and
with the same strict path filtering. No unrelated paths, credentials, message
contents, system-wide traces or broad process scans. Own log descriptors/timers,
bound diagnostics, and make cleanup explicit; do not keep a process alive just to
finish a report. A diagnostic logging failure must be observable and must not turn
the original failure into success or trigger a copy retry.

Self-tests may use controlled deferred operations and small isolated files: prove
begin/pending/late finish, successful and rejecting passthrough, path filtering,
monotonic timing despite Date.now mocks, explicit opt-in, correct imported-binding
instrumentation, unchanged byte copies, and no leaked sampler/descriptor. These
are diagnostic correctness tests, NOT an LS timing measurement or native proof.
Keep evidence concise and preserve initial failures. Strict-check your new code.

SCHEDULING: Fable turn69cd84e5 is ACTIVE on port4400/thread
thread_01a0776b-8019-743a-bc1d-9a22cc12e0e9, implementing complete middleware phase
history in domain/flow/cartographer/runtime/persistence/viewer modules. Do not edit
those files, send it a message, interrupt it, or run the integrated/timed/browser
workloads while it is active. Lightweight source reads, your new diagnostic code
and bounded self-tests are permitted; their results must not be labeled stable
whole-source or performance proof. Stop after diagnostic preparation and a concrete
instrumented exact-order command plan. Parent will independently review it and
schedule the actual failing-order measurement after Fable finishes; no need to sit
in a long wait or launch it yourself without that scheduling decision.

The later comparison should retain the actual failing order and limits, compare
an instrumented control, and capture source/environment identity. Off-iCloud output
can be a distinct control but is not itself a causal fix, particularly while the
source fixture remains on the synced volume. Do not compensate for a real defect
with wider deadlines or suppressing assertions. Full actual native learned next
turn, historical inspection, E/Herald/both-engine fidelity and latency remain open.
