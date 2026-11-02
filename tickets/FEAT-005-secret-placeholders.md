# FEAT-005: Paste secrets as `$$word`; the agent uses them from a scratch pad it never reads

**Status**: 📝 Proposed (not built). Asked for by Aron 2026-11-01; design settled 2026-11-02.
**Assignee**: TBD
**Priority**: High
**Created**: 2026-11-01

---

## Overview

Aron, 2026-11-01, while setting up Kingdom's GitHub App: "I hate having to do this… so I can paste you secrets." Today a secret reaches an agent only by being typed into a file by hand, because anything pasted into the message is in the model's context, the harness transcript and Archive.

**The machinery is agent-session's secret scratch pad (AS-009); Foundry turns it on with a setting** (Aron, 2026-11-02: "If you're using Foundry, this is a setting you can have turned on, and it should work from your agent session. If other people want to use it, they can.").

How it works, end to end:

1. You write `$$ghp_abc123…` in a message: two dollar signs, one word.
2. `TurnService.accept` calls agent-session's `liftSecrets` before the journal, the Wardens, feedback capture or native dispatch read the text. The value goes to the thread's scratch pad; the message carries `†turn-8f2c.1`.
3. The scratch pad accumulates: a dagger per message, a numbered block per secret, a blank line, the next message.
4. The agent uses a block through the `secret_scratch` tool (`write`, `env`, `pipe`, `list`), which never returns a value. `consume: true` removes the block; an empty dagger goes with its last block.
5. Every other tool call that names the scratch pad or a `.private` path is denied.

## The setting

`secrets.scratchPad: "on" | "off"`, default `off`. Like every Foundry setting it can be set for me (personal) or for everyone (the repo's `.foundry/`). On, Foundry:

- launches every thread's session with the scratch pad option, its directory under the thread's Foundry state (`.private/scratch/`), so a restart keeps it;
- lifts `$$` words in `TurnService.accept`;
- deletes the thread's pad when the thread is archived (FEAT-003 release step).

Off, a `$$` word is ordinary text.

## Why

- Secrets in chat land in three places nobody can clean: the model's context, the harness's own transcript and Archive's capture. Lifting them before the turn is recorded is the only point where none of them has seen it.
- Pasting is how people hand over secrets. "Put it in this file, then tell me" makes the user do the agent's mechanical work every time a credential changes.
- A tool that returns nothing works on every runtime that calls tools; rewriting shell commands to drop their output doesn't work on Codex.
- Later these values go straight into Kingdom (a Credential on an Integration, under KCP), so the machine copy is a step, not the destination.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Lift, pad, tool, block | agent-session AS-009 (`liftSecrets`, the scratch pad option, `secret_scratch`, the private-path gate) |
| Where to lift | `TurnService.accept` (`packages/foundry/src/turns/turn-service.ts`), "the one turn path for messages": viewer sends, ACP prompts and Oracle turns all pass through it |
| The setting | the composition settings (`packages/foundry/src/prompts/instruction-settings.ts`), beside `harnessSettings` |
| Pad lifetime | the archive/release step (FEAT-003 worktree lifecycle) |
| Scrubbing what the agent prints back | `scrubSecrets` (`packages/core/src/feedback/correction.ts`), extended with the thread's held values (exact match) wherever Foundry already scrubs |
| Private file | `private-file.ts` moves to agent-session (AS-009); Foundry imports it |
| Into Kingdom later | `CredentialReference { type: 'managed' }` (`packages/core/src/credentials.ts`) and the Kingdom secrets provider (`packages/foundry/src/providers/kingdom-secrets.ts`) |

No new store, no new turn path.

## `.private` paths are never read (Aron, 2026-11-01)

"If a file has .private in it, either in its chain or as an append at the end, we just don't read it." A path is private when a segment is named `.private` or ends in `.private`, or a name contains `.private.`: `.private/notes.md`, `keys.private`, `app.private.pem`.

| Where | Primitive | Change |
|---|---|---|
| The agent's own reads | AS-009's gate | Denies Read/Grep/Edit/Write on a private path and a shell command naming one |
| Foundry's composer | `secretInstructionPath` (`packages/core/src/adapters/markdown-docs.ts`), which already refuses dotfiles, key files and credential directories | Refuses `.private` paths, so no `@import` pulls one in |
| Git | `@inixiative/config` `sync`, which already repairs `.gitignore` (`src/lib.ts:818`) | Also adds `.private/`, `*.private`, `*.private.*` |
| Sessions outside Foundry | Claude Code `permissions.deny` | `Read(**/.private/**)`, `Read(**/*.private)`, `Read(**/*.private.*)`, shipped by config `sync` |

## Limits

- Only messages through Foundry are lifted. Typing straight into Claude Code isn't: its `UserPromptSubmit` hook can block or add context, not rewrite.
- Under Codex full access no approval reaches the gate (AS-009), so the block holds on Claude and on Codex with approvals on.
- This stops accidental exposure, not a determined agent: a file the tool wrote can be copied and read. Signets and the runner are the structural control.

## Open

- **`.env.local`:** private too? Agents read `KINGDOM_PROD_TOKEN` from `~/code/inixiative/.env.local` today; making it private moves those tokens into Kingdom (the long-lived-access direction).

## Acceptance

- [ ] Setting off: `$$a` reaches the session unchanged.
- [ ] Setting on: a message with `$$a $$b` reaches the native session, the journal, the Wardens and Archive as `†<turn>.1 †<turn>.2`; the values appear nowhere in the thread's records.
- [ ] The agent can `write`, `env` and `pipe` a block and `consume` it; nothing it gets back contains a value.
- [ ] Read/Grep and a `cat` of the pad or a `.private` path are denied.
- [ ] The pad survives a daemon restart and is gone after the thread is archived.
- [ ] A tool result containing a held value is scrubbed to its reference wherever Foundry already scrubs.
