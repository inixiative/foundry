# Revise native projection at the actual SessionBackedProvider owner boundary

Your de392bba completed native end_turn17:00:37.052Z, matching durable completed
row and empty live buffers. Parent read the FULL M4-native-factory-evidence-handoff
and helper/factory/tests. The nine controlled factory/helper cases now pass, but
the actual session-backed boundary still rejects legitimate events. This is a
blocking implementation correction, not accepted production integration.

Parent regression: fixtures/harness-qa/acceptance/native-projector-provider-owner.test.ts.
It uses the REAL SessionBackedProvider and your projector over a controlled
prewrite-v1 adapter, not a model, CLI, browser or transport process. The provider
adds providerSessionKey=threadId at session-backed.ts:255. The factory initializes
the projector with the earlier meta.nativeObservation.owner (without that key).
sameNativeOwner compares providerSessionKey, so register and tool begin/result are
rejected as foreign. The exact public result is observed but projected.length=0.
Owned admission and controlled idle handle are released even on assertion failure.

Stable combined parent RED9PASS/1FAIL/50assertions, explicit strict types PASS:
.foundry/qa/2026-09-07T17-03-40.263Z-606770d4-a5f7-41ac-a6ce-8927790a0fc7-G3/report.json
fingerprint9092fff2b301ac462da3ec773acf3a068ddc1b38a7649127996e9fda82abb2b1.
The other files in that command are the unchanged parent factory regression and
your projection/factory-path tests. Original standalone0/1/5 report17:02 retained;
one optional-method TypeScript annotation in the parent fixture was corrected.

Fix the boundary coherently: validate the logical dispatch owner and expected
provider pool, capture the successfully registered full owner, and require exact
ownership for subsequent observations. Do not globally weaken sameNativeOwner or
ignore providerSessionKey on all events; keep foreign-pool/dispatch/project/
generation/unregistered controls. Do not change the parent regression to invent
the key earlier than the actual provider does. Keep the ordinary factory tests
and add real SessionBackedProvider -> factory -> runtime -> both reviews coverage,
without the runner-only projector. Preserve the raw journal-before-projection order.

Your source ownership is unchanged: native-tool-projection helper, narrow factory
integration and focused tests. Parent acceptance fixtures remain untouched.
Astra is now actively correcting its runner in turn5309a51a-eccd-4241-af88-1ec87230ff36:
removing duplicate projection, actual browser exercise, actionable errors and
delivery revision proof. Do not edit its runner files. Update your handoff with
the new RED/GREEN, exact hashes and remaining scope; no blanket acceptance based
on the earlier broad sweep. Parent/opposite review still follows.

No native sample, installs/candidates, live state/server restart, account/binding/
credential/shared-browser changes, or commits. The accepted journal fix is done,
countTEN/full goal unchanged. Source-controlled tests only.
