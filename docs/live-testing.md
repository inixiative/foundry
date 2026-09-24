# Live-first testing

Foundry's hardest failures happen only against the real CLIs and the real launchd environment. Examples: a LaunchAgent PATH that found a broken `claude` and no `node`; `ProcessType: Background` throttling every CLI; `claude auth status` taking 3–7 s under launchd; cold `codex exec` decisions timing out. Recorded fixtures would have passed all of them. Replays give fast, deterministic protocol parsing. Live runs are the truth, so they run often and the fixtures stay fresh.

## Tiers

| Command | What runs | When |
|---|---|---|
| `bun run test` | Replays only: no network and no CLI calls. Includes the freshness check. | Every change; CI |
| `bun run test:live` | The same cassette-backed tests run live against this machine's subscriptions: Claude on `~/.claude`, Codex's ChatGPT login on `~/.codex` with `gpt-6-luna`, and local Kingdom. Every cassette is re-recorded, then everything replays. | Nightly, and after any CLI or agent-session upgrade |
| `bun run test:live:daemon` | A small live smoke inside a throwaway LaunchAgent that uses the installed daemon's PATH and ProcessType and has no terminal environment. It runs the status probes and one decision per runtime. | Nightly, and after any daemon/plist change |
| `bun run vcr:refresh` | `test:live`, then `test:live:daemon`. Exits non-zero on any failure or drift. | The scheduled job |
| `bun run test:live:api` | The API-key provider smoke. It uses paid keys from `.env`, so it is off the subscription cadence. | On demand |

Run live tiers from a worktree, never from the checkout the daemon runs. They rewrite cassettes, and `vcr:refresh` refuses to run in the daemon's checkout.

The live tiers resolve `claude`, `codex` and `node` exactly as `daemon:install` does (`resolveDaemonPath`). They start test processes with a clean environment, so no parent Claude Code session variable, credential or wrapper leaks in.

Each process may make at most 40 live calls (`FOUNDRY_VCR_MAX_LIVE`). A full live run makes about 25.

## The VCR

The VCR is `packages/foundry/src/vcr/`, ported from the template's `packages/shared/src/vcr`. It keeps the template's API: `new VCR(dir, { service, version, sanitizers })`, `queue(method, name)`, `capture`, `captureResponse`, the static version cache, `cliVersion` and `fetchVersion`. `FOUNDRY_VCR=record|replay` sets the mode explicitly. Replay never calls live, and a missing cassette is an error rather than a silent recording.

Foundry's transports are its seams:

- **Process stdio** (`ProcessCassettes`): Claude stream-json sessions through `@inixiative/agent-session`, `codex exec --json` decisions, Codex app-server JSON-RPC, and the `claude auth status` / `codex login status` probes. Each stdout and stderr line is tagged with the number of stdin events (writes, or `end`) that preceded it. Replay releases a line once the same number of stdin events has happened, so turns replay in their live order with no timers. Replay also:
  - remaps JSON-RPC request ids;
  - fills `{{cwd}}` back in with the replay's working directory;
  - refuses a stdin message whose `type` or `method` differs from the recording.
- **HTTP** (`httpCassettes`): a `fetch` for the Kingdom endpoints, in the template's captureResponse shape plus the request.
- **WebSocket** (`webSocketCassettes`): received frames are tagged with how many frames the client had sent.

Test helpers are in `packages/foundry/tests/helpers/vcr.ts`. `recordedClaudeTransport` and `recordedCodexTransport` expose the same `launches`, `writes` and `statusChecks` as the fake transports.

## Cassettes

Cassettes live at `packages/foundry/tests/fixtures/vcr/<service>/<method>.<name>.json`:

```json
{
  "version": "2.1.281",
  "status": 0,
  "body": { "kind": "process", "argv": ["claude", "--print", "..."], "cwd": "{{cwd}}", "stdin": ["..."], "stdinEnded": false,
            "frames": [{ "after": 1, "stream": "stdout", "data": "{\"type\":\"system\",\"subtype\":\"init\",...}" }],
            "exit": { "after": 2, "code": null, "killed": true } },
  "recorded": { "service": "claude", "cli": "claude", "model": "claude-haiku-4-5-20251001", "recordedAt": "2026-09-24T05:01:54Z",
                "agentSession": "0.2.0", "environment": "terminal", "durationMs": 3689 }
}
```

`version` is the CLI version. For Kingdom, which has no CLI, it is a hash of its OpenAPI document.

`outcome.<name>.json` cassettes hold the conclusion Foundry reached live, such as content, evidence and release state. Every replay must reach the same conclusion, and a live run also replays in-process and compares.

### Scrubbing

Nothing is written unscrubbed:

- **Paths.** The working directory becomes `{{cwd}}`, the temp directory becomes `{{tmp}}` and the account home becomes `~`. The username and hostname are replaced.
- **Secrets.** Tokens are replaced wherever they appear: `sk-…`, `sk-ant-…`, `kastle_…`, JWTs, GitHub and Slack tokens, and bearer credentials.
- **Identity.** Emails are replaced. Values under identity or secret keys are redacted: email, org/account/user ids and names, plan and subscription type, installation id, authorization, tokens, cookies. A redacted UUID keeps its UUID format.
- **Status output.** `claude auth status --json` prints the account (email, org id and name, plan). Only `loggedIn` and `authMethod` are kept. `codex login status` keeps only its `Logged in using …` line.

The freshness check also fails any cassette that contains a home path, an email, a token, or an unredacted identity key.

## Freshness rules

`bun run test`, and therefore CI, fails when any of these is true:

1. A cassette is older than `maxAgeDays` (14) in `fixtures/vcr/policy.json`.
2. A cassette was recorded on a CLI older than the **blessed** version in `policy.json`. A successful full `test:live` raises the blessed versions to what it recorded on.
3. A cassette was recorded on a CLI older than the **installed** one on this machine. CI has none installed, so there only the blessed versions apply. This means that after `claude` or `codex` auto-updates, local `bun run test` fails until `bun run test:live` re-records.
4. A cassette was recorded through an `@inixiative/agent-session` older than the installed or blessed one.
5. A `.pending.json` cassette exists: that is unreviewed drift.
6. A cassette contains a leak.

## Drift

A live run compares each new recording's structure with the committed cassette. The structure is the event kinds, their key paths and types, the exit code and the argv flags.

- **Protocol drift** is a new or missing event kind, a changed field or a changed exit code. The committed cassette is kept, the new recording is written as `<name>.pending.json`, and the run fails with the differences listed. It is never overwritten silently. Review each one:
  - if it is a CLI or protocol change that Foundry must handle, fix Foundry;
  - if it is an intended change, run `bun run vcr:accept`.
- **Volatile differences** are printed as `notice:` lines but do not hold a recording back. These are changes that follow model behavior or transient service state: thinking tokens, rate-limit events, reconnect errors, CLI stderr logging and MCP startup chatter.
- Model text is not structure. It differs on every run.

The launchd smoke writes its recordings to a scratch directory and reports how they differ from the committed cassettes, along with each call's latency under launchd next to the terminal recording's.

## Adding a scenario

1. Put the test in a file listed in `scripts/vcr/shared.ts` `LIVE_FILES`.
2. Drive Foundry through a recorded transport, and queue one cassette name per expected launch.
3. Assert on what live must satisfy, and prove the replay matches live with `sameAsLive(vcr, name, outcome)`.
4. Run `bun run test:live -t "<name>"` to record it. Read the cassette before committing it.
