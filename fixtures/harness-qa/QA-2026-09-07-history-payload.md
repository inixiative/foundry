# History payload baseline for G6/G7

Read-only GET observations, 13:00Z, both owned live work threads. No model work,
message mutation, account/configuration access, server restart or package change.
Reports contain sizes/counts only, not prompts, outputs or native payloads.

| Live history | Messages | Response bytes | Metadata value bytes | Largest row |
| --- | ---: | ---: | ---: | ---: |
| Fable4400 | 100 | 17,369,507 | 16,979,010 | 1,713,330 |
| Astra4407 | 59 | 1,700,812 | 1,495,150 | 71,257 |

Both requested limit100 and neither response advertised pagination. Absent
top-level nativeTools data is recorded as null, not zero actual tool usage.
The different message counts/content make these unsuitable as a model/engine
performance comparison. Single observed HTTP/read durations161.79/29.45ms are
diagnostic only, not percentiles, native work time or matched latency evidence.

Reports:
- .foundry/qa/history-payload/2026-09-07T13-00-09.216Z-a4202152-1558-4a63-a47c-246b13a12b8c-G7/report.json
- .foundry/qa/history-payload/2026-09-07T13-00-17.010Z-4fd1e1b3-183b-4ae5-9076-0565409b2a93-G7/report.json

`scripts/measure-history-payload.ts` is repeatable with explicit loopback origin,
owned thread and limit1..1000. It refuses redirects, credentials in URL, remote
hosts and malformed response shape; it performs one GET and never retries native
work. `acceptance/history-payload.test.ts`3cases13assertions pass, root types/diff
and stable root1468988b at13:00:01.793Z-f8e36664-3460-4dcd-b50d-00798523a34b-G7.
Explicit strict script/test types also pass. This measures current running servers,
not the newer uninstalled route implementation, which also exposes native tools.

## Architecture implication

The previous fresh-browser audit showed100quota notices on Fable's thread.
`store.js:_loadThreadMessages` merges the full response then `_persistLocal`
serializes every merged record to localStorage through `persistBrowserMessages`.
This is not a fixed100row cache limit:100is the initial route default. Full
metadata dominates the payload even though message content totals332,725bytes.

Next explicit G6 UI assignment should address lightweight message summaries,
on-demand immutable turn detail, complete paginated history and safe optional
cache together. Keep full server evidence, current/historical provenance, native
artifacts and pending/transient content. Preserve legacy browser-only history;
do not truncate or hide unsaved completions or strip model context for speed.
Match cache notices to actual persistence status, not each durable history row.
Measure before/after bytes and rendered behavior on equivalent long histories,
including reload, disconnected server, quota denial, inactive-thread reconciliation,
out-of-order fetches and selecting older trace/native artifacts.

This is a concrete pending usability/performance task, not implemented or accepted.
Native recovery opposite review remains the immediate prerequisite to the bounded
real experiment; do not indefinitely defer the G6/G7 product work behind tests.
