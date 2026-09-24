# M4-C: close the actual production-loop gaps before native pilot

Continue after original8cb40057 native task_complete16:54:29.917Z, matching durable
final and empty live buffers. Parent read the FULL final handoff and matched the
four final source hashes. This is a NEW bounded correction task, no replay and
no permission to create a candidate, install or execute a native sample.

The parent implemented the narrow LocalSessionStore deterministic statement
lifecycle fix you requested: docs/M4-journal-statement-lifecycle-parent.md.
Your final handoff is incorrect that no public store fix explains the later green
runs. Parent's bf59f181... is exactly the implemented owned64-statement cache fix,
not the earlier source. It was independently reviewed and accepted by Fable, and
parent59tests/920assertions plus strict types PASS at16:49 on stable d843a54c... .
See docs/M4-journal-statement-lifecycle-opposite-review.md. Preserve original RED
but correct the current-state explanation. Parent owns that store change; do not
redo it, treat it as still unexplained, or claim it as your contribution.

Read docs/M4-B-parent-production-gaps.md and the complete opposite draft review.
Implement these existing M4 requirements with no candidate/install/native calls:

Parent also implemented scripts/check-native-loop-artifacts.ts (parent-owned;
do not edit it). It copies completed artifacts byte-for-byte before opening only
the disposable readonly SQLite copies, compares messages/traces/native records,
knowledge/audit/checker databases/log hashes and then inventories the untouched
original again. The CykYjt report fails ONLY delivered revision identity; other
artifact checks pass. Use this independent verifier on final retained artifacts
after correcting the report. Parent is testing the verifier separately. A checker
failure is not an invitation to relabel or mutate older retained evidence.

1. Fable now owns the ordinary ThreadFactory native-tool-to-review integration
   under M4-native-factory-evidence-request.md. Do not edit its factory/helper/test
   files. Read its current handoff/status and integrate by removing your redundant
   runner-only projection when the shared path exists. Parent acceptance regression
   fixtures/harness-qa/acceptance/native-factory-review-evidence.test.ts must pass
   without pilot helpers. Preserve it. Check that the runner now uses this same
   path with exact ownership/correlation and one observation per native tool.

2. Fix the real observer's project-aware URL and exact selected-turn identity.
   Existing Fable R2 proves thread-only URLs deselect project-owned threads.
   Exercise the actual observer with controlled adapters in Chromium1440/390,
   old and fresh contexts. Select by recorded turn ID, not possibly repeated output
   text. Verify visible three-part revisions, native evidence and no page errors;
   retain and inspect screenshots. Do not claim an HTTP-only observer as browser QA.

3. Make runner errors actionable while retaining hashes/phase. Use safe bounded
   known error descriptions; do not copy raw credentials or hidden reasoning.
   Preserve failure artifacts and original owned handles on unknown work.

4. Derive delivery evidence from immutable message participant revision/hash and
   actual segments. Current artifact CykYjt incorrectly reports revision2 as sent
   to A2 when A2's participants correctly record revision1 with identical text.
   Keep current and delivered snapshots distinct and cover same-content new
   revisions. Do not spend another central turn merely to match a later revision.

Keep M4-A startup/runtime/M0, Fable's factory and parent's store ownership unchanged.
Your scope remains runner integration, browser and proof/report corrections. No global effort/
timeout lowering, seed memory or fabricated tool results. Preserve all failures.
Finish docs/M4-C-production-loop-correction-handoff.md with exact stable hashes,
tests and scope. Parent/opposite review and separately authorized immutable native
pilot still follow. Count TEN/full goal unchanged; custom experts and Herald remain
later graph nodes, subscription pooling deferred.
