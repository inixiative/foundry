# Usage telemetry and native context budgets

Foundry preserves Claude's cache telemetry rather than reducing usage to input
and output. The parser lives in `@inixiative/agent-session`; this change pins its
public fix commit while [agent-session PR #4](https://github.com/inixiative/agent-session/pull/4)
is reviewed. No package release is required to install the Foundry branch.

## Counters and tags

- `input` excludes Claude's disjoint cache input counters; `output` includes thinking.
- `cacheRead` and `cacheWrite` count reused and newly cached input tokens.
- `cacheWrite5m` / `cacheWrite1h` are subsets of `cacheWrite`.
- `thinking` is a subset of `output`.
- `providerUsage` retains the original usage object, including service tier,
  nested details and unrecognized future tags. It stays on individual records;
  totals aggregate only numeric counters.

Optional counters remain absent when unreported. Old analytics records therefore
show an em dash, not a fabricated cache miss. Total tokens and cumulative token
budgets include `input + output + cacheRead + cacheWrite`; do not add TTL or
thinking breakdowns again. Cost estimates still use the configured input/output
price table and do not account for cache-write premiums or subscription quota.
Use the preserved counters to audit usage; estimated dollars are not an account
usage-limit measurement.

Native result events are whole-turn aggregates. Request `usage` events preserve
message/request IDs, model and tags in their raw envelope, including incomplete
turns. Snapshots can repeat across content blocks: do not sum them with terminal
result totals. Interrupted-turn request evidence is retained, but completed-turn
session totals do not invent missing final usage.

The analytics call log shows cache reads and writes separately from Foundry's
response-cache flag. Hover cache writes for the TTL breakdown and cache reads
for the original usage tags. JSONL appends are serialized so concurrent calls
cannot overwrite each other; a call that crosses a token budget is still saved.

## Native compaction

Both `ClaudeCodeSessionAdapter` and `ClaudeCodeProvider` default to:

```ts
contextBudget: { maxTokens: 200_000, compactAt: 0.8 }
```

This sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` for the child process, including resumed and
forked sessions. Existing native `session_compact` events continue to invalidate
the hydration ledger. Foundry does not send extra model calls or run a separate
summarization loop.

Configure the `providers["claude-code"].contextBudget` field in
`.foundry/settings.json`, or pass it directly to either constructor. `false`
explicitly delegates the policy to the CLI's inherited environment/settings.
An enabled policy overrides inherited compaction-disabling environment flags.
The window must be an integer from 100k to 1M; `compactAt` must be at least 0.01
and below 1 to leave headroom. Restart existing sessions to apply a policy change.

Claude's documented controls set an **auto-compaction target**, not a hard
per-request admission ceiling. At the default, compaction is requested around
160k; large tool responses may overshoot and native runtime/model behavior can
compact earlier. The model's full window still determines the CLI status-line
percentage. Use a current Claude Code version supporting these controls; custom
spawners must pass through the supplied environment.
See [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).

This policy is independent of Foundry's per-layer context caches and its
cumulative token/spend budgets. Compaction can cause a new cache prefix to be
written; the telemetry makes that cost visible rather than promising to eliminate
cache writes.
