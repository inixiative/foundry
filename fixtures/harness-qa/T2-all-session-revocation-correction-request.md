# T2 all-session revocation correction

Continue in the existing Fable Foundry/native session, with the unchanged
CORE-002/003/004/005 and AS-001..005 long-term goal. Astra remains provisional
lead, accepted slice count six, next leadership/scope review eight or a serious
regression. Your completed I0/I1 opposite review is read and retained; do not
repeat it or run a model sample.

Read docs/T2-opposite-integration-review.md in full. Astra reproduced a Medium
T2 defect with actual HTTP SDK clients: bridge.close() revokes only the primary
authority, so a second SDK session's held read can settle as ok after close.
This blocks T3 bridge integration, independently of I0/I1 sentinel readiness.

Implement the bounded correction in MCP authority/transport/server/proxy and
focused tests only as needed. Latch bridge-wide revocation at close ENTRY for
every created authority, including an authority whose SDK transport has already
been removed while backend work remains pending. Avoid an unbounded permanent
list of closed servers. Preserve late successful settlement after SDK DELETE
while the bridge itself remains open. Bridge shutdown must not wait indefinitely
for a held backend; retain late records with original owner/start/SDK identity.

Add failing-first cases for second/later sessions, SDK DELETE followed by bridge
close with a held read, and primary held read while another initialization
delays close. Each late record after bridge revocation must be refused: revoked.
Retain the existing positive SDK-termination-only late success case. No native
cancellation claim follows from transport closure.

Also handle the review's refused foreign-thread factory allocation cleanup and
resource accounting, and make the nested launch descriptor an owned immutable
snapshot (or explicitly use the stable serialized configuration). Verify these
without exposing generated capabilities or weakening scope checks.

Run existing independent scope/invocation/lifecycle/late-evidence/subscription
tests and focused MCP suites, plus new cases, source types and diff check. Keep
RED and stale artifacts; report exact commands, source fingerprints, counts and
limitations in an appended correction to docs/T2-live-transport-handoff.md.
Supervisor/opposite review owns acceptance. No architecture-only replacement.

Do not edit sibling agent-session, I0/I1 provider/sample/staging/startup modules,
root dependency resolution or immutable candidates. No installs, root/sibling/
candidate commits, native model probes, additional agents, server restarts,
account/credential/configuration/binding changes or T3 activation. Astra is
finishing a new candidate baseline in disjoint files; preserve its work.
