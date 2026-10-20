/**
 * @atlas
 * @kind service
 * @partOf feature:conversations
 */
import {
  type ActionQueue,
  type ActionResolution,
  type EventStream,
  newId,
  type PromptBlock,
  type Thread,
} from '@inixiative/foundry-core';
import {
  type ConversationMember,
  type HostedSignet,
  selectsThread,
  type ThreadEntry,
  type ThreadHost,
  type ThreadOutcome,
  type ThreadRefusal,
  type ThreadRequestOf,
  type ThreadSubscribeFrame,
  type ThreadSubscription,
  type ThreadsLens,
  threadRefused,
  threadResult,
  threadsResourceKind,
  threadTextLimit,
} from '@inixiative/signet';
import { memberPostReception } from '../agents/chorus-reception';
import type { LocalSessionStore } from '../persistence/local-session-store';
import {
  type HeldThreadSubscription,
  UNKNOWN_HOSTED,
} from '../providers/kingdom-installation-connection';
import type { TurnAcceptance, TurnRequest } from '../turns/turn-service';
import type { ProjectSettingsConfig } from '../viewer/config';
import { conversationFloor, conversationRoster } from './roster';
import { resolveConversationSettings } from './settings';
import {
  type ConversationRecord,
  type ConversationSettings,
  type ConversationWrapper,
  emptyConversation,
  type HeldDeliveryRecord,
  type HeldRecord,
  type HeldResolutionRecord,
  type Invitation,
  MAX_HELD_TEXT,
  type MemberPostRecord,
  OWNER_MEMBER,
} from './types';
import { capView, sameMember, threadEntryOf, visibleTo } from './view';

export interface ConversationServiceDeps {
  store: LocalSessionStore;
  /** A thread this Foundry runs (restored threads included). */
  thread: (threadId: string) => Thread | undefined;
  /**
   * Bring an archived thread back (TurnService.reopen): an admitted post revives it (§4.2). The
   * turn path reopens on its own; a note needs this.
   */
  reopen?: (threadId: string) => void;
  /** Whether `reopen` can bring this archived thread back; one that can't stays closed. */
  canReopen?: (threadId: string) => boolean;
  /** The one turn path; bound once the routes exist. */
  turns: () => {
    accept(request: TurnRequest): TurnAcceptance;
    interrupt(threadId: string, turnId: string): Promise<unknown>;
  } | null;
  /** Owner prompts: held sends and posts wait here (the feedback service's pattern). */
  queue: ActionQueue | null;
  /** The machine's settings for a project (the cascade's personal layer). */
  project: (projectId: string) => ProjectSettingsConfig | undefined;
  /** Every Signet issued on this Foundry's integrations, as of the latest snapshot. */
  hosted: () => readonly HostedSignet[];
  /** Every member view this host is pushing. */
  subscriptions: () => readonly HeldThreadSubscription[];
  /** Journal notices: a member-visible entry may have been written (owner and agent messages). */
  events?: EventStream;
  /** Deliver a released `post` through the held Signet it names (the joining side, `kingdom_post`). */
  deliverPost?: (record: HeldRecord) => Promise<{ executionId?: string; error?: string }>;
  /** The thread list changed for this thread (unread posts, a pause, a held item). */
  changed?: (threadId: string) => void;
  /** The thread's journal changed outside a turn (the viewer re-reads it). */
  journalChanged?: (thread: Thread) => void;
  log?: (message: string) => void;
}

/** A refusal decided inside the admission transaction; a throw rolls the transaction back. */
class Refusal extends Error {
  constructor(
    readonly refusal: ThreadRefusal,
    message?: string,
  ) {
    super(message ?? refusal);
  }
}

const HELD_OPTIONS = [
  { id: 'release', label: 'Release' },
  { id: 'edit', label: 'Edit, then release' },
  { id: 'withdraw', label: 'Withdraw' },
] as const;

interface OpenHeld {
  readonly promptId: string;
  readonly controller: AbortController;
  surface?: string;
}

/** One member of a conversation as the owner sees it (the participants panel, §4.7). */
export interface ConversationMemberView {
  member: ConversationMember;
  displayName: string;
  /** Kingdom lists the Signet on this thread now; false: known only from its posts (revoked, or not yet in a snapshot). */
  listed: boolean;
  recipientModel?: string;
  lens?: Pick<ThreadsLens, 'view' | 'delivery' | 'outbound'>;
  /** The outbound term a send uses now (falls back to `review`, §4.5). */
  outbound: 'review' | 'auto';
  revision?: number;
  limits?: { maxRequests: number | null; maxConcurrent: number; expiresAt: string | null };
  present: boolean;
  lastSeen: string | null;
  holdsConch: boolean;
}

/**
 * The conversation wrapper of a main thread (docs/reference/CONVERSATIONS.md §4): the one post-in
 * point (`thread.prompt`), the one read-off point (`thread.read`, `thread.subscribe`), the floor,
 * held sends, and the notes and turns a post becomes on the thread's existing paths. It is also the
 * `ThreadHost` Kingdom's relayed frames reach over the Installation socket. Admission trusts the
 * frame: Kingdom's admission is the membership check.
 */
export class ConversationService implements ConversationWrapper {
  /** Each live view's cursor: the journal seq it has been pushed through. */
  private readonly cursors = new Map<string, number>();
  /** When each member was last seen on a thread (`<signetId>:<threadId>`): a view opened or closed. */
  private readonly seen = new Map<string, number>();
  /** The newest revision a frame from each member carried (frames are newer than snapshots, §4.5). */
  private readonly accepted = new Map<string, number>();
  private readonly open = new Map<string, OpenHeld>();
  /** Which Signets the previous snapshot listed (null until one listed them). */
  private listed: Set<string> | null = null;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.unsubscribe = deps.events?.subscribe((event) => {
      if (event.kind === 'journal' && 'threadId' in event && event.threadId)
        this.pump(event.threadId);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    for (const open of this.open.values()) open.controller.abort();
    this.open.clear();
  }

  // -----------------------------------------------------------------------
  // The host: Kingdom's relayed frames
  // -----------------------------------------------------------------------

  /** The handlers the Installation socket calls, one per operation (signet 0.5 `ThreadHost`). */
  host(): ThreadHost {
    return {
      'thread.prompt': (frame) => this.admit(frame),
      'thread.read': (frame) => this.read(frame),
      'thread.floor': (frame) => this.floor(frame),
      'prompt.resolve': (frame) => this.resolvePrompt(frame),
      'thread.subscribe': (frame) => this.subscribe(frame),
      ended: (subscription, reason) => this.ended(subscription, reason),
    };
  }

  /**
   * The post-in point (§4.2). One synchronous transaction, no `await` inside: the thread is open,
   * the post is new, the conversation isn't paused, the depth bound holds, the floor admits it;
   * then the post is recorded and, for `turn`, accepted on the thread's turn path in the same
   * transaction. Floor and depth are judged here, at admission, never later.
   */
  admit(frame: ThreadRequestOf<'thread.prompt'>): ThreadOutcome<'thread.prompt'> {
    const { input, signetId, lens } = frame;
    const thread = this.deps.thread(input.threadId);
    const closed = this.closedReason(thread);
    if (closed || !thread) return threadRefused(closed ?? 'unknown_thread');
    this.noteRevision(signetId, frame.acceptedRevision);
    const me: ConversationMember = { kind: 'signet', id: signetId };
    let outcome:
      | { kind: 'refused'; refusal: ThreadRefusal; message?: string }
      | { kind: 'duplicate'; seq: number }
      | { kind: 'admitted'; seq: number; post: MemberPostRecord };
    try {
      outcome = this.deps.store.transaction(() => {
        const prior = this.deps.store
          .phasesOf(thread.id, 'member-post', { key: 'postId', value: input.postId })
          .find((row) => (row.record as unknown as MemberPostRecord).signetId === signetId);
        if (prior)
          return { kind: 'duplicate' as const, seq: this.deps.store.phaseSeq(prior.id) ?? 0 };
        const record = this.record(thread.id);
        const settings = this.settings(thread, record);
        if (this.paused(thread.id, record))
          return { kind: 'refused' as const, refusal: 'conversation_paused' as const };
        // A post that wakes the agent is two agent turns: the member's, and the agent's answer. A
        // post that would go past the bound is refused, and the conversation pauses.
        const depth = this.depth(thread.id, record);
        const cost = lens.delivery === 'turn' ? 2 : 1;
        if (depth + cost > settings.maxAgentTurns) {
          // At the bound the conversation pauses; a `turn` post with one turn left is refused
          // alone, so a note may still take that turn.
          if (depth >= settings.maxAgentTurns) this.pause(thread, record, 'depth');
          return { kind: 'refused' as const, refusal: 'conversation_paused' as const };
        }
        const floor = this.takeFloor(record, settings, me, input.inReplyTo);
        if (floor.refusal) {
          // A conch that lapsed at this admission is the host's now, refused or not.
          if (floor.changed) this.save(thread, record);
          return { kind: 'refused' as const, refusal: floor.refusal };
        }
        const phaseId = newId('phase');
        const turnId = lens.delivery === 'turn' ? newId('turn') : undefined;
        const post: MemberPostRecord = {
          postId: input.postId,
          signetId,
          displayName: frame.member.displayName,
          text: input.text,
          delivery: lens.delivery,
          executionId: frame.requestId,
          acceptedRevision: frame.acceptedRevision,
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
          ...(turnId ? { turnId } : {}),
        };
        this.deps.store.appendPhase(thread, {
          id: phaseId,
          phase: 'member-post',
          turnId: null,
          dispatchId: null,
          record: post as unknown as Record<string, unknown>,
        });
        const seq = this.deps.store.phaseSeq(phaseId)!;
        if (depth + cost >= settings.maxAgentTurns) this.pause(thread, record, 'depth');
        else this.save(thread, record);
        if (turnId) {
          const turns = this.deps.turns();
          if (!turns) throw new Refusal('failed', 'This Foundry takes no turns now');
          const accepted = turns.accept({
            threadId: thread.id,
            turnId,
            payload: input.text,
            origin: {
              member: me,
              displayName: frame.member.displayName,
              postId: input.postId,
              executionId: frame.requestId,
            },
          });
          if (!accepted.ok)
            // Closed was decided above; a 409 here is a busy host (live capacity), not a closed thread.
            throw new Refusal(
              accepted.status === 404 ? 'unknown_thread' : 'failed',
              String(accepted.body.error ?? 'The turn was not accepted'),
            );
        }
        return { kind: 'admitted' as const, seq, post };
      });
    } catch (error) {
      if (error instanceof Refusal) return threadRefused(error.refusal, error.message);
      throw error;
    }
    if (outcome.kind === 'refused') {
      this.deps.changed?.(thread.id);
      return threadRefused(outcome.refusal, outcome.message);
    }
    if (outcome.kind === 'duplicate')
      return threadResult({ accepted: true as const, journalSeq: outcome.seq, duplicate: true });
    // An archived thread is revived by an admitted post (a `turn` post was reopened by the turn
    // path already); from here on its live object is the one the runtime runs.
    if (thread.disposed) this.deps.reopen?.(thread.id);
    const live = this.deps.thread(thread.id) ?? thread;
    this.pump(thread.id);
    this.deps.journalChanged?.(live);
    this.deps.changed?.(thread.id);
    // A note is content the thread takes in: the chorus is asked between turns (§4.2, the
    // `consumed` moment), and what it says rides the next turn with the note.
    if (outcome.post.delivery === 'note' && !live.disposed)
      void live.signals
        .emit({
          id: newId('sig-member-post'),
          kind: 'member_post',
          source: `conversation:${signetId}`,
          // Ids only: the bus reaches the Librarian's thread-state, which must never carry member
          // text. The runtime reads the labelled post through the wrapper (`notePost`).
          content: { threadId: thread.id, signetId, postId: outcome.post.postId },
          timestamp: Date.now(),
        })
        .catch((error: unknown) =>
          this.deps.log?.(
            `[Conversations] Warden pass on a member note not started: ${(error as Error).message}`,
          ),
        );
    return threadResult({ accepted: true as const, journalSeq: outcome.seq, duplicate: false });
  }

  /** `thread.read`: the member's view after `afterSeq`, oldest first, cut at the read cap (§4.7). */
  read(frame: ThreadRequestOf<'thread.read'>): ThreadOutcome<'thread.read'> {
    const thread = this.deps.thread(frame.input.threadId);
    if (!thread) return threadRefused('unknown_thread');
    this.noteRevision(frame.signetId, frame.acceptedRevision);
    this.seen.set(`${frame.signetId}:${thread.id}`, Date.now());
    const after = frame.input.afterSeq ?? 0;
    const raw = this.deps.store.journalEntries(thread.id, { after, limit: RAW_READ });
    const entries = raw
      .map(threadEntryOf)
      .filter((entry): entry is ThreadEntry => !!entry && visibleTo(entry, frame));
    const more = raw.length === RAW_READ;
    return threadResult(
      capView(
        entries,
        more ? raw.at(-1)!.seq : this.deps.store.journalSeq(thread.id),
        'forward',
        more,
      ),
    );
  }

  /**
   * `thread.subscribe`: the member's live view, atomically. The socket registered the subscription
   * before this runs and holds what is pushed meanwhile; the view's `journalSeq` is where both start.
   */
  subscribe(frame: ThreadSubscribeFrame): ThreadOutcome<'thread.subscribe'> {
    const thread = this.deps.thread(frame.threadId);
    if (!thread) return threadRefused('unknown_thread');
    this.noteRevision(frame.signetId, frame.acceptedRevision);
    const journalSeq = this.deps.store.journalSeq(thread.id);
    const raw = this.deps.store.journalEntries(thread.id, { newest: true, limit: RAW_READ });
    const entries = raw
      .map(threadEntryOf)
      .filter((entry): entry is ThreadEntry => !!entry && visibleTo(entry, frame));
    this.cursors.set(frame.requestId, journalSeq);
    this.seen.set(`${frame.signetId}:${thread.id}`, Date.now());
    this.deps.changed?.(thread.id);
    return threadResult(capView(entries, journalSeq, 'newest', raw.length === RAW_READ));
  }

  /** A member's view closed (left, lease lapsed, socket dropped): it stops being pushed. */
  ended(subscription: ThreadSubscription, _reason: string): void {
    this.cursors.delete(subscription.subscriptionId);
    this.seen.set(`${subscription.signetId}:${subscription.threadId}`, Date.now());
    this.deps.changed?.(subscription.threadId);
  }

  /**
   * Push what each live view hasn't had yet, filtered to its lens. The socket numbers appends
   * densely per view and skips what the snapshot covered, so pushing twice is harmless.
   */
  pump(threadId: string): void {
    const live = this.deps.subscriptions();
    // A subscribe the socket refused never reports `ended`: its cursor goes with it here.
    const ids = new Set(live.map((view) => view.subscriptionId));
    for (const id of this.cursors.keys()) if (!ids.has(id)) this.cursors.delete(id);
    const views = live.filter(
      (view) => view.threadId === threadId && this.cursors.has(view.subscriptionId),
    );
    if (!views.length) return;
    const from = Math.min(...views.map((view) => this.cursors.get(view.subscriptionId)!));
    const raw = this.deps.store.journalEntries(threadId, { after: from, limit: 10_000 });
    if (!raw.length) return;
    for (const row of raw) {
      const entry = threadEntryOf(row);
      if (!entry) continue;
      for (const view of views)
        if (row.seq > this.cursors.get(view.subscriptionId)! && visibleTo(entry, view))
          view.append(entry);
    }
    const last = raw.at(-1)!.seq;
    for (const view of views) this.cursors.set(view.subscriptionId, last);
  }

  /** `thread.floor`: ask for the conch, pass it, or release it, decided in one transaction (§4.3). */
  floor(frame: ThreadRequestOf<'thread.floor'>): ThreadOutcome<'thread.floor'> {
    const thread = this.deps.thread(frame.input.threadId);
    const closed = this.closedReason(thread);
    if (closed || !thread) return threadRefused(closed ?? 'unknown_thread');
    this.noteRevision(frame.signetId, frame.acceptedRevision);
    const me: ConversationMember = { kind: 'signet', id: frame.signetId };
    const action = frame.input.floor;
    let outcome: ThreadRefusal | null;
    try {
      outcome = this.deps.store.transaction(() => {
        const record = this.record(thread.id);
        const settings = this.settings(thread, record);
        const lapsed = this.dropLapsedConch(record);
        if (settings.floor !== 'conch') {
          if (lapsed) this.save(thread, record);
          return action.action === 'request' ? null : ('floor_denied' as const);
        }
        const conch = record.invitations.find((invitation) => invitation.standing);
        if (action.action === 'request') {
          if (!record.requests.some((request) => sameMember(request.member, me)))
            record.requests.push({
              member: me,
              displayName: frame.member.displayName,
              at: new Date().toISOString(),
            });
          this.save(thread, record);
          return null;
        }
        if (!conch || !sameMember(conch.to, me)) {
          if (lapsed) this.save(thread, record);
          return 'floor_denied' as const;
        }
        if (action.action === 'release') this.moveConch(record, settings, null, me);
        else {
          if (action.to.kind === 'local-herald')
            throw new Refusal('invalid_request', 'The conch passes to a member or to the owner');
          if (action.to.kind === 'signet' && !this.isMember(thread.id, action.to.id))
            throw new Refusal(
              'invalid_request',
              'The conch can pass only to a member of this conversation',
            );
          this.moveConch(record, settings, action.to.kind === 'owner' ? null : action.to, me);
        }
        this.save(thread, record);
        return null;
      });
    } catch (error) {
      if (error instanceof Refusal) return threadRefused(error.refusal, error.message);
      throw error;
    }
    this.deps.changed?.(thread.id);
    if (outcome) return threadRefused(outcome);
    return threadResult(this.floorState(thread));
  }

  /**
   * `prompt.resolve`: the owner's remote client answers a held prompt of this thread: a tool-gate
   * ask, or a held send, which is validated the way the viewer's answer is.
   */
  resolvePrompt(frame: ThreadRequestOf<'prompt.resolve'>): ThreadOutcome<'prompt.resolve'> {
    const { threadId, promptId, answer } = frame.input;
    if (!this.deps.thread(threadId)) return threadRefused('unknown_thread');
    const queue = this.deps.queue;
    const prompt = queue?.get(promptId);
    if (!queue || !prompt || prompt.status !== 'pending' || prompt.threadId !== threadId)
      return threadRefused('invalid_request', 'No pending prompt with that id on this thread');
    const held = (prompt.meta?.conversationHeld as { heldId?: string } | undefined)?.heldId;
    try {
      if (held) this.submitHeld(held, answer.action, answer.input, 'remote');
      else if (typeof prompt.meta?.toolName === 'string') {
        const allowed =
          prompt.kind === 'approval'
            ? ['approved', 'rejected']
            : (prompt.options ?? []).map((option) => option.id);
        if (!allowed.includes(answer.action))
          return threadRefused(
            'invalid_request',
            `${answer.action} is not an answer this prompt offers`,
          );
        if (!queue.resolve(promptId, answer.action, { by: 'human', input: answer.input }))
          return threadRefused('invalid_request', 'The prompt was already answered');
      } else
        return threadRefused(
          'invalid_request',
          'Only a tool-call ask or a held send can be answered remotely',
        );
    } catch (error) {
      return threadRefused('invalid_request', (error as Error).message);
    }
    return threadResult({ resolved: true as const });
  }

  // -----------------------------------------------------------------------
  // The main agent's tools (send_to_member, pass_conch) and the joining side (kingdom_post)
  // -----------------------------------------------------------------------

  /**
   * `send_to_member`: the only thing addressed to a member, itself a main-thread entry (§4.5). The
   * member's outbound term, from the latest snapshot (falling back to `review`), is enforced here:
   * `auto` writes a released send; `review` writes a pending one and asks the owner. Returns at once.
   */
  send(threadId: string, member: string, text: string): string {
    const thread = this.deps.thread(threadId);
    if (!thread || this.closedReason(thread)) throw Error('This thread is not open');
    const target = this.findMember(threadId, member);
    const body = boundedText(text);
    const outbound = this.outbound(target.member.id, threadId);
    this.hold(thread, {
      kind: 'send',
      text: body,
      outbound,
      to: target.member,
      toName: target.displayName,
    });
    return outbound === 'auto'
      ? `Sent to ${target.displayName}.`
      : `Held for the owner's review before it reaches ${target.displayName}; you'll see nothing back until it is released.`;
  }

  /** `pass_conch`: the main agent passes the conch, only when `conch.agentMayPass` (§4.3). */
  passConch(threadId: string, member: string | null): string {
    const thread = this.deps.thread(threadId);
    if (!thread || this.closedReason(thread)) throw Error('This thread is not open');
    const record = this.record(thread.id);
    const settings = this.settings(thread, record);
    if (settings.floor !== 'conch') throw Error('This conversation does not use the conch');
    if (!settings.conch.agentMayPass)
      throw Error(
        'The owner has not let the agent pass the conch (conversations.conch.agentMayPass)',
      );
    const to = member === null ? null : this.findMember(threadId, member);
    this.giveConch(thread.id, to?.member ?? null);
    return to ? `The conch is with ${to.displayName}.` : 'The conch is with the host.';
  }

  /**
   * `kingdom_post`, on the joining side: a post into a conversation this Foundry joined through a
   * Signet it holds. Held for this owner first (pending + prompt), always; delivered on release.
   */
  holdPost(
    threadId: string,
    post: { accessId: string; remoteThreadId: string; text: string; inReplyTo?: string },
  ): string {
    const thread = this.deps.thread(threadId);
    if (!thread || this.closedReason(thread)) throw Error('This thread is not open');
    this.hold(thread, {
      kind: 'post',
      text: boundedText(post.text),
      outbound: 'review',
      accessId: post.accessId,
      remoteThreadId: post.remoteThreadId,
      postId: crypto.randomUUID(),
      ...(post.inReplyTo ? { inReplyTo: post.inReplyTo } : {}),
    });
    return "Held for the owner's review; it is posted once released.";
  }

  /**
   * Answer a held item's open prompt, validated first (an option it offers; an edit carries text).
   * Only a valid answer settles the prompt (the feedback service's `submit`).
   */
  submitHeld(heldId: string, action: string, input?: string, surface?: string): void {
    const open = this.open.get(heldId);
    if (!open) throw Error('No open prompt for this held item');
    if (!HELD_OPTIONS.some((option) => option.id === action))
      throw Error(`${action} is not an answer this prompt offers`);
    if (action === 'edit') boundedText(input ?? '');
    if (surface) open.surface = surface;
    if (!this.deps.queue?.resolve(open.promptId, action, { by: 'human', input }))
      throw Error('The prompt was already answered');
  }

  /** Raise every held item's prompt again: at startup, a pending item survives in the journal (§4.5). */
  raisePending(): number {
    let raised = 0;
    for (const row of this.deps.store.pendingHeld()) {
      const thread = this.deps.thread(row.threadId);
      const record = row.record as unknown as HeldRecord;
      if (!thread || this.open.has(record.heldId)) continue;
      this.raise(thread, record);
      raised++;
    }
    return raised;
  }

  // -----------------------------------------------------------------------
  // The owner's side (viewer)
  // -----------------------------------------------------------------------

  /** Set the thread's floor mode (its own override, the last step of the cascade). */
  setFloor(threadId: string, mode: ConversationSettings['floor'] | null): void {
    const thread = this.requireThread(threadId);
    this.deps.store.transaction(() => {
      const record = this.record(thread.id);
      if (mode) record.settings.floor = mode;
      else delete record.settings.floor;
      const floor = this.settings(thread, record).floor;
      if (floor !== 'conch') {
        record.invitations = record.invitations.filter((invitation) => !invitation.standing);
        record.requests = [];
      }
      // Reply invitations belong to the mode that made them; they don't come back with it.
      if (floor !== 'speak-when-spoken-to')
        record.invitations = record.invitations.filter((invitation) => invitation.standing);
      this.save(thread, record);
    });
    this.deps.changed?.(threadId);
  }

  /** The owner gives the conch to a member, or takes it back (null: the host holds it). */
  giveConch(threadId: string, to: ConversationMember | null): void {
    const thread = this.requireThread(threadId);
    this.deps.store.transaction(() => {
      const record = this.record(thread.id);
      const settings = this.settings(thread, record);
      if (settings.floor !== 'conch') throw Error('This conversation does not use the conch');
      if (to?.kind === 'signet' && !this.isMember(thread.id, to.id))
        throw Error('The conch can pass only to a member of this conversation');
      this.dropLapsedConch(record);
      this.moveConch(record, settings, to?.kind === 'signet' ? to : null, OWNER_MEMBER);
      this.save(thread, record);
    });
    this.deps.changed?.(threadId);
  }

  /** The owner resumes a paused conversation: the depth count restarts here. */
  resume(threadId: string): void {
    const thread = this.requireThread(threadId);
    this.deps.store.transaction(() => {
      const record = this.record(thread.id);
      delete record.paused;
      record.resumedAtSeq = this.deps.store.journalSeq(thread.id);
      this.save(thread, record);
    });
    this.deps.changed?.(threadId);
  }

  /** The owner pauses the conversation: members are refused until a resume. */
  pauseByOwner(threadId: string): void {
    const thread = this.requireThread(threadId);
    this.deps.store.transaction(() => this.pause(thread, this.record(thread.id), 'owner'));
    this.deps.changed?.(threadId);
  }

  // -----------------------------------------------------------------------
  // The thread's runtime and the viewer read these
  // -----------------------------------------------------------------------

  /**
   * A conversation thread is always wrapped: its notes and its roster must reach the executor
   * (§4.1). It is one once its wrapper has state, or as soon as a grant selects it (a member joined
   * and hasn't posted yet).
   */
  wraps(threadId: string): boolean {
    return (
      this.deps.store.conversation(threadId) !== undefined ||
      this.deps.hosted().some((signet) => this.grantOn(signet, threadId) !== undefined)
    );
  }

  /**
   * The roster the main agent reads ("F1 follow-ups"): who is in, and each member's lens in plain
   * words. Read on every turn of a conversation thread, so a join, a leave or a revision reaches the
   * next turn. `held`: the thread's context already carries a roster, so one is due even when no
   * member is left.
   */
  roster(threadId: string, held = false): string | undefined {
    if (!held && !this.wraps(threadId)) return undefined;
    if (!this.deps.thread(threadId)) return undefined;
    return conversationRoster(
      this.members(threadId).map((member) => ({
        id: member.member.id,
        displayName: member.displayName,
        listed: member.listed,
        ...(member.recipientModel ? { recipientModel: member.recipientModel } : {}),
        ...(member.lens
          ? { lens: { view: member.lens.view, delivery: member.lens.delivery } }
          : {}),
        outbound: member.outbound,
      })),
    );
  }

  /** The floor now (mode, conch, reply invitations, a pause), for the turn being sent. */
  floorNow(threadId: string): string | undefined {
    if (!this.wraps(threadId)) return undefined;
    const thread = this.deps.thread(threadId);
    if (!thread) return undefined;
    const record = this.record(threadId);
    const floor = this.floorState(thread);
    const now = Date.now();
    const members = this.members(threadId);
    const name = (id: string) =>
      members.find((member) => member.member.id === id)?.displayName ?? id;
    const invited = new Map<string, number>();
    for (const invitation of record.invitations)
      if (
        !invitation.standing &&
        invitation.to.kind === 'signet' &&
        (!invitation.expiresAt || Date.parse(invitation.expiresAt) > now)
      )
        invited.set(invitation.to.id, (invited.get(invitation.to.id) ?? 0) + 1);
    return conversationFloor({
      floor: floor.mode,
      conch:
        floor.holder?.kind === 'signet'
          ? { holder: name(floor.holder.id), expiresAt: floor.expiresAt }
          : null,
      invited: [...invited].map(([id, invitations]) => ({ displayName: name(id), invitations })),
      paused:
        this.paused(threadId, record) && record.paused ? { reason: record.paused.reason } : null,
    });
  }

  /**
   * The member notes that ride an owner's turn (§4.2, §4.5): every note not yet delivered or
   * withdrawn, written before this turn's message, labelled. Each one is marked delivered to this
   * turn (`member-post-delivered`), so a note whose owner turn never ran (stopped while queued,
   * dropped at a restart) rides the next one instead of reading as consumed.
   */
  deliverNotes(threadId: string, turnId: string | undefined): PromptBlock[] {
    if (!turnId || !this.wraps(threadId)) return [];
    const store = this.deps.store;
    const seq = store.turnMessageSeq(turnId);
    if (seq === undefined || store.lastOwnerSeq(threadId, seq) !== seq) return [];
    const thread = this.deps.thread(threadId);
    if (!thread) return [];
    const notes = this.pendingNotes(threadId, seq);
    if (notes.length)
      store.transaction(() => {
        for (const post of notes)
          store.appendPhase(thread, {
            id: newId('phase'),
            phase: 'member-post-delivered',
            turnId,
            dispatchId: null,
            record: { postId: post.postId, signetId: post.signetId },
          });
      });
    if (notes.length) this.deps.changed?.(threadId);
    return notes.map((post) => ({
      role: 'content' as const,
      id: `member-post:${post.signetId}:${post.postId}`,
      source: `conversation:${post.signetId}`,
      placement: 'after-message' as const,
      text: memberPostReception(post.displayName, post.text),
    }));
  }

  /** One admitted post, labelled, for the Wardens' pass on it (ids travel on the bus, never text). */
  notePost(
    threadId: string,
    signetId: string,
    postId: string,
  ): { displayName: string; text: string } | undefined {
    const post = this.deps.store
      .phasesOf(threadId, 'member-post', { key: 'postId', value: postId })
      .map((row) => row.record as unknown as MemberPostRecord)
      .find((candidate) => candidate.signetId === signetId);
    return post
      ? { displayName: post.displayName, text: memberPostReception(post.displayName, post.text) }
      : undefined;
  }

  /** What the sessions list shows for a conversation thread: derived from the journal, no new state. */
  summary(
    threadId: string,
  ): { unread: number; paused: boolean; held: number; members: number } | undefined {
    const record = this.deps.store.conversation<ConversationRecord>(threadId);
    if (!record) return undefined;
    return {
      unread: this.pendingNotes(threadId).length,
      paused: this.paused(threadId, record),
      held: this.heldPending(threadId).length,
      members: this.members(threadId).length,
    };
  }

  /** The participants panel (§4.7): members and their terms, the floor, posts, held items. */
  view(threadId: string) {
    const thread = this.requireThread(threadId);
    const record = this.record(threadId);
    const { settings, floorFrom } = this.resolved(thread, record);
    const withdrawn = this.marked(threadId, 'member-post-withdrawn');
    const delivered = this.marked(threadId, 'member-post-delivered');
    const posts = this.posts(threadId).map(({ seq, storedAt, post }) => {
      const key = postKey(post);
      return {
        journalSeq: seq,
        at: new Date(storedAt).toISOString(),
        member: { kind: 'signet' as const, id: post.signetId },
        displayName: post.displayName,
        text: post.text,
        delivery: post.delivery,
        unread: post.delivery === 'note' && !delivered.has(key) && !withdrawn.has(key),
        withdrawn: withdrawn.has(key),
      };
    });
    return {
      threadId,
      conversation: this.wraps(threadId),
      settings,
      floorFrom,
      // The mode the thread would have without its own override.
      inherited: this.resolved(thread, {
        ...record,
        settings: { ...record.settings, floor: undefined },
      }).settings.floor,
      floor: this.floorState(thread),
      requests: settings.floor === 'conch' ? record.requests : [],
      paused: this.paused(threadId, record) ? (record.paused ?? null) : null,
      depth: { count: this.depth(threadId, record), max: settings.maxAgentTurns },
      members: this.members(threadId),
      posts,
      held: this.heldPending(threadId).map((held) => ({
        ...held,
        promptId: this.open.get(held.heldId)?.promptId ?? null,
      })),
    };
  }

  /**
   * The snapshot's Signets changed. A member a previous snapshot listed and this one doesn't is
   * revoked (or narrowed off): its queued turns and unread notes are cancelled (§5.7). One this
   * package couldn't read is not gone; a missing list says nothing.
   */
  hostedChanged(hosted: readonly HostedSignet[], dropped: ReadonlySet<string>): void {
    if (dropped.has(UNKNOWN_HOSTED)) return;
    const now = new Set(hosted.map((signet) => signet.signetId));
    const before = this.listed;
    this.listed = new Set([...now, ...[...dropped].filter((id) => before?.has(id))]);
    if (before)
      for (const signetId of before)
        if (!now.has(signetId) && !dropped.has(signetId)) void this.cancelMember(signetId);
    for (const threadId of this.deps.store.conversationThreads()) this.deps.changed?.(threadId);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private requireThread(threadId: string): Thread {
    const thread = this.deps.thread(threadId);
    if (!thread) throw Error('Thread not found');
    return thread;
  }

  private closedReason(thread: Thread | undefined): ThreadRefusal | null {
    // An observed subagent's thread is a record of native work, not a conversation anyone joins.
    if (!thread || thread.meta.spawn?.observed) return 'unknown_thread';
    // An archived thread is not closed to its members: an admitted post brings it back (§4.2,
    // Aron 2026-10-20), when it can be rebuilt. One that can't, or one disposed otherwise (its
    // project removed), is closed.
    if (thread.disposed && !(thread.meta.status === 'archived' && this.deps.canReopen?.(thread.id)))
      return 'thread_closed';
    return null;
  }

  private record(threadId: string): ConversationRecord {
    return this.deps.store.conversation<ConversationRecord>(threadId) ?? emptyConversation();
  }

  private save(thread: Thread, record: ConversationRecord): void {
    this.deps.store.saveConversation(thread, record);
  }

  private resolved(thread: Thread, record: ConversationRecord) {
    const projectId = thread.meta.projectId;
    return resolveConversationSettings(
      projectId ? this.deps.project(projectId) : undefined,
      record.settings,
    );
  }

  private settings(thread: Thread, record: ConversationRecord): ConversationSettings {
    return this.resolved(thread, record).settings;
  }

  /** In effect: an owner pause until a resume; a depth pause until the owner's next message or a resume. */
  private paused(threadId: string, record: ConversationRecord): boolean {
    const paused = record.paused;
    if (!paused) return false;
    if (paused.reason === 'owner') return true;
    return this.deps.store.lastOwnerSeq(threadId) < paused.atSeq;
  }

  private pause(thread: Thread, record: ConversationRecord, reason: 'depth' | 'owner'): void {
    record.paused = {
      reason,
      at: new Date().toISOString(),
      atSeq: this.deps.store.journalSeq(thread.id),
    };
    this.save(thread, record);
  }

  /**
   * Agent turns since the owner last spoke (or resumed), from the journal (§4.4): each member post
   * counts one, and a post that wakes the agent counts its answer too.
   */
  private depth(threadId: string, record: ConversationRecord): number {
    const from = Math.max(this.deps.store.lastOwnerSeq(threadId), record.resumedAtSeq ?? 0);
    return this.posts(threadId, from).reduce(
      (count, { post }) => count + (post.delivery === 'turn' ? 2 : 1),
      0,
    );
  }

  /** A conch whose time ran out belongs to the host (lazy expiry, checked on arrival). */
  private dropLapsedConch(record: ConversationRecord): boolean {
    const now = Date.now();
    const before = record.invitations.length;
    record.invitations = record.invitations.filter(
      (invitation) =>
        !invitation.standing || !invitation.expiresAt || Date.parse(invitation.expiresAt) > now,
    );
    return record.invitations.length !== before;
  }

  /** The floor at admission (§4.3): talk admits; a reply consumes its invitation; only the conch's holder posts. */
  private takeFloor(
    record: ConversationRecord,
    settings: ConversationSettings,
    me: ConversationMember,
    inReplyTo: string | undefined,
  ): { refusal?: ThreadRefusal; changed: boolean } {
    const changed = this.dropLapsedConch(record);
    if (settings.floor === 'talk') return { changed };
    if (settings.floor === 'speak-when-spoken-to') {
      const now = Date.now();
      const invitation = inReplyTo
        ? record.invitations.find(
            (candidate) =>
              !candidate.standing &&
              candidate.id === inReplyTo &&
              sameMember(candidate.to, me) &&
              (!candidate.expiresAt || Date.parse(candidate.expiresAt) > now),
          )
        : undefined;
      if (!invitation) return { refusal: 'not_invited', changed };
      record.invitations = record.invitations.filter((candidate) => candidate !== invitation);
      return { changed: true };
    }
    const conch = record.invitations.find((invitation) => invitation.standing);
    return conch && sameMember(conch.to, me) ? { changed } : { refusal: 'floor_denied', changed };
  }

  private moveConch(
    record: ConversationRecord,
    settings: ConversationSettings,
    to: ConversationMember | null,
    by: ConversationMember,
  ): void {
    record.invitations = record.invitations.filter((invitation) => !invitation.standing);
    if (to) {
      record.invitations.push({
        id: newId('conch'),
        to,
        by,
        standing: true,
        expiresAt: new Date(Date.now() + settings.conch.holdSeconds * 1000).toISOString(),
      } satisfies Invitation);
      record.requests = record.requests.filter((request) => !sameMember(request.member, to));
    }
  }

  private floorState(thread: Thread) {
    const record = this.record(thread.id);
    const settings = this.settings(thread, record);
    const now = Date.now();
    const conch =
      settings.floor === 'conch'
        ? record.invitations.find(
            (invitation) =>
              invitation.standing &&
              (!invitation.expiresAt || Date.parse(invitation.expiresAt) > now),
          )
        : undefined;
    return {
      mode: settings.floor,
      holder: conch?.to ?? null,
      expiresAt: conch?.expiresAt ?? null,
    };
  }

  /** A newer revision than the snapshot has: a send waits for review until the snapshot catches up. */
  private noteRevision(signetId: string, revision: number): void {
    if ((this.accepted.get(signetId) ?? 0) < revision) this.accepted.set(signetId, revision);
  }

  /** The newest revision any frame from this member carried, kept in the journal across restarts. */
  private acceptedRevision(signetId: string, threadId: string): number {
    let revision = this.accepted.get(signetId) ?? 0;
    for (const row of this.deps.store.phasesOf(threadId, 'member-post', {
      key: 'signetId',
      value: signetId,
    }))
      revision = Math.max(revision, (row.record as unknown as MemberPostRecord).acceptedRevision);
    return revision;
  }

  private grantOn(signet: HostedSignet, threadId: string): ThreadsLens | undefined {
    for (const grant of signet.resources)
      if (
        grant.kind === threadsResourceKind &&
        'threads' in grant.lens &&
        selectsThread(grant.lens.threads, threadId)
      )
        return grant.lens;
    return undefined;
  }

  /**
   * The member's outbound term for a send now (§4.5): from the latest snapshot, or `review` when the
   * member is missing there or the snapshot is older than a frame the member sent. A stale term can
   * only make a send more careful.
   */
  private outbound(signetId: string, threadId: string): 'review' | 'auto' {
    const signet = this.deps.hosted().find((candidate) => candidate.signetId === signetId);
    if (!signet || signet.revision < this.acceptedRevision(signetId, threadId)) return 'review';
    return this.grantOn(signet, threadId)?.outbound ?? 'review';
  }

  private isMember(threadId: string, signetId: string): boolean {
    return this.members(threadId).some((member) => member.member.id === signetId);
  }

  /** Members of a thread: Signets whose grant selects it, and anyone who has posted to it. */
  members(threadId: string): ConversationMemberView[] {
    const views = new Map<string, ConversationMemberView>();
    const present = new Set(
      this.deps
        .subscriptions()
        .filter((view) => view.threadId === threadId && this.cursors.has(view.subscriptionId))
        .map((view) => view.signetId),
    );
    const record = this.deps.store.conversation<ConversationRecord>(threadId);
    const now = Date.now();
    const holder = record?.invitations.find(
      (invitation) =>
        invitation.standing && (!invitation.expiresAt || Date.parse(invitation.expiresAt) > now),
    )?.to;
    const lastPost = new Map<string, number>();
    for (const row of this.deps.store.phasesOf(threadId, 'member-post')) {
      const post = row.record as unknown as MemberPostRecord;
      lastPost.set(post.signetId, row.storedAt);
      if (!views.has(post.signetId))
        views.set(post.signetId, {
          member: { kind: 'signet', id: post.signetId },
          displayName: post.displayName,
          listed: false,
          outbound: 'review',
          present: false,
          lastSeen: null,
          holdsConch: false,
        });
    }
    for (const signet of this.deps.hosted()) {
      const lens = this.grantOn(signet, threadId);
      if (!lens) continue;
      views.set(signet.signetId, {
        member: { kind: 'signet', id: signet.signetId },
        displayName: signet.recipient.displayName,
        listed: true,
        recipientModel: signet.recipient.recipientModel,
        lens: { view: lens.view, delivery: lens.delivery, outbound: lens.outbound },
        outbound: 'review',
        revision: signet.revision,
        limits: {
          maxRequests: signet.maxRequests,
          maxConcurrent: signet.maxConcurrent,
          expiresAt: signet.expiresAt,
        },
        present: false,
        lastSeen: null,
        holdsConch: false,
      });
    }
    for (const view of views.values()) {
      const id = view.member.id;
      view.outbound = this.outbound(id, threadId);
      view.present = present.has(id);
      const last = Math.max(this.seen.get(`${id}:${threadId}`) ?? 0, lastPost.get(id) ?? 0);
      view.lastSeen = view.present
        ? new Date().toISOString()
        : last
          ? new Date(last).toISOString()
          : null;
      view.holdsConch = sameMember(holder ?? null, view.member);
    }
    return [...views.values()];
  }

  /** A member named by its Signet id or its display name, among this thread's members. */
  private findMember(threadId: string, name: string): ConversationMemberView {
    const members = this.members(threadId);
    const exact = members.find((member) => member.member.id === name);
    if (exact) return exact;
    const named = members.filter(
      (member) => member.displayName.toLowerCase() === name.trim().toLowerCase(),
    );
    if (named.length === 1) return named[0]!;
    if (named.length > 1)
      throw Error(
        `Several members are called ${name}; name one by its id (${named.map((m) => m.member.id).join(', ')})`,
      );
    throw Error(
      members.length
        ? `${name} is not a member of this conversation (members: ${members.map((m) => `${m.displayName} (${m.member.id})`).join(', ')})`
        : 'This thread has no conversation members',
    );
  }

  /** Posts a `member-post-withdrawn` or `member-post-delivered` row settles, by `signetId:postId`. */
  private marked(
    threadId: string,
    phase: 'member-post-withdrawn' | 'member-post-delivered',
  ): Set<string> {
    return new Set(
      this.deps.store
        .phasesOf(threadId, phase)
        .map((row) => postKey(row.record as { signetId?: unknown; postId?: unknown })),
    );
  }

  /** Notes neither delivered to an owner turn nor withdrawn, written before journal seq `before`. */
  private pendingNotes(threadId: string, before = Number.POSITIVE_INFINITY) {
    const settled = new Set([
      ...this.marked(threadId, 'member-post-withdrawn'),
      ...this.marked(threadId, 'member-post-delivered'),
    ]);
    return this.posts(threadId)
      .filter(
        ({ seq, post }) => post.delivery === 'note' && seq < before && !settled.has(postKey(post)),
      )
      .map(({ post }) => post);
  }

  /** Member posts after journal seq `after`, in order, each with its seq and when it was stored. */
  private posts(threadId: string, after = 0) {
    return this.deps.store.orderedPhases(threadId, 'member-post', after).map((row) => ({
      seq: row.seq,
      storedAt: row.storedAt,
      post: row.record as unknown as MemberPostRecord,
    }));
  }

  private heldPending(threadId: string): HeldRecord[] {
    const settled = new Set(
      this.deps.store
        .phasesOf(threadId, 'outbound-resolution')
        .map((row) => (row.record as unknown as HeldResolutionRecord).heldId),
    );
    return this.deps.store
      .phasesOf(threadId, 'outbound-held')
      .map((row) => row.record as unknown as HeldRecord)
      .filter((held) => held.status === 'pending' && !settled.has(held.heldId));
  }

  /** Write a held item as a main-thread entry; `auto` leaves now, `review` asks the owner (§4.5). */
  private hold(thread: Thread, item: Omit<HeldRecord, 'heldId' | 'status'>): void {
    const record: HeldRecord = {
      ...item,
      heldId: newId('held'),
      status: item.outbound === 'auto' ? 'released' : 'pending',
    };
    const phaseId = newId('phase');
    this.deps.store.transaction(() => {
      this.deps.store.appendPhase(thread, {
        id: phaseId,
        phase: 'outbound-held',
        turnId: this.deps.store.openTurn(thread.id)?.id ?? null,
        dispatchId: null,
        record: record as unknown as Record<string, unknown>,
      });
      if (record.status === 'released' && record.kind === 'send')
        this.invite(thread, record, this.deps.store.phaseSeq(phaseId)!);
    });
    this.deps.journalChanged?.(thread);
    if (record.status === 'pending') this.raise(thread, record);
    else if (record.kind === 'post') void this.deliver(thread, record, record.text);
    this.pump(thread.id);
    this.deps.changed?.(thread.id);
  }

  /** A released send in `speak-when-spoken-to` invites its member to reply once; its id is the send's journal seq. */
  private invite(thread: Thread, held: HeldRecord, seq: number): void {
    if (held.kind !== 'send' || !held.to || held.to.kind !== 'signet') return;
    const record = this.record(thread.id);
    if (this.settings(thread, record).floor !== 'speak-when-spoken-to') return;
    record.invitations.push({
      id: String(seq),
      to: held.to,
      by: OWNER_MEMBER,
      standing: false,
      expiresAt: null,
    });
    this.save(thread, record);
  }

  private raise(thread: Thread, held: HeldRecord): void {
    const queue = this.deps.queue;
    if (!queue || this.open.has(held.heldId)) return;
    const controller = new AbortController();
    const ask = queue.prompt({
      kind: 'choice',
      threadId: thread.id,
      agentId: 'conversation',
      capability: 'conversation',
      message:
        held.kind === 'send'
          ? `Send to ${held.toName ?? held.to?.id}:\n${held.text}`
          : `Post to conversation thread ${held.remoteThreadId} (access ${held.accessId}):\n${held.text}`,
      options: HELD_OPTIONS.map((option) => ({ ...option })),
      signal: controller.signal,
      meta: {
        // Each item is the owner's own review: never answered by an "always" policy.
        structural: true,
        conversationHeld: {
          heldId: held.heldId,
          kind: held.kind,
          text: held.text,
          ...(held.to ? { to: held.to, toName: held.toName } : {}),
          ...(held.remoteThreadId
            ? { remoteThreadId: held.remoteThreadId, accessId: held.accessId }
            : {}),
        },
      },
    });
    // The queue registers a prompt before its first await, so it is findable now.
    const promptId = queue
      .pending()
      .find(
        (prompt) =>
          (prompt.meta?.conversationHeld as { heldId?: string } | undefined)?.heldId ===
          held.heldId,
      )?.id;
    if (!promptId) return;
    const open: OpenHeld = { promptId, controller };
    this.open.set(held.heldId, open);
    void ask
      .then((resolution) => this.answer(thread, held, resolution, open))
      .catch((error: unknown) =>
        this.deps.log?.(`[Conversations] held item not settled: ${(error as Error).message}`),
      )
      .finally(() => {
        if (this.open.get(held.heldId) === open) this.open.delete(held.heldId);
      });
  }

  /** Record an answer and carry it out: release (as written or edited) or withdraw. */
  private async answer(
    thread: Thread,
    held: HeldRecord,
    resolution: ActionResolution,
    open: OpenHeld,
  ): Promise<void> {
    // A withdrawn prompt (a stop, a shutdown) or a timeout is no answer: the item stays pending.
    if (resolution.by !== 'human') return;
    let text = held.text;
    if (resolution.action === 'edit') {
      try {
        text = boundedText(resolution.input ?? '');
      } catch {
        // An invalid edit from an unvalidated surface settles nothing: ask again.
        this.open.delete(held.heldId);
        this.raise(thread, held);
        return;
      }
    } else if (resolution.action !== 'release' && resolution.action !== 'withdraw') {
      // An answer this item doesn't offer (a surface that skipped validation) settles nothing.
      this.open.delete(held.heldId);
      this.raise(thread, held);
      return;
    }
    const action = resolution.action === 'withdraw' ? 'withdrawn' : 'released';
    const phaseId = newId('phase');
    this.deps.store.transaction(() => {
      this.deps.store.appendPhase(thread, {
        id: phaseId,
        phase: 'outbound-resolution',
        turnId: null,
        dispatchId: null,
        record: {
          heldId: held.heldId,
          kind: held.kind,
          ...(held.to ? { to: held.to, toName: held.toName } : {}),
          action,
          text,
          by: resolution.by,
          ...(open.surface ? { surface: open.surface } : {}),
        } satisfies HeldResolutionRecord as unknown as Record<string, unknown>,
      });
      if (action === 'released' && held.kind === 'send')
        this.invite(thread, held, this.deps.store.phaseSeq(phaseId)!);
    });
    this.deps.journalChanged?.(thread);
    if (action === 'released' && held.kind === 'post') await this.deliver(thread, held, text);
    this.pump(thread.id);
    this.deps.changed?.(thread.id);
  }

  /** Post a released item through its held Signet; Kingdom's answer is journalled either way. */
  private async deliver(thread: Thread, held: HeldRecord, text: string): Promise<void> {
    let delivered: { executionId?: string; error?: string };
    try {
      delivered = this.deps.deliverPost
        ? await this.deps.deliverPost({ ...held, text })
        : { error: 'No Kingdom access is configured to post with' };
    } catch (error) {
      delivered = { error: (error as Error).message };
    }
    this.deps.store.appendPhase(thread, {
      id: newId('phase'),
      phase: 'outbound-delivered',
      turnId: null,
      dispatchId: null,
      record: {
        heldId: held.heldId,
        ...delivered,
      } satisfies HeldDeliveryRecord as unknown as Record<string, unknown>,
    });
    this.deps.journalChanged?.(thread);
  }

  /** A member revoked mid-conversation: its queued turns and unread notes are cancelled (§5.7). */
  private async cancelMember(signetId: string): Promise<void> {
    const turns = this.deps.turns();
    for (const threadId of this.deps.store.conversationThreads()) {
      const thread = this.deps.thread(threadId);
      if (!thread) continue;
      const settled = new Set([
        ...this.marked(threadId, 'member-post-withdrawn'),
        ...this.marked(threadId, 'member-post-delivered'),
      ]);
      for (const { post } of this.posts(threadId)) {
        if (post.signetId !== signetId) continue;
        if (post.turnId) {
          if (this.deps.store.turn(post.turnId)?.status === 'queued')
            await turns?.interrupt(threadId, post.turnId).catch(() => undefined);
        } else if (!settled.has(postKey(post)))
          this.deps.store.appendPhase(thread, {
            id: newId('phase'),
            phase: 'member-post-withdrawn',
            turnId: null,
            dispatchId: null,
            record: { postId: post.postId, signetId, reason: 'revoked' },
          });
      }
      this.deps.changed?.(threadId);
    }
  }
}

/** How many journal rows one read or snapshot looks at before it says there is more. */
const RAW_READ = 5_000;

/** A member post's identity: its own id is the member's, so it is unique only per Signet. */
const postKey = (post: { signetId?: unknown; postId?: unknown }) =>
  `${String(post.signetId)}:${String(post.postId)}`;

function boundedText(text: string): string {
  const body = text.trim();
  if (!body) throw Error('The text is empty');
  if (body.length > MAX_HELD_TEXT)
    throw Error(`The text is ${body.length} characters; at most ${threadTextLimit} leave`);
  return body;
}
