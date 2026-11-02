# FEAT-005: Paste secrets as `$$word`; the agent uses them from a scratch pad it never reads

**Status**: ✅ Built 2026-11-02 (agent-session 0.10.0, AS-009). Asked for by Aron 2026-11-01; design settled and built 2026-11-02.
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

`secrets.scratchPad: true | false`, default `false`, plus `secrets.privatePaths` (extra globs no agent reads; project globs add to global ones). Like every Foundry setting it can be set for me (personal) or for everyone (the repo's `.foundry/`). On, Foundry:

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

## As built (2026-11-02)

Aron, 2026-11-02: "One dagger per message, with a number for each sub-dagger… It's thread, message, dagger position… We'd make them use it. We should give them a tool to pipe in from the env file. That's what this whole thing is for."

- **References** are thread, message and position: `†<turn>.<n>` in the thread's own messages, `†<thread>/<turn>.<n>` from any other thread, so a pad left behind can be listed (`list` with `thread` or `all`) and used once you have its thread.
- **Two tools**, not one: `secret_scratch` (`list`, `env`, `write`, `consume`) only writes the person's own secret where the agent says, so it never asks (`FOUNDRY_OWN_TOOLS`, Codex pre-approval included); `secret_pipe` runs a shell command, so it keeps the host's mode, like Bash. Why: "Access follows the host": a command the host would ask about still asks.
- **The normal path** is `env` into an env file, then `secret_pipe` from that file (`envFile` + `key`). A file the pad wrote is then off limits to read, search or print, like `.private` paths: the agent pipes from it. The skill `secrets` teaches this; the tool descriptions carry it too.
- **Lifting** happens first in `TurnService.accept`; a lift that fails refuses the turn (503), so a secret never goes through raw. A member's post is never lifted.
- **The block** runs in the tool gate before the structural rules, in every mode, but does not count as a structural rule, so Codex and Muse threads still start; they get the block on the calls they ask about. Codex under full access asks nothing.
- **Cleanup**: the pad goes when its thread is archived; at start, pads of threads archived meanwhile are swept. A dispose without archiving (a restart) keeps it.
- **Settings**: off unless `secrets.scratchPad` is true (global, or per project). `.private` blocking comes with the setting.
- **After review** (adversarial, before merge):
  - **Lift timing.** The lift runs after the turn's own checks (duplicate id, capacity, unknown or archived thread), and a turn that then fails to be recorded takes its secrets out of the pad again. A retried id is refused before anything is lifted.
  - **Where `secret_scratch` writes.** It writes only inside the thread's working directory (real paths, so a symlink out is refused) and never into `.git`, `.claude`, `.codex`, `.foundry`, `.ssh`, `.gnupg`, `.aws`, `.mcp.json` or a `settings*.json`. Anything else goes through `secret_pipe`, which keeps the host's mode. Why: the tool never asks, and "access follows the host".
  - **Who can use a pad.**
    - A pad is reachable only from a thread of the same project (`list` shows only those); an unknown thread's pad is refused.
    - Secrets are used only in a turn the owner's own message opened, with no other party's words in it. This is the same rule as the conversation controls (`ConversationService.ownerInstructed`, CONVERSATIONS.md §4.11).
  - **Failing closed.** If the list of files the pad wrote can't be read, the gate denies every call until it can.
  - **No raw echo.** `POST /api/messages` echoes the message as accepted, not as sent.
  - **Best effort.** The block matches names, not what a command does (`cat .env*`, a recursive search, a pipe into a new file get past it), and Codex and Muse see it only on the calls they ask about. The skill says so: the rule is the agent's to keep.
  - **Held files stay held.** A file the pad wrote stays off limits after its block is consumed, because the file still holds the secret. Editing other keys in that file goes through `secret_scratch env`, or through the person.
  - **Not lifted.** `$$` in an aside or in `/feedback` text: only thread messages are lifted.
- **Not built: sessions outside Foundry.** Aron, 2026-11-02: "this is when you're using Foundry… a setting you can have turned on." Config `sync` writing `.gitignore` entries and Claude `permissions.deny` for sessions outside Foundry was left out: `sync` manages no Claude permissions today, so it would be new machinery for a case he scoped out. The pads live only under Foundry's own directory, which `**/.foundry/*` keeps out of git.
