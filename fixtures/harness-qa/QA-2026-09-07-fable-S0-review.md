Nothing further is needed. The scripts, tests, sanitized artifacts, manifests, check outputs, and supervisor records are all in hand.

## Verification

| Check | Result |
|---|---|
| sibling `check.ts` rerun now | passed; 50 tests pass across 4 files, both typechecks and diff check clean, source fingerprint unchanged |
| sibling `cross-check.ts` rerun now | passed; three unchanged Foundry safety cases pass, sibling inventory identical before and after |
| production source in sibling versus installed package | all four engine files byte-identical; Foundry still resolves the registry package |
| sibling working tree | only new untracked files under scripts, tests, fixtures, the s0 tsconfig, and QA output |
| string-leaf audit of all five sanitized recordings | every string is an allowlisted tag or label, a controlled literal, a redaction marker, a stable ref, an ISO timestamp, a hash, the probe prompt, a known key name inside shape data, a version string, or a spawn argument; no filesystem paths, credentials, environment values, or free text survived |

The 50 count includes the six expected-failure regressions, which the runner reports as passes. That is the intended forcing function: when a parser fix lands, the affected test turns red until promoted.

## Findings, most severe first

**1. Medium, recorder allowlist gap, no current disclosure.** The spawn seam persists the full raw argument vector of the native process in the lifecycle record (`scripts/s0/record.ts` line 63). Everything else that reaches disk passes through the sanitizer; argv does not. In these runs the arguments are model, effort, permission flags, and transport flags, all benign. But the same seam with a resumed session would persist the real native session id verbatim, contradicting the stated policy that native identifiers become stable refs, and a configured base context would persist its full text. Fix is small: pass argv through an explicit flag allowlist and pseudonymize or hash any value not on it. This must land before the recorder's next authorized probe, including the S1 app-server capture.

**2. Low, utility not safety.** Sixty-two of eighty-eight MCP notifications in the corrected capture are shape-only because their wire type names are not in the hand-maintained tag list, even though the installed schema enumerates those names and they are not secrets. The fixture therefore cannot support S3's delta and item work without recapture. The schema-evidence file already records the installed type enumeration; S1 should derive the tag allowlist from it rather than from a hand list. The README declares this omission honestly.

**3. Low, forward-looking.** The terminal detector accepts any `task_complete` as the terminal for the admitted send without matching its turn ref (`record.ts` line 104). Correct for a single-send probe. S1 must correlate terminal to turn before any multi-turn capture.

**Confirmed correct.** Numeric values require typed field and context; nested content numbers become type markers while usage survives. Analysis and reasoning payloads are omitted by phase, channel, or tag regardless of a type discriminator, with identity refs retained. Newline-byte framing owns its first chunk after exact newline boundaries and across split UTF-8, and the corrected records show stdin frame bounds equal to their chunks. Capture state separates send admission from attempted and observed writes, so an observer failure can never establish a no-turn claim, never suppresses the single real write, and never masks the original transport error. Cleanup follows native terminal or process exit, and the lifecycle order shows the cleanup decision before the kill request in every record, so exit 143 is the recorder's own termination after evidence, not native cancellation. Replay feeds sanitized frames into the unchanged production classes and compares sanitized observations with thinking excluded, so it proves parser behaviour over retained observations only, not redacted payloads or capacity. Manifests pin every artifact, the original run's hashes are unchanged, and the original recorder source is preserved with matching hashes.

**Facts established, stated within their limits.** MCP exposes session, thread, turn, item, and call identities and links four item start and end pairs to one turn, with the command item ref equal to its exec call ref. My earlier audit statement that only the app-server path carries such identities was wrong for MCP and I withdraw it. Claude retains message and tool-use to tool-result links; dedicated turn fields and an effort acknowledgment were absent in the retained envelopes, and account identity is unknown for both. The app-server record is a handshake-only observation with no send; the array-typed turn input is static schema evidence, not an observed rejection.

**Historical versus corrected.** The first-run records keep their format-1 conservative frame bounds, lack admission state, and omit item identities. Those are declared historical limitations. The corrected recorder fixed all three supervisor cases and they pass unchanged in both repositories.

## Acceptance

Bounded S0 is accepted as recorded evidence plus offline integrity and regression tests, with finding 1 as a precondition on the recorder before any further capture. It is not capability acceptance and none of the six regressions is green. On acceptance the lead count becomes three, with the checkpoint at four.

## Next implementation

**S1, sibling lead.** Additive fields on the session event and result types: native session id, turn id, item id, call id, and an explicit terminal outcome of completed, failed, or unknown with the native reason. Parse Claude tool results from `user` envelopes. Normalize MCP `task_complete` into a terminal event and correlate it to the admitted turn. Tests are the six existing regressions promoted, plus argv allowlisting and terminal-to-turn correlation. The app-server repair, stdio handshake and array-typed input, gets installed-schema tests first and a separately authorized probe after review.

**Memory selection, Foundry side, in parallel.** The measurement shows raw memory at 93.7 percent of the provider system section and growing every turn. That is a per-turn cost on the primary today and does not wait on S1. Recommend running it as a parallel node with a different owner: I authored the memory source and runtime paths and can implement it under Codex acceptance, with Astra continuing S1 in the sibling. Acceptance must show a learned convention surviving many irrelevant signals, retrieval of older relevant evidence, per-thread privacy, full audit-log preservation, and visible selection and omission decisions. No blind truncation and no retention shortcut without S6 proof.

**Native continuation.** This turn ran in the same native session that was bound before the primary restart, which is the continuation check the rollout record asked for, established by execution rather than by metadata.
