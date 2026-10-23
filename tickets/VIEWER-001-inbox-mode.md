# VIEWER-001: Inbox mode beside directory mode

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-10-23
**Updated**: 2026-10-23

---

## Overview

The viewer's left column is a directory: pinned Global and Forge Master, the projects, and below
them the threads of the selected scope (`packages/foundry/src/viewer/thread-directory.ts`). That is
the right view for finding a thread. It is the wrong view for working across many of them.

Add a second mode and a toggle between the two (Aron, 2026-10-23):

- **Directory mode**: today's column. All projects, all threads, navigate by scope.
- **Inbox mode**: everything active across every project in one list. What is running, and some
  form of "what needs your attention" surfaced ahead of the rest.

## Why (Aron, 2026-10-23)

- Agents spawn threads. A thread an agent started must show up in the inbox as a first-class active
  thread and session, the same as one a person opened.
- Other systems' agents will ask to start a session with you. That incoming request shows up in the
  inbox too, as a thing awaiting your answer.
- One area for everything you are asking about, whoever or whatever started it.

Inbox mode is a filter and a sort over records the viewer already has (thread status `waiting` /
`active` in the directory, pending prompt cards, Warden agent-questions, hand-backs), plus the one
new record kind: an incoming session request from another system.

## Open questions

- What exactly counts as needing attention in inbox mode: pending prompt cards awaiting
  approve/reject, Warden `agent-question` answers, hand-backs, finished turns not yet read? Aron
  described it as "some sort of thing that shows your attention thoughts"; the set is his to name.
- Ordering within the inbox: by recency of activity, or attention items first then running threads?
- Does inbox mode replace the project list entirely, or keep a project filter?
- What carries an incoming session request from another system's agent: Signet, or something new?
  What does accepting one create: a thread in which project?
- Where the toggle lives: header, beside Workspace / Settings / Analytics, or at the top of the
  column?

## Related

- README "Viewer": the current three-panel layout and left-column navigation.
- `packages/foundry/src/viewer/thread-directory.ts`: directory mode as built.
