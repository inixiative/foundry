# FEAT-009: A rejections ledger: every action the agent wasn't allowed to take, in one place

**Status**: 🆕 Not Started (to design when it's close; Aron, 2026-11-01)
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-11-01
**Updated**: 2026-11-01

---

## Why (Aron, 2026-11-01)

"We got to have something that's collecting all the things that it runs into, where it won't let itself act. Dangerous mode is obviously very reckless… We should have a thing for me using Foundry that's tracking rejections." And: "We'll figure that out in the future when we get close."

The goal is to leave full-access ("dangerous") mode for a mode that asks or refuses, without being stopped all the time. That needs a record of what was refused and why, so the rules can be tuned from evidence.

Today this machine's T3 Code runs every thread in `full-access`, T3's default (`DEFAULT_RUNTIME_MODE`, `~/code/t3/packages/contracts/src/providerPolicy.ts:32`). Its other modes are `approval-required`, `auto-accept-edits` and `auto`. Foundry follows the host's mode ("access follows the host", workspace CLAUDE.md, 2026-10-11).

## What exists

| Source of a refusal | Recorded today | Where |
|---|---|---|
| Foundry's structural tool gate (`allow` / `prompt` / `deny` per capability) | Yes: a `gate-request` and a `gate-outcome` journal row per call | `pf/turns/tool-gate.ts:113-150`; `pf/agents/thread-runtime.ts:538` |
| An owner answering a prompt "rejected" | Yes, as the `ActionQueue` resolution | `pc/action-prompt.ts` |
| The native runtime's own refusals: Claude Code auto mode's checks, Codex sandbox and approval policy denials | Not collected | Observed on the native event stream, if at all (`pf/turns/`) |
| The model declining by itself ("I won't run that") | Not collected | — |

## The piece to design

**One ledger view over these sources.** It is not a new store: it reads the journal's gate rows and prompt resolutions, plus the native denials once they are observed. Per thread and across threads it shows:
- what was refused;
- by which layer (gate, runtime, owner, model);
- the rule that refused it;
- how often it recurs.

From a recurring refusal it proposes a rule change ("allow `git push` to this remote"), which the owner accepts or declines.

**Open, to settle when it's close:**
- whether model self-refusals are detectable reliably enough to count;
- whether the proposals are Warden-style pointers or a settings diff;
- how a T3 or Paseo host's own refusals reach Foundry over ACP.

## Related

- workspace CLAUDE.md, "Access follows the host";
- Signets governing agent permissions in future (2026-10-08);
- Oracle (recurring corrections).
