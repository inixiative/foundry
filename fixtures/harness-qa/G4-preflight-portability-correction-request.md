# Make preflight checks portable without weakening them

SUPERSEDED, NEVER DISPATCH. Parent corrected the test-only portability boundary
while Fable completed browser baseline and Astra reviewed G6. See section5 of
G4-preflight-only-handoff.md and the newer opposite-review request. This document
retains the original proposed correction scope only; it grants no current ownership.

Astra's preflight review actually ended13:39:48.463Z, native01a07c0e-29ba-7210-a965-
8dcddfe45710, matching durable final and complete G4-preflight-only-opposite-review.md
read. Read it in full. Parent reproduced unchanged tests with its missing-history
preload:1pass/8ordinary failures/14assertions. The new ordinary test is included in
the staged baseline but requires excluded historical captures and assumes the old
root registry tree. This is a real portability defect, not a reason to ship private
QA or skip all validation in an installed candidate.

Own only native-recovery-preflight.test.ts, narrowly needed separate historical
opt-in test coverage, and appended handoff/review wording correction. Production
runner6419617e must remain unchanged unless you identify a demonstrated source
defect and coordinate first. No staging/install or package changes.

Make ordinary negative tests self-contained with owned disposable manifests and
missing/malformed/mismatch inputs that fail under the REAL validator regardless
of root versus correct installed package. Keep argument/help/plan/CLI refusal,
zero native process/dispatch/browser/binding work, no output-directory creation
and immutable test inputs. Guard both spawn APIs for in-process preflight calls;
the intentional Bun CLI subprocess is not a model process. Avoid depending on a
global .foundry/qa listing or preexisting missing-path assumption, and do not make
concurrent unrelated QA writes fail an owned no-side-effect assertion.

Retain old real-manifest registry-refusal and real-artifact preservation tests as
explicit opt-in checks with supplied reviewed paths/context and clear skip scope.
An opt-in skip is not a pass or historical preservation proof. Do not weaken the
original refusal assertions or fake positive installed preflight. Keep original
captures/manifests/reports (including DB sidecars) untouched. Run the historical
opt-in against the original reviewed root context and record the evidence.

Re-run always-on tests with historical paths unavailable using the unchanged
Astra preload, plus focused recovery/identity tests, strict script/test types and
diff. Read staging allowlist; ordinary tests must need no unstaged/private files.
No clean-candidate baseline claim until parent performs the actual candidate run.

Correct handoff R2: checkNative validates native tree, imports/constructs inert
Claude/MCP marker objects BEFORE Foundry source/proposal validation; app-server
marker construction follows it. Constructors do not start/send/spawn. Do not
claim all imports follow every hash check or that no inert objects are constructed.
Append exact changes/hashes/commands/limitations to G4-preflight-only-handoff.md.

Astra now reviews the G6 config correction read-only. Count remains EIGHT bounded
Astra source slices. No source acceptance for this test correction until parent
verification and opposite review; then one immutable candidate, real preflight
and separately bounded actual recovery. Full UI/native/learning/models/pooling/
history/artifact/latency goal unchanged. Do not start another model, alter live
services/accounts/credentials/bindings/candidates, commit or retry unknown work.
