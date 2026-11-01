# FEAT-002: Hand Codex its Kingdom login through `auth.command`, not `auth.json`

**Status**: 📝 Proposed (not built)
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-10-31
**Updated**: 2026-10-31

---

## Overview

A Kingdom-released ChatGPT login is written to `auth.json` in a private `CODEX_HOME`: the access and id tokens, with no refresh token. The file is deleted on release (`packages/foundry/src/providers/kingdom-subscription-authentication.ts:161-212`). CLAUDE.md (2026-10-12) says the machine keeps the token **in memory**.

Codex's `auth.command` protocol does that. Codex runs a command to fetch a bare access token, and the token never touches disk.

T3 Code ships the pattern (MIT, 2026-10-22):
- `apps/server/src/provider/CodexManagedRuntime.ts:22-131`
- `CodexManagedTokenBroker`
- `cli/managedChatGptToken.ts`

T3 serves the token from a private socket and is the single refresher.

## Risks to settle first (from the 2026-10-31 review)

- T3 sets a custom `model_provider`, which Codex records in rollouts and needs unchanged to resume (`CodexManagedRuntime.ts:25`). Existing Codex threads must keep resuming.
- T3 turns Codex multi-agent off in this mode (`:28-29`). We need it on (AS-007).
- Mid-run renewal needs a Kingdom re-release for the running login. Name the existing call (`packages/foundry/src/providers/kingdom-client.ts`), or say what Kingdom must add.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Release, limits, holders | `KingdomSubscriptionAuthentication` (same file) |
| Profile | The private `CODEX_HOME` (`assertPrivateProfile`) |
| Refresh | Kingdom stays the only refresher (`kingdom/docs/SUBSCRIPTION-CAPACITY.md`) |

## Acceptance

- [ ] No token is written to disk.
- [ ] An existing Codex thread resumes after the switch.
- [ ] Multi-agent works.
- [ ] A turn that outlives the access token renews through Kingdom.
- [ ] A cassette or live test covers it.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0 (parity refresh, 2026-10-31).
