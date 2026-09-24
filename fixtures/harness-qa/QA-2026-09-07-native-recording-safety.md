# Independent Native Recording Safety

S0 is active in Astra native turn01a07946-46fb-70c1-830b-ff27190df0dd.
Production sibling source remains unchanged; the recorder/sanitizer are new
script surfaces, and Foundry still resolves the registry dependency.

Independent test-first cases in acceptance/native-recording-safety.test.ts import
only the pure sanitizer/frame recorder; they do not start native processes or
edit sibling files. All three fail against the initial implementation:
.foundry/qa/2026-09-07T00-39-17.892Z-G5/report.json.

1. Untyped numeric payloads inside content arrays are copied verbatim, although
   only typed numeric protocol fields should be retained. Synthetic987654321
   survives; the same test requires valid usage.input_tokens7 to remain intact.
2. An envelope with phase=analysis but no type discriminator preserves controlled
   literal text from its content. Analysis must be omitted independently of the
   presence of a type/kind tag. No real reasoning payload was inspected here.
3. After a chunk ends exactly at a newline, the next frame's firstChunk incorrectly
   points to the preceding chunk. This contradicts the claimed framing provenance.

These are synthetic adversarial/reproducible recording defects, not a claim of
observed real-secret disclosure. Current Claude and MCP captures report native
terminals, unchanged sentinel files, no observer errors and owned process exit.
Their integrity still requires review; sanitization does not establish parity.
App-server was still in handshake at the last observation; do not rerun it merely
because no stdout frame has arrived. Wait for the owned handle's authoritative
terminal/cleanup evidence.

Additional review question: record.ts derives noTurn from absence of observed
outbound frames in cleanup. If an observer fails, absence is not reliable proof
that no request was sent. Prefer explicit send admission plus successful framing
evidence when classifying not-started/cleanup safety. Do not convert unknown work
to cancelled/complete. This question is not yet an independently executed test.

Do not modify these independent assertions to obtain a pass. Correct S0 records
without automatic native replay: immutable original capture provenance must remain
clear. If a recorder fix cannot recover information from a sanitized artifact,
mark its limitation and propose a bounded recapture for review rather than inventing
missing source frames or claiming an exact reconstruction.

## Corrected Evidence

Astra correction completed2026-09-07T01:11:01.103Z, native turn
01a07959-8ffd-71c1-9061-234935c15346. Supervisor ran cross-check.ts independently:
../agent-session/.qa/s0-cross-2026-09-07T01-00-25.419Z/report.json passes all three
unchanged cases with stable sibling/Foundry fingerprints. Full sibling check also
passes independently in .qa/s0-2026-09-07T01-05-39.345Z/report.json:44 ordinary
checks, six expected capability failures, both explicit typechecks/diff checks.

New CaptureState tests separate send admission, observed/attempted writes and
observer failure from native terminal/exit facts. Observer failure cannot prove
no-turn, mask the original transport failure or suppress the original single write.
The corrected captures have native terminals and owned exit, no observer errors,
explicit one-send admission and unchanged controlled files. Four original capture/
preflight hashes remain intact; format1 provenance remains historical.

MCP now preserves four stable item start/end pairs and session/turn/call relationships,
including unknown-item refs. Command item and call ref13 agree; all turn refs3
agree. Item type names remain omitted, not inferred. Claude preserves message/tool
refs; dedicated turn-field and effort acknowledgment limitations remain explicit.
Fable must review this bounded S0 evidence before S1 implementation or acceptance.
