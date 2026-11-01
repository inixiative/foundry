# FEAT-005: Paste secrets into a message; they become placeholders

**Status**: 📝 Proposed (not built). Asked for by Aron 2026-11-01; two questions below.
**Assignee**: TBD
**Priority**: High
**Created**: 2026-11-01

---

## Overview

Aron, 2026-11-01, while setting up Kingdom's GitHub App: "I hate having to do this… so I can paste you secrets." Today a secret reaches an agent only by being typed into a file by hand, because anything pasted into the message is in the model's context, the harness transcript and Archive.

**Mark a word as secret in the message, and Foundry lifts it out before anything else sees it.**

- A word starting with `$$` is a secret: `$$ghp_abc123…` (the marker ends at whitespace).
- On accept, Foundry replaces each one, in order, with a numbered placeholder, like bound arguments in a SQL query: `⟦secret:1⟧`, `⟦secret:2⟧`. The model, the journal, the Wardens, feedback capture and Archive see only the placeholders.
- The values are held by Foundry for that thread, never in the harness session: a 0600 file in the thread's Foundry state directory. They are deleted when the thread is archived.
- The agent uses a value by number, without it ever entering the agent's context:
  - `foundry secret pipe 1 -- <command>`: the value on the command's stdin (`… -- railway variables set X --stdin`, `gh secret set X`).
  - `foundry secret write 1 <file>`: the value written to a file, 0600.
  - `foundry secret env 1 <file> <KEY>`: `KEY=value` set in an env file (added or replaced).
  - There is no command that prints a value.
- The placeholder text tells the agent what it holds, for example "⟦secret:1⟧ (held by Foundry; use `foundry secret pipe|write|env 1`)".

## Why

- Secrets in chat land in three places nobody can clean: the model's context, the harness's own transcript and Archive's capture. Lifting them out before the turn is accepted is the only point where none of them have seen it.
- Pasting is how people hand over secrets. A protocol of "put it in this file, then tell me" makes the user do the agent's mechanical work, every time a credential changes.
- Later these values go straight into Kingdom (a Credential on an Integration, under KCP), so the machine copy is a step, not the destination.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Where to lift them out | `TurnService.accept` (`packages/foundry/src/turns/turn-service.ts:248`), "the one turn path for messages": viewer sends, ACP prompts and Oracle turns all pass through it. Rewrite the text before the journal, the feedback lifecycle and native dispatch read it. |
| Storage | `writePrivateJson` / `readPrivateJson` (`packages/foundry/src/client/private-file.ts`, `primitive:secrets`): 0600, no symlinks, size-capped, errors never echo contents. |
| Scrubbing what the agent prints back | `scrubSecrets` (`packages/core/src/feedback/correction.ts`) pattern list, extended with the thread's held values (exact match) wherever Foundry already scrubs. |
| Thread lifetime | the archive/release step (FEAT-003 worktree lifecycle) deletes the thread's held values. |
| Into Kingdom later | `CredentialReference { type: 'managed' }` (`packages/core/src/credentials.ts`) and the Kingdom secrets provider (`packages/foundry/src/providers/kingdom-secrets.ts`). |

No new store and no new turn path.

## Limits

- Works only for messages that go through Foundry. Typing straight into Claude Code doesn't: Claude Code's `UserPromptSubmit` hook can block a prompt or add context, but can't rewrite it.
- An agent that writes a value to a file can still read that file. This removes accidental exposure (chat, transcript, Archive), not a determined agent; Signets and the runner are the structural control.

## Questions for Aron

1. **Marker.** `$$word` (prefix, ends at whitespace), or `$…$` around the secret (allows spaces, but clashes with `$` in prose and shell)? Proposed: `$$word`.
2. **Lifetime.** Deleted when the thread is archived, or kept for the thread's whole life including restarts? Proposed: kept across restarts, deleted on archive.

## Acceptance

- [ ] A message with `$$a $$b` reaches the native session, the journal and the Wardens as `⟦secret:1⟧ ⟦secret:2⟧`; the values appear nowhere in the thread's records.
- [ ] Archive's capture of that session contains no value.
- [ ] `foundry secret pipe 1 -- cat > f` writes the value; `pipe`, `write` and `env` never print it; a bad number fails without echoing anything.
- [ ] The held file is 0600 and is gone after the thread is archived.
- [ ] A tool result containing a held value is scrubbed to its placeholder wherever Foundry already scrubs.
