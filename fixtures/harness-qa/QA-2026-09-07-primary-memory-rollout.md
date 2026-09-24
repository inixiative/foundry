# Primary Memory Selection Rollout

Supervisor accepts the bounded memory correction after independent24-case QA,
baseline, six success/refusal browser checks and Astra's explicit Task A review
statement at02:50:31.687Z. Its one nonblocking own-property lookup finding was
then fixed by Fable and independently verified. Astra's combined review/recorder
preparation turn remains active: this is NOT a claim that its entire turn completed.
This Fable-owned slice does not add another accepted Astra lead slice; count4.

## Acceptance Evidence

- All7 independent memory files/24 cases, types/diff:
  .foundry/qa/2026-09-07T03-00-49.886Z-G3/report.json.
- Full baseline: .foundry/qa/2026-09-07T03-01-13.440Z-baseline/report.json.
- Browser refusal/history evidence: QA-2026-09-07-memory-blocked-viewer.md.
- Fable hardening native end_turn02:58:20.985Z and matching Foundry response;
  own-property lookup independently inspected in file-memory.ts. Its final text
  repeated stale count3; CORE-005 is authoritative at count4.

## Controlled Restart

Fresh before checkpoint .foundry/qa/checkpoints/2026-09-07T03-00-51.724Z.json:
2 idle threads,30 saved work-thread messages,22 traces, native bindings captured.
Rechecked zero live buffers and actual native end_turn before shutdown. Validated
current saved configuration read-only with the new shared validator. Original403
memory-file hashes saved in the matching -memory-files.json manifest.

Sent SIGINT only to verified primary listener PID4097. Owned exec68494 exited0
after local store/worker shutdown; native Fable child41726 also exited. Active
Astra PID43025 and separate4407 server were untouched. Closed SQLite copied,
without replacement/import, to the before checkpoint's -sessions.sqlite path.

Restarted with the same command/environment:
env FOUNDRY_MODE=unattended VIEWER_PORT=4400 bun run start
Owned exec24692; listener PID91342. Ready03:03:03.112Z, startup auxiliary self-test
PASSED. This is not yet central same-session continuation proof.

After checkpoint .foundry/qa/checkpoints/2026-09-07T03-03-27.398Z.json:
2 idle threads/22 traces. Structural comparisons pass: both complete message
arrays unchanged, every previous trace ID retained, native binding map identical,
all four thread-knowledge layer contents unchanged (two initialized on work thread).
All403 pre-existing memory-file hashes are unchanged; none missing. Initial exact
inventory comparison reported false because startup appended two records. Inspection
confirms both are owned domain_learning audit records with decision=restored,
evidence.kind=restore, revision1 for conventions/memory. They do not invent new
learning or overwrite prior audit. Full inventory after startup405.

Headless primary layout/history checks333/390/768/1440 pass:
.foundry/qa/layout/2026-09-07T03-05-25.312Z/report.json. No visible-tab reload or
browser-only legacy history restoration is claimed.

## Measurement And Follow-Up

Pre-rollout exact native input report:
.foundry/qa/memory-injection/2026-09-07T03-01-14.906Z.json. Latest actual prompt
239046 chars, raw memory228942 chars /96.27% of system input. Classify and route
each about15s. These are character/stage observations, not tokenizer values or
a controlled model-speed comparison. Full native retained context is unobserved.

Read-only central continuation admitted as
turn_9aed6829-b1eb-469c-8a85-af58de21c1f7, request G3-primary-continuation-request.md,
HTTP200/matching start. Verify its actual same-native-session tools, terminal and
input before claiming continuity or input reduction. It also checks stale generated
knowledge: preserved revision1 still describes an old smoke/audit, not recent
implementation work. Preservation alone does not establish timely learning.

No sibling dependency integration, scoped native-tool bridge, account/binding
change, new native capture, native parity or whole-goal acceptance. Primary now
loads reviewed memory code; Astra's separate server remains on its old backend.

## Verified Continuation And Input Size

The original Fable native binding produced actual tools at03:08:05.014Z and
03:08:06.899Z, then end_turn03:08:43.065Z. Bun returned1.3.14. Matching Foundry
response is preserved in QA-2026-09-07-primary-memory-continuation.md. The fresh
checkpoint03:09:41.498Z contains two idle threads and23 traces.

Independent report .foundry/qa/memory-injection/2026-09-07T03-11-03.623Z.json
matches the exact15062-character formatted input to native user input at
03:07:50.747Z for turn_9aed6829-b1eb-469c-8a85-af58de21c1f7. Raw selected memory
including its presentation is6364 chars, compared with228942 before rollout;
the full formatted input was239046 chars before. Generated thread knowledge is
still1326 chars. These are different tasks, not paired latency/capacity tests.
Planning took10005ms, classification15013ms and routing15029ms after rollout:
input reduction has not fixed the middleware deadlines.

Fable correctly identified both generated summaries as stale descriptions of
the old smoke/audit. Current-work causal learning remains open. Its observation
that current-request audit copies entered relevance selection requires an
identity-based independent regression, not deletion of retained audit.

Read-only source inspection also finds SessionBackedProvider accepts opts.model
but omits it from native creation and from its warm-session profile. New independent
native-model-profile.test.ts covers this separate S5/G7 correctness boundary.
Owned primary children all run --model fable; the saved classifier/router agent
overrides also explicitly say fable, despite defaults.classifierModel=haiku.
Therefore those argv alone do NOT prove the wrong model ran on these particular
requests, nor establish the cause of stale learning/timeouts. Do not silently
override saved settings or claim a causal performance fix.
