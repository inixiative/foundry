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
import type { JournalEntry, LocalSessionStore } from '../persistence/local-session-store';
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
  memberKey,
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

const FLOOR_REQUEST_OPTIONS = [
  { id: 'give', label: 'Give it' },
  { id: 'not-now', label: 'Not now' },
] as const;

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
  /** When each member was last seen on a thread (`<member key>@<threadId>`): a view opened or closed. */
  private readonly seen = new Map<string, number>();
  /** The newest revision a frame from each member carried (frames are newer than snapshots, §4.5). */
  private readonly accepted = new Map<string, number>();
  private readonly open = new Map<string, OpenHeld>();
  /** A raised hand's open prompt, by `<threadId>:<member kind>:<member id>` (§4.8). */
  private readonly hands = new Map<string, OpenHeld>();
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
    for (const open of this.hands.values()) open.controller.abort();
    this.hands.clear();
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
    return this.admitPost(thread, {
      member: { kind: 'signet', id: signetId },
      displayName: frame.member.displayName,
      postId: input.postId,
      text: input.text,
      delivery: lens.delivery,
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      executionId: frame.requestId,
      acceptedRevision: frame.acceptedRevision,
    });
  }

  /**
   * One post into an open thread, from any member (a Signet's frame, or a local member's answer): the
   * one admission transaction (§4.2), then the note or turn it becomes.
   */
  private admitPost(
    thread: Thread,
    post: {
      member: ConversationMember;
      displayName: string;
      postId: string;
      text: string;
      delivery: 'note' | 'turn';
      inReplyTo?: string;
      executionId?: string;
      acceptedRevision?: number;
    },
  ): ThreadOutcome<'thread.prompt'> {
    const me = post.member;
    const key = memberKey(me);
    let outcome:
      | { kind: 'refused'; refusal: ThreadRefusal; message?: string }
      | { kind: 'duplicate'; seq: number }
      | { kind: 'admitted'; seq: number; post: MemberPostRecord };
    try {
      outcome = this.deps.store.transaction(() => {
        const prior = this.deps.store
          .phasesOf(thread.id, 'member-post', { key: 'postId', value: post.postId })
          .find((row) => (row.record as unknown as MemberPostRecord).memberKey === key);
        if (prior)
          return { kind: 'duplicate' as const, seq: this.deps.store.phaseSeq(prior.id) ?? 0 };
        const record = this.record(thread.id);
        const settings = this.settings(thread, record);
        if (this.paused(thread.id, record))
          return { kind: 'refused' as const, refusal: 'conversation_paused' as const };
        // A post that wakes the agent is two agent turns: the member's, and the agent's answer. A
        // post that would go past the bound is refused, and the conversation pauses.
        const depth = this.depth(thread.id, record);
        // Silent agents hear everything and are woken by nothing: a post is a note (§4.9, M7).
        const delivery = settings.agents === 'silent' ? 'note' : post.delivery;
        const cost = delivery === 'turn' ? 2 : 1;
        if (depth + cost > settings.maxAgentTurns) {
          // At the bound the conversation pauses; a `turn` post with one turn left is refused
          // alone, so a note may still take that turn.
          if (depth >= settings.maxAgentTurns) this.pause(thread, record, 'depth');
          return { kind: 'refused' as const, refusal: 'conversation_paused' as const };
        }
        const floor = this.takeFloor(record, settings, me, post.inReplyTo);
        // A reply naming a notify commission whose invitation is gone (expired, already used) would
        // otherwise go public under talk; it never posts (round 5, M1).
        if (
          !floor.refusal &&
          !floor.commission &&
          post.inReplyTo &&
          this.commissionNamed(thread.id, post.inReplyTo, me)?.report === 'notify'
        )
          return { kind: 'refused' as const, refusal: 'not_invited' as const };
        if (floor.refusal) {
          // A conch that lapsed at this admission is the host's now, refused or not.
          if (floor.changed) this.save(thread, record);
          return { kind: 'refused' as const, refusal: floor.refusal };
        }
        if (
          record.sharedFromSeq === undefined &&
          me.kind === 'signet' &&
          !this.isOwnerSignet(me.id)
        )
          record.sharedFromSeq = this.deps.store.journalSeq(thread.id);
        const phaseId = newId('phase');
        const turnId = delivery === 'turn' ? newId('turn') : undefined;
        const row: MemberPostRecord = {
          postId: post.postId,
          member: me,
          memberKey: key,
          displayName: post.displayName,
          text: post.text,
          delivery,
          ...(settings.agents === 'silent' ? { silent: true } : {}),
          ...(floor.commission === 'notify' ? { notify: true } : {}),
          ...(post.executionId ? { executionId: post.executionId } : {}),
          ...(post.acceptedRevision !== undefined
            ? { acceptedRevision: post.acceptedRevision }
            : {}),
          ...(post.inReplyTo ? { inReplyTo: post.inReplyTo } : {}),
          ...(turnId ? { turnId } : {}),
        };
        this.deps.store.appendPhase(thread, {
          id: phaseId,
          phase: 'member-post',
          turnId: null,
          dispatchId: null,
          record: row as unknown as Record<string, unknown>,
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
            payload: post.text,
            origin: {
              member: me,
              displayName: post.displayName,
              postId: post.postId,
              ...(post.executionId ? { executionId: post.executionId } : {}),
            },
          });
          if (!accepted.ok)
            // Closed was decided above; a 409 here is a busy host (live capacity), not a closed thread.
            throw new Refusal(
              accepted.status === 404 ? 'unknown_thread' : 'failed',
              String(accepted.body.error ?? 'The turn was not accepted'),
            );
        }
        return { kind: 'admitted' as const, seq, post: row };
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
          source: `conversation:${key}`,
          // Ids only: the bus reaches the Librarian's thread-state, which must never carry member
          // text. The runtime reads the labelled post through the wrapper (`notePost`).
          content: { threadId: thread.id, member: me, postId: outcome.post.postId },
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
    this.seen.set(seenKey(signetMember(frame.signetId), thread.id), Date.now());
    const after = Math.max(
      frame.input.afterSeq ?? 0,
      this.isOwnerSignet(frame.signetId) ? 0 : this.sharedFrom(thread),
    );
    const raw = this.deps.store.journalEntries(thread.id, { after, limit: RAW_READ });
    const owner = this.isOwnerSignet(frame.signetId);
    const reader = { member: signetMember(frame.signetId), lens: frame.lens };
    const entries = raw.flatMap((row) => this.readable(row, reader, owner));
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
    const from = this.isOwnerSignet(frame.signetId) ? 0 : this.sharedFrom(thread);
    const raw = this.deps.store.journalEntries(thread.id, { newest: true, limit: RAW_READ });
    const owner = this.isOwnerSignet(frame.signetId);
    const reader = { member: signetMember(frame.signetId), lens: frame.lens };
    const entries = raw
      .filter((row) => row.seq > from)
      .flatMap((row) => this.readable(row, reader, owner));
    this.cursors.set(frame.requestId, journalSeq);
    this.seen.set(seenKey(signetMember(frame.signetId), thread.id), Date.now());
    this.deps.changed?.(thread.id);
    return threadResult(capView(entries, journalSeq, 'newest', raw.length === RAW_READ));
  }

  /**
   * One journal row as this reader may see it (§4.9): its lens first, then the per-reader rules.
   * The host agent's own messages are the owner's private side, so only an owner recipient (a grant
   * with `prompt.resolve`) reads them (M8). A report against a `notify` commission reaches only its
   * author and the owner (M1).
   */
  private readable(
    row: JournalEntry,
    reader: { member: ConversationMember; lens: Pick<ThreadsLens, 'view'> },
    owner: boolean,
  ): ThreadEntry[] {
    const entry = threadEntryOf(row);
    if (!entry || !visibleTo(entry, reader)) return [];
    if (entry.kind === 'agent' && !owner) return [];
    if (
      entry.kind === 'post' &&
      row.source !== 'message' &&
      (row.record as unknown as MemberPostRecord).notify &&
      !owner &&
      !sameMember(entry.member, reader.member)
    )
      return [];
    return [entry];
  }

  /** A member's view closed (left, lease lapsed, socket dropped): it stops being pushed. */
  ended(subscription: ThreadSubscription, _reason: string): void {
    this.cursors.delete(subscription.subscriptionId);
    this.seen.set(seenKey(signetMember(subscription.signetId), subscription.threadId), Date.now());
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
    const owners = new Map(
      views.map((view) => [view.subscriptionId, this.isOwnerSignet(view.signetId)]),
    );
    for (const row of raw)
      for (const view of views)
        if (row.seq > this.cursors.get(view.subscriptionId)!)
          for (const entry of this.readable(
            row,
            { member: signetMember(view.signetId), lens: view.lens },
            owners.get(view.subscriptionId)!,
          ))
            view.append(entry);
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
        // A member whose grant says floor.mayTake takes the conch without being given it (§4.9).
        if (action.action === 'take') {
          if (!frame.lens.floor.mayTake) {
            if (lapsed) this.save(thread, record);
            return 'floor_denied' as const;
          }
          this.moveConch(record, settings, me, me);
          this.save(thread, record);
          return null;
        }
        if (!conch || !sameMember(conch.to, me)) {
          if (lapsed) this.save(thread, record);
          return 'floor_denied' as const;
        }
        if (action.action === 'release') this.moveConch(record, settings, null, me);
        else {
          if (action.to.kind === 'local')
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
    if (!outcome && action.action === 'request' && this.floorState(thread).mode === 'conch')
      this.raiseHand(thread, { member: me, displayName: frame.member.displayName });
    this.settleHands(thread.id);
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
      else if (prompt.meta?.conversationFloorRequest) {
        if (!FLOOR_REQUEST_OPTIONS.some((option) => option.id === answer.action))
          return threadRefused(
            'invalid_request',
            `${answer.action} is not an answer this prompt offers`,
          );
        if (!queue.resolve(promptId, answer.action, { by: 'human' }))
          return threadRefused('invalid_request', 'The prompt was already answered');
      } else if (typeof prompt.meta?.toolName === 'string') {
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
          'Only a tool-call ask, a held send or a raised hand can be answered remotely',
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
  send(threadId: string, member: string, text: string, report?: 'post' | 'notify'): string {
    const thread = this.deps.thread(threadId);
    if (!thread || this.closedReason(thread)) throw Error('This thread is not open');
    const target = this.findMember(threadId, member);
    // A commission is the one thing a silent agent may send: a person asked for the task (M7).
    if (!report && this.settings(thread, this.record(thread.id)).agents === 'silent')
      throw Error(
        'Agents are silent in this conversation until the leader lets them draft (conversations.agents)',
      );
    const body = boundedText(text);
    const outbound = this.outbound(target.member.id, threadId);
    this.hold(thread, {
      kind: 'send',
      text: body,
      outbound,
      to: target.member,
      toName: target.displayName,
      ...(report
        ? {
            commission:
              outbound === 'auto'
                ? { report, expiresAt: this.commissionExpiry(thread) }
                : { report },
          }
        : {}),
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
    if (this.settings(thread, this.record(thread.id)).agents === 'silent')
      throw Error(
        'Agents are silent in this conversation until the leader lets them draft (conversations.agents)',
      );
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
    for (const threadId of this.deps.store.conversationThreads()) {
      const thread = this.deps.thread(threadId);
      if (!thread || this.floorState(thread).mode !== 'conch') continue;
      for (const request of this.record(threadId).requests) {
        if (this.hands.has(handKey(threadId, request.member))) continue;
        this.raiseHand(thread, request);
        raised++;
      }
    }
    return raised;
  }

  /**
   * A raised hand is attention (§4.8): a Needs-you prompt beside the request the record keeps.
   * "Give it" runs the owner's own pass; "Not now" drops the request. Raised again at startup.
   */
  private raiseHand(
    thread: Thread,
    request: { member: ConversationMember; displayName: string },
  ): void {
    const queue = this.deps.queue;
    const key = handKey(thread.id, request.member);
    if (!queue || this.hands.has(key)) return;
    const controller = new AbortController();
    const ask = queue.prompt({
      kind: 'choice',
      threadId: thread.id,
      agentId: 'conversation',
      capability: 'conversation',
      message: `${request.displayName} asks for the conch.`,
      options: FLOOR_REQUEST_OPTIONS.map((option) => ({ ...option })),
      signal: controller.signal,
      meta: { structural: true, conversationFloorRequest: { member: request.member } },
    });
    const promptId = queue
      .pending()
      .find(
        (prompt) =>
          prompt.threadId === thread.id &&
          sameMember(
            (prompt.meta?.conversationFloorRequest as { member?: ConversationMember } | undefined)
              ?.member ?? null,
            request.member,
          ),
      )?.id;
    if (!promptId) return;
    const open: OpenHeld = { promptId, controller };
    this.hands.set(key, open);
    void ask
      .then((resolution) => {
        if (resolution.by !== 'human') return;
        if (resolution.action === 'give') this.giveConch(thread.id, request.member);
        else if (resolution.action === 'not-now') this.dropRequest(thread.id, request.member);
      })
      .catch((error: unknown) =>
        this.deps.log?.(`[Conversations] raised hand not settled: ${(error as Error).message}`),
      )
      .finally(() => {
        if (this.hands.get(key) === open) this.hands.delete(key);
      });
  }

  /** Withdraw the prompts of hands the record no longer holds (the conch moved, the mode changed). */
  private settleHands(threadId: string): void {
    const thread = this.deps.thread(threadId);
    const requests =
      thread && this.floorState(thread).mode === 'conch' ? this.record(threadId).requests : [];
    for (const [key, open] of this.hands)
      if (
        key.startsWith(`${threadId}:`) &&
        !requests.some((request) => handKey(threadId, request.member) === key)
      ) {
        this.hands.delete(key);
        open.controller.abort();
      }
  }

  private dropRequest(threadId: string, member: ConversationMember): void {
    const thread = this.requireThread(threadId);
    this.deps.store.transaction(() => {
      const record = this.record(thread.id);
      record.requests = record.requests.filter((request) => !sameMember(request.member, member));
      this.save(thread, record);
    });
    this.deps.changed?.(threadId);
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
      // Reply invitations belong to the mode that made them; a commission outlives a mode change (M3).
      if (floor !== 'speak-when-spoken-to')
        record.invitations = record.invitations.filter(
          (invitation) => invitation.standing || invitation.commission,
        );
      this.save(thread, record);
    });
    this.settleHands(threadId);
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
    this.settleHands(threadId);
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

  /**
   * The leader's marker (§4.9): `silent` keeps agents listening, `drafting` lets them propose; null
   * goes back to the cascade.
   */
  setAgents(threadId: string, mode: ConversationSettings['agents'] | null): void {
    const thread = this.requireThread(threadId);
    this.deps.store.transaction(() => {
      const record = this.record(thread.id);
      if (mode) record.settings.agents = mode;
      else delete record.settings.agents;
      this.save(thread, record);
    });
    this.deps.changed?.(threadId);
  }

  /** The owner shares what was said before the share: members read the whole journal (§4.9, B3). */
  shareHistory(threadId: string): void {
    const thread = this.requireThread(threadId);
    this.deps.store.transaction(() => {
      const record = this.record(thread.id);
      record.sharedFromSeq = 0;
      this.save(thread, record);
    });
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
   * The member notes that ride the agent's next turn, whoever opened it (§4.2, §4.5, §4.10): every note not yet delivered or
   * withdrawn, written before this turn's message, labelled. Each one is marked delivered to this
   * turn (`member-post-delivered`), so a note whose turn never ran (stopped while queued,
   * dropped at a restart) rides the next one instead of reading as consumed.
   */
  deliverNotes(threadId: string, turnId: string | undefined): PromptBlock[] {
    if (!turnId || !this.wraps(threadId)) return [];
    const store = this.deps.store;
    // Every turn of the agent takes the notes in, not only the owner's (review round 4, B1): a
    // turn a member opened, or one after "agents may draft now", is where the agent speaks.
    const seq = store.turnMessageSeq(turnId);
    if (seq === undefined) return [];
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
            record: { postId: post.postId, memberKey: post.memberKey },
          });
      });
    if (notes.length) this.deps.changed?.(threadId);
    return notes.map((post) => ({
      role: 'content' as const,
      id: `member-post:${post.memberKey}:${post.postId}`,
      source: `conversation:${post.memberKey}`,
      placement: 'after-message' as const,
      text: memberPostReception(post.displayName, post.text),
    }));
  }

  /** One admitted post, labelled, for the Wardens' pass on it (ids travel on the bus, never text). */
  notePost(
    threadId: string,
    member: ConversationMember,
    postId: string,
  ): { displayName: string; text: string } | undefined {
    const post = this.deps.store
      .phasesOf(threadId, 'member-post', { key: 'postId', value: postId })
      .map((row) => row.record as unknown as MemberPostRecord)
      .find((candidate) => candidate.memberKey === memberKey(member));
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
      // Parties off this machine other than the owner: what makes a thread shared (D5).
      members: this.members(threadId).filter((member) => !this.isOwnerSignet(member.member.id))
        .length,
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
        member: post.member,
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
    this.markShared(hosted);
    const now = new Set(hosted.map((signet) => signet.signetId));
    const before = this.listed;
    this.listed = new Set([...now, ...[...dropped].filter((id) => before?.has(id))]);
    if (before)
      for (const signetId of before)
        if (!now.has(signetId) && !dropped.has(signetId)) void this.cancelMember(signetId);
    this.reconcileShares();
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

  /** A commission's report window, from now: set when the send is released, not drafted. */
  private commissionExpiry(thread: Thread): string {
    const hours = this.settings(thread, this.record(thread.id)).commissionHours;
    return new Date(Date.now() + hours * 3_600_000).toISOString();
  }

  /** The commission a reply names, read from the send's own journal row (not its invitation). */
  private commissionNamed(
    threadId: string,
    inReplyTo: string,
    me: ConversationMember,
  ): ThreadEntry['commission'] {
    const seq = Number(inReplyTo);
    if (!Number.isInteger(seq) || seq < 1) return undefined;
    const [row] = this.deps.store.journalEntries(threadId, { after: seq - 1, limit: 1 });
    const entry = row && row.seq === seq ? threadEntryOf(row) : null;
    return entry?.kind === 'send' && sameMember(entry.member, me) ? entry.commission : undefined;
  }

  /** Where members' reads start (§4.9, B3). A thread read before its share was marked starts now. */
  private sharedFrom(thread: Thread): number {
    const record = this.record(thread.id);
    if (record.sharedFromSeq !== undefined) return record.sharedFromSeq;
    record.sharedFromSeq = this.deps.store.journalSeq(thread.id);
    this.save(thread, record);
    return record.sharedFromSeq;
  }

  /**
   * The host's own owner reaching his thread from another machine (a grant with `prompt.resolve`,
   * which Kingdom allows only to the owner) is not another party: it doesn't share the thread, and
   * his remote view isn't cut at the share.
   */
  private isOwnerSignet(signetId: string): boolean {
    const signet = this.deps.hosted().find((candidate) => candidate.signetId === signetId);
    return !!signet && ownsThreads(signet);
  }

  /** Shared: a listed grant from someone other than the owner selects the thread (§4.8, §4.9). */
  private isShared(threadId: string): boolean {
    return this.deps
      .hosted()
      .some((signet) => !ownsThreads(signet) && this.grantOn(signet, threadId) !== undefined);
  }

  /**
   * After a snapshot: an unshared thread drops its share mark and the conch state the shared
   * default left (a cascade change no owner action settles), and hands follow the floor: withdrawn
   * when it isn't the conch, raised again (a restart's snapshot) when it is.
   */
  private reconcileShares(): void {
    for (const threadId of this.deps.store.conversationThreads()) {
      const thread = this.deps.thread(threadId);
      if (!thread) continue;
      const record = this.record(threadId);
      let changed = false;
      if (!this.isShared(threadId) && record.sharedFromSeq !== undefined) {
        delete record.sharedFromSeq;
        changed = true;
      }
      const conch = this.floorState(thread).mode === 'conch';
      if (!conch && (record.requests.length || record.invitations.some((i) => i.standing))) {
        record.requests = [];
        record.invitations = record.invitations.filter((invitation) => !invitation.standing);
        changed = true;
      }
      if (changed) this.save(thread, record);
      this.settleHands(threadId);
      if (conch)
        for (const request of record.requests)
          if (!this.hands.has(handKey(threadId, request.member))) this.raiseHand(thread, request);
    }
  }

  /** Mark the share on every thread a listed grant selects by id: members read from here on. */
  private markShared(hosted: readonly HostedSignet[]): void {
    for (const signet of hosted) {
      if (ownsThreads(signet)) continue;
      for (const grant of signet.resources) {
        if (grant.kind !== threadsResourceKind || !('threads' in grant.lens)) continue;
        if (grant.lens.threads.form !== 'ids') continue;
        for (const threadId of grant.lens.threads.ids) {
          const thread = this.deps.thread(threadId);
          if (thread && this.record(threadId).sharedFromSeq === undefined) this.sharedFrom(thread);
        }
      }
    }
  }

  private resolved(thread: Thread, record: ConversationRecord) {
    const projectId = thread.meta.projectId;
    return resolveConversationSettings(
      projectId ? this.deps.project(projectId) : undefined,
      record.settings,
      this.isShared(thread.id),
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
    // People talking while the agents listen spend no agent turns (§4.9: silent until a marker).
    return this.posts(threadId, from).reduce(
      (count, { post }) => count + (post.silent ? 0 : post.delivery === 'turn' ? 2 : 1),
      0,
    );
  }

  /** A conch whose time ran out belongs to the host (lazy expiry, checked on arrival). */
  private dropLapsedConch(record: ConversationRecord): boolean {
    const now = Date.now();
    const before = record.invitations.length;
    record.invitations = record.invitations.filter(
      (invitation) =>
        !(invitation.standing || invitation.commission) ||
        !invitation.expiresAt ||
        Date.parse(invitation.expiresAt) > now,
    );
    return record.invitations.length !== before;
  }

  /** The floor at admission (§4.3): talk admits; a reply consumes its invitation; only the conch's holder posts. */
  private takeFloor(
    record: ConversationRecord,
    settings: ConversationSettings,
    me: ConversationMember,
    inReplyTo: string | undefined,
  ): { refusal?: ThreadRefusal; changed: boolean; commission?: Invitation['commission'] } {
    const changed = this.dropLapsedConch(record);
    const now = Date.now();
    const commission = inReplyTo
      ? record.invitations.find(
          (candidate) =>
            candidate.commission &&
            candidate.id === inReplyTo &&
            sameMember(candidate.to, me) &&
            (!candidate.expiresAt || Date.parse(candidate.expiresAt) > now),
        )
      : undefined;
    // A commissioned report enters by its invitation in every mode, the conch included (§4.9 point 8).
    if (commission) {
      record.invitations = record.invitations.filter((candidate) => candidate !== commission);
      return { changed: true, commission: commission.commission };
    }
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
      key: 'memberKey',
      value: memberKey(signetMember(signetId)),
    }))
      revision = Math.max(
        revision,
        (row.record as unknown as MemberPostRecord).acceptedRevision ?? 0,
      );
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

  /** A member the conch can pass to: one whose grant selects the thread now, not a past poster. */
  private isMember(threadId: string, signetId: string): boolean {
    return this.deps
      .hosted()
      .some(
        (signet) => signet.signetId === signetId && this.grantOn(signet, threadId) !== undefined,
      );
  }

  /** Members of a thread: Signets whose grant selects it, and anyone who has posted to it. */
  members(threadId: string): ConversationMemberView[] {
    const views = new Map<string, ConversationMemberView>();
    const present = new Set(
      this.deps
        .subscriptions()
        .filter((view) => view.threadId === threadId && this.cursors.has(view.subscriptionId))
        .map((view) => memberKey(signetMember(view.signetId))),
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
      lastPost.set(post.memberKey, row.storedAt);
      if (!views.has(post.memberKey))
        views.set(post.memberKey, {
          member: post.member,
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
      const member = signetMember(signet.signetId);
      views.set(memberKey(member), {
        member,
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
    for (const [key, view] of views) {
      if (view.member.kind === 'signet') view.outbound = this.outbound(view.member.id, threadId);
      view.present = present.has(key);
      const last = Math.max(
        this.seen.get(seenKey(view.member, threadId)) ?? 0,
        lastPost.get(key) ?? 0,
      );
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

  /** Posts a `member-post-withdrawn` or `member-post-delivered` row settles, by `<member key>:postId`. */
  private marked(
    threadId: string,
    phase: 'member-post-withdrawn' | 'member-post-delivered',
  ): Set<string> {
    return new Set(
      this.deps.store
        .phasesOf(threadId, phase)
        .map((row) => postKey(row.record as { memberKey?: unknown; postId?: unknown })),
    );
  }

  /** Notes neither delivered to a turn nor withdrawn, written before journal seq `before`. */
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
  private invite(
    thread: Thread,
    held: HeldRecord,
    seq: number,
    commission = held.commission?.expiresAt
      ? { report: held.commission.report, expiresAt: held.commission.expiresAt }
      : undefined,
  ): void {
    if (held.kind !== 'send' || !held.to || held.to.kind !== 'signet') return;
    const record = this.record(thread.id);
    // A commission invites its report in every mode, until it expires (§4.9 point 8, M2); an
    // ordinary send invites a reply only under speak-when-spoken-to.
    if (!commission && this.settings(thread, record).floor !== 'speak-when-spoken-to') return;
    record.invitations.push({
      id: String(seq),
      to: held.to,
      by: OWNER_MEMBER,
      standing: false,
      expiresAt: commission?.expiresAt ?? null,
      ...(commission ? { commission: commission.report } : {}),
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
          ? `${held.commission ? `Ask ${held.toName ?? held.to?.id} for a task (its report ${held.commission.report === 'post' ? 'posts to the thread' : 'notifies only you'})` : `Send to ${held.toName ?? held.to?.id}`}:\n${held.text}`
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
          ...(held.commission ? { commission: held.commission } : {}),
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
    const commission =
      held.commission && action === 'released'
        ? { report: held.commission.report, expiresAt: this.commissionExpiry(thread) }
        : undefined;
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
          ...(commission ? { commission } : {}),
          action,
          text,
          by: resolution.by,
          ...(open.surface ? { surface: open.surface } : {}),
        } satisfies HeldResolutionRecord as unknown as Record<string, unknown>,
      });
      if (action === 'released' && held.kind === 'send')
        this.invite(thread, held, this.deps.store.phaseSeq(phaseId)!, commission);
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
      const record = this.record(threadId);
      const gone = signetMember(signetId);
      if (
        record.requests.some((request) => sameMember(request.member, gone)) ||
        record.invitations.some((invitation) => sameMember(invitation.to, gone))
      ) {
        record.requests = record.requests.filter((request) => !sameMember(request.member, gone));
        record.invitations = record.invitations.filter(
          (invitation) => !sameMember(invitation.to, gone),
        );
        this.save(thread, record);
        this.settleHands(threadId);
      }
      for (const { post } of this.posts(threadId)) {
        if (post.memberKey !== memberKey(gone)) continue;
        if (post.turnId) {
          if (this.deps.store.turn(post.turnId)?.status === 'queued')
            await turns?.interrupt(threadId, post.turnId).catch(() => undefined);
        } else if (!settled.has(postKey(post)))
          this.deps.store.appendPhase(thread, {
            id: newId('phase'),
            phase: 'member-post-withdrawn',
            turnId: null,
            dispatchId: null,
            record: { postId: post.postId, memberKey: post.memberKey, reason: 'revoked' },
          });
      }
      this.deps.changed?.(threadId);
    }
  }
}

/** How many journal rows one read or snapshot looks at before it says there is more. */
const RAW_READ = 5_000;

/** A grant that answers the host's prompts: Kingdom allows it only to the thread's owner. */
const ownsThreads = (signet: HostedSignet) =>
  signet.resources.some(
    (grant) => grant.kind === threadsResourceKind && grant.operations.includes('prompt.resolve'),
  );

const handKey = (threadId: string, member: ConversationMember) =>
  `${threadId}:${member.kind}:${member.id}`;

/** A post's identity: its id is its member's own, so it is unique only per member. */
const postKey = (post: { memberKey?: unknown; postId?: unknown }) =>
  `${String(post.memberKey)}:${String(post.postId)}`;

const signetMember = (signetId: string): ConversationMember => ({ kind: 'signet', id: signetId });

const seenKey = (member: ConversationMember, threadId: string) =>
  `${memberKey(member)}@${threadId}`;

function boundedText(text: string): string {
  const body = text.trim();
  if (!body) throw Error('The text is empty');
  if (body.length > MAX_HELD_TEXT)
    throw Error(`The text is ${body.length} characters; at most ${threadTextLimit} leave`);
  return body;
}
