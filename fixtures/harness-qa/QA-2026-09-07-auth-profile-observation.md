# A0: Supported Profile and Authentication Observation

## Observed Locally

Read-only commands used Claude Code2.1.258 and Codex CLI0.153.4. Both version
commands and the status helper's strict explicit TypeScript check exited0.
The installed Claude help advertises `claude auth status --json`; Codex help
advertises `codex login status`, not a structured account-ID status option.

Repeatable script: scripts/inspect-native-auth.ts.
Report: .foundry/qa/auth-profile/2026-09-07T01-34-43.609Z/report.json.
Run: `bun scripts/inspect-native-auth.ts`.

- Default Claude profile: parsed status, exit0, loggedIn true, authMethod claude.ai.
  The supported output contains email/orgId/orgName fields, but their values are
  never logged or persisted by the helper. No stable accountId field was observed.
- New empty temporary CLAUDE_CONFIG_DIR: parsed status, exit1, loggedIn false,
  authMethod none, no identity fields. No credential setup or model turn occurred.
- Default Claude profile checked again: same identity fields/values in memory,
  same logged-in state and auth method. The report stores equality only.
- No enumerated auth-override environment variables were present in this shell.
  This does not inventory all managed settings or prove the running Fable process
  has the same authentication environment as a newly started status command.
- Codex default status: exit0, ChatGPT login reported. Account identity is unknown.
- Every status subprocess exited; only the owned empty temporary directory was
  removed. No user credential file was opened directly, copied, changed or
  deleted; the native CLIs perform their own normal credential lookup. No raw
  status/error output, secrets, personal identifiers or native reasoning were saved.

The script uses a10-second observation bound only for these short-lived status
commands. It is not an execution lease/cancellation policy for working sessions.

## Current Primary Sources

The fetched Claude documentation states that CLAUDE_CONFIG_DIR separates settings,
history and plugins, and that credentials are handled through its documented
credential storage. The authentication page explicitly says the macOS Keychain
entry is keyed to this directory, including a file fallback when necessary.
[Environment reference](https://code.claude.com/docs/en/env-vars) and
[credential management](https://code.claude.com/docs/en/authentication#credential-management).
The empty-profile observation above agrees with that isolation contract; it does
not test two independently authenticated accounts. Search snippets had older
wording, so implementation decisions use the opened current pages.

OpenAI documents CODEX_HOME as the local state root. File credential storage puts
auth.json beneath it; keyring and auto storage are separate choices. These facts
suggest a profile boundary, but this run did not test Codex keyring isolation or
alter its configured storage mode.
[Authentication](https://learn.chatgpt.com/docs/auth) and
[state locations](https://learn.chatgpt.com/docs/config-file/config-advanced).
Changing a configuration profile alone is not evidence of a separate account.

## A0 Acceptance Still Open

The first useful isolation observation is established, not the entire A0 gate.
Next bounded checks must use explicit authorized profiles, supported status and
actual execution evidence. Persist a local opaque capacity-profile ID and verified
provider identity observation/provenance; do not use raw email or access tokens as
public UI/journal identifiers. Unknown identities and capacity remain unknown.

Validate different authenticated identities in two profiles without affecting the
default login; authentication precedence and locked/unavailable credentials; the
same supplying identity acknowledged at actual execution; stale observations and
credential rotation; and Codex's selected store mode. No newly signed-in account
is assumed to mean the previous account is still independently available.

AS-001/003 logical-work continuity remains separate from a capacity profile.
These native configuration roots also contain session history: changing the root
may make a native session unavailable even when credentials work. Verify supported
same-work resume/continuation under the second capacity source, preserving artifacts,
context and old execution evidence. Do not copy credentials, silently create an
unrelated session, treat unknown work as stopped or replay completed operations.
If the provider cannot preserve native identity, an explicit lineage-bearing
handoff must expose that limitation while keeping the logical work continuous.

No account routing, pooling, lease release, profile migration, model call, server
restart or work-session rebinding was performed. Astra S1 and Fable memory selection
continue in their existing native sessions; this independent A0 investigation
does not duplicate or modify their assignments.
