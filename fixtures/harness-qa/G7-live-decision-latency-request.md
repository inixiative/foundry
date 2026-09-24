# G7 ready follow-up: observed serial decision waits

Prepared, NOT dispatched. Do not interrupt active Astra I0/I1 or Fable T2 work.
Preserve full native integration/learning/tool retrieval and scope. This is a
performance requirement to fix and verify before claiming daily-harness parity,
not a reason to indefinitely defer actual both-engine samples.

Supervisor read three completed live Fable traces without making any model calls:
turn_f31b9283-2782-4e9b-8e22-f73f18365e5c,
turn_d701f141-48ad-42da-8b96-2de510327eb4,
turn_0522fef2-4c66-497b-8c59-7142bbd985b6.
Each has about30 seconds before its first executor span:30014.76,30011.65,
30024.72ms. Classifier and router each take about15 seconds in sequence. All three
routers explicitly record fallback; latest router text specifically reports
Turn timed out after15000ms. Classifier output is a keyword result, without an
explicit timeout reason; duration alone is not proof of its exact failure cause.
Trace spans say ok for resulting fallback output, not confirmed native success.

Safe timing-only report (no prompts/responses/decision text/native tapes):
.foundry/qa/dispatch-overhead/2026-09-07T06-35-42.972Z-de29cc82-784a-4281-b908-c1b3364a4e24-G7/report.json.
Reproducible read-only command is scripts/measure-dispatch-overhead.ts with explicit
loopback origin, thread and completed turn IDs. Two independent report cases
ensure overlaps are not summed and incomplete evidence is not called zero. This
is historical live-backend evidence, not a measurement of current uninstalled
source, CPU overhead, native work time or a matched direct-native baseline.

After integration handoff, trace the actual configured decision profiles, native
admission/settlement, parse/fallback and dependency graph. Preserve configured
model/effort/tool restrictions. Do not simply shorten timeouts, silently choose a
weaker model, skip required decorators or treat abandoned native work as stopped.
Do not attribute to quota/account identity without supported non-secret evidence.

Implement the appropriate ready correction using existing flow/provider contracts:
avoid repeated waits on demonstrably unavailable capacity; allow explicit direct
operator routing where intended; run genuinely independent domain work in parallel
while preserving true classification-to-routing dependencies. Required instructions,
configured domain knowledge and owned committed thread knowledge still reach the
central message with immutable provenance. Expose fallback/unknown occupancy and
what actually ran, rather than presenting a heuristic as model acknowledgment.
Preserve learning background/nonblocking eligibility and no unknown-turn replay.

Test policy choices, actual owned availability, deterministic cached fast paths,
dependency timing and failure modes. Then compare matched direct and Foundry native
samples on both engines with same model/effort/context/tools and scoped setup.
Report median/spread/sample size and exact trace phases; preregister sufficient
repeated samples before percentile claims. No removing context/tools to win speed.
The100ms cached no-op target and three consecutive full scenario runs in CORE-003
remain release criteria, not proven by the current live trace inspection.
