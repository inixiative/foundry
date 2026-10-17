# Feedback

How feedback is given, stored and acted on in Foundry. The design history, hypotheses and the measurement plan (sections L1–L7, H1–H4 cited elsewhere) live in Oracle (`docs/foundry/FEEDBACK-LOOP.md`), with the rest of the evaluation and planning docs.

## Explicit feedback (built 2026-10-16)

> Aron: "Feedback per thread. We should have a global feedback thing, like Forge Master, which tracks all your feedback ... Individual threads can have feedback and they just feed in — it's a duplicate view. For each project we should see feedback at the top of its threads list."

Feedback is **explicit**. What is built today:

- **Giving it.** `/feedback <text>` in the viewer composer (never sent to the model), a message's ⋯ → feedback (aimed at that turn and message), or `/feedback <text>` over ACP. All three call `POST /api/threads/:threadId/feedback` (`text`, optional `turnId`, `messageId`, `tags`); with no `turnId` the item points at the thread's last turn. It is recorded as said: no classifier, routing or tuning prompt. `/correction` is kept: with a decision provider it is classified and tuned as before; without one it is recorded as explicit feedback tagged `correction`.
- **One store.** An item is the same fold over journal rows as before (`feedback/lifecycle.ts`): a `feedback-capture` row with `origin: "explicit"`, its author (the local operator and the surface) and the message it refers to, on the thread and turn it was given on; the thread gives its project. `inbox` is `open` until a `feedback-status` row archives it (`POST /api/feedback/status`, one item or many; unarchive the same way). `GET /api/feedback?status=&projectId=&threadId=` lists newest first. The `feedback` stream carries every change; the rows reach the thread's archive snapshot as phase entries.
- **Three scopes, one list.** The pinned **Feedback** inbox in the left column (after Forge Master): everything, open / archived / all, archive one or many, each item linking to its project, thread and turn. A project's **strip** at the top of its threads (open count; it opens the project's list). The **thread**: a marker on the turn an item refers to, and the thread's list in the detail panel.
- **Detection is opt-in.** `feedback.capture` defaults to false (Settings → Advanced → Feedback turns it on): the detector → classify → route → tune loop of the Lifecycle runs only then. An install that never set it gets the new default.

## Lifecycle

When detection is on, an accepted turn runs foundry-core's correction detector. A hit is classified, routed to the Warden roles it concerns (falling back to `main`), and offered back to the user in a tuning prompt ("what happened / what we did / what we intend"). An applied answer writes a line into the routed role's instructions or domain knowledge, with provenance; undo reverts it. `pf:` means `packages/foundry/src/`.

### What is built

- Capture through foundry-core's detector and classify contract, with one item per rule.
- Matching and recurrence.
- Cartographer routing to Warden roles, falling back to `main`.
- The tuning prompt: `ask` by default, `block`, or `blockOn`. A blocking hold runs while the turn is still queued. A stop withdraws it, and `blockTimeoutMs` bounds it.
- Answers validated through `POST /api/feedback/:id/answer`. An edit replaces the rule's lines.
- `POST /api/feedback/:id/tune` raises a prompt again. `undo` reverts a change.
- Personal-rung role files, invalidated through `invalidateComposition()`.
- Exposure counting, from composed segments only.
- The Feedback view, the `feedback` stream, and the ACP card, ask and `/feedback`.

The rungs follow the thread. The project rung is the configured project directory when the thread's cwd is inside it; otherwise it is the cwd's repository. The org rung is the directory above the project. The composer walks from the filesystem root to the cwd, so those personal files are read from worktrees beneath the project too.

### Data model: journal phases, no parallel store

The authoritative types are `pf:feedback/types.ts`. Every lifecycle fact is an immutable phase record in the local journal: `session_phase` through `LocalSessionStore.appendPhase` (`pf:persistence/local-session-store.ts:524`). It is attached to the thread where it happened. That journal already reaches Archive (`archiveRecords`, `:814`; `pf:archives/capture.ts:163`). An item's current state is a fold over its records. There is no second store and no `feedback_item` memory kind. `PhaseRecordInput.phase` (`pf:agents/thread-runtime.ts:327-340`) gains:

```ts
type FeedbackPhase = 'feedback-capture' | 'feedback-route' | 'feedback-tune' | 'feedback-apply' | 'feedback-revert' | 'feedback-status';

interface FeedbackCaptureRecord {      // phase: feedback-capture (turnId = the user turn)
  itemId: string;                      // newId('fb'); a recurrence carries the matched item's id
  recurred: boolean;
  exposedAtTurn?: boolean;             // recurrence only: was the rule in the routed Warden's segments last turn
  origin: 'detected' | 'intervention' | 'seed' | 'mined' | 'explicit';
  detection?: { kind: 'interrupt' | 'opener' | 'explicit' | 'repeat'; phrase: string; score: number };
  quote: string; before: string;       // bounded, scrubbed
  statement: string; sharp: boolean;
  category: 'approach' | 'scope' | 'convention' | 'fact' | 'other';   // the Prospector's
  tags: string[];                      // FEEDBACK-LOG tags + process
  match: { itemId: string; confidence: number } | null;
  candidateDuplicateOf?: string;
  classifier: { providerId: string; requestHash: string };
}
interface FeedbackRouteRecord {        // phase: feedback-route
  itemId: string;
  roles: string[];                     // Warden/agent ids, or 'main'
  slot: 'instructions' | 'domainKnowledge';
  level: 'computer' | 'org' | 'org-personal' | 'project' | 'project-personal';
  route: { domains: string[]; source: 'model' | 'keyword-fallback' | 'empty-map'; confidence: number };
}
interface FeedbackTuneRecord {         // phase: feedback-tune
  itemId: string; promptId: string;
  mode: 'ask' | 'block' | 'tell';
  shown: { happened: string; did: string; intend: string };
  answer: 'apply' | 'edit' | 'reroute' | 'dismiss' | 'later' | 'timeout' | 'undo';
  by: 'human' | 'policy' | 'timeout';
  surface?: 'viewer' | `acp:${string}`;
  edited?: { statement?: string; roles?: string[]; slot?: string; level?: string };
}
interface FeedbackApplyRecord {        // phase: feedback-apply / feedback-revert
  itemId: string; changeId: string;    // a revert names the changeId it undoes
  role: string; slot: string; level: string;
  path: string; line: string;          // the exact line added or removed
  beforeHash: string; afterHash: string;
}
```

- **Index.** `FeedbackLifecycle` (`pf:feedback/lifecycle.ts`) folds these. On start it is rebuilt from one new store query, `feedbackPhases({ projectId? })`, which reads `session_phase WHERE phase LIKE 'feedback-%'` joined to the thread's project. After that it updates on each append. Uses are counted with a second query (`phasesContaining`) over `advice` and `guard-request` rows stored after the change's `appliedAt` whose record contains `(fb_<id>)`.
- **Edits made outside any turn** (a viewer edit, an undo from the panel) are journalled on the item's origin thread with `turnId: null`. `appendPhase` already allows that.
- **Kingdom stores nothing.** Sharing an item set across Foundries stays open.
