/**
 * @atlas
 * @kind type
 * @partOf feature:conversations
 */
import type { PromptBlock } from '@inixiative/foundry-core';
import {
  type ConversationMember,
  type ConversationOutbound,
  type ConversationPermission,
  conversationOutboundSchema,
  conversationPermissionSchema,
  floorModeSchema,
  type RequestAudience,
  type ThreadCommission,
  threadTextLimit,
} from '@inixiative/signet';
import { z } from 'zod';

/**
 * A conversation is a wrapper of a main thread (docs/reference/CONVERSATIONS.md §4.1): one post-in
 * point, one read-off point and this state. Everything else is the thread's own machinery.
 */

/** The owner as a party: posts and sends from this side of the thread. */
export const OWNER_MEMBER: ConversationMember = Object.freeze({ kind: 'owner', id: 'owner' });

/** The `conversations` setting (§4.6): one key in the existing cascade. */
export const conversationSettingsSchema = z.strictObject({
  floor: floorModeSchema.optional(),
  maxAgentTurns: z.number().int().min(1).max(100).optional(),
  conch: z
    .strictObject({
      holdSeconds: z
        .number()
        .int()
        .min(10)
        .max(7 * 86_400)
        .optional(),
      agentMayPass: z.boolean().optional(),
    })
    .optional(),
  agents: z.enum(['silent', 'drafting']).optional(),
  /** How long a commissioned task's report may still enter the thread (§4.9 point 8, M2). */
  commissionHours: z
    .number()
    .int()
    .min(1)
    .max(30 * 24)
    .optional(),
});
export type ConversationSettingsInput = z.infer<typeof conversationSettingsSchema>;

/**
 * What someone joining one of this Foundry's conversations starts with, per audience: the
 * conversation permissions Kingdom's review opens at, and this host's own `outbound` setting for
 * them. A field it leaves out is the built-in default's.
 */
const joiningSchema = z.strictObject({
  permissions: z.array(conversationPermissionSchema).optional(),
  outbound: conversationOutboundSchema.optional(),
});
export type Joining = z.infer<typeof joiningSchema>;

/**
 * This Foundry's `conversations` setting (not a project's): what someone joining one of its threads
 * starts with, per audience (Aron, 2026-11-14: "just in-org and outside-org, but something naive").
 * Kingdom marks each request's audience, and each hosted Signet's.
 */
export const foundryConversationSettingsSchema = z.strictObject({
  joining: z
    .strictObject({ inOrg: joiningSchema.optional(), outside: joiningSchema.optional() })
    .optional(),
});
export type FoundryConversationSettings = z.infer<typeof foundryConversationSettingsSchema>;

/**
 * Proposals: someone in your orgs directs the agent and it may read for them; someone outside is
 * data and every call asks. Sends to either wait for the owner's review. Each person still dials
 * their own Signet in the review.
 */
export const DEFAULT_JOINING: Readonly<Record<RequestAudience, Required<Joining>>> = Object.freeze({
  inOrg: Object.freeze({
    permissions: ['agent.instruct', 'agent.read'] as ConversationPermission[],
    outbound: 'review' as const,
  }),
  outside: Object.freeze({
    permissions: [] as ConversationPermission[],
    outbound: 'review' as const,
  }),
});

/** What someone of this audience joining starts with: the setting's fields over the built-in default. */
export function joiningDefault(
  settings: FoundryConversationSettings | undefined,
  audience: RequestAudience,
): Required<Joining> {
  return { ...DEFAULT_JOINING[audience], ...settings?.joining?.[audience] };
}

/** Refuses this Foundry's `conversations` value, naming where a project's own settings go. */
export function validateFoundryConversationSettings(value: unknown): void {
  if (value === undefined) return;
  const parsed = foundryConversationSettingsSchema.safeParse(value);
  if (parsed.success) return;
  const projectKey = parsed.error.issues
    .flatMap((issue) =>
      issue.code === 'unrecognized_keys' && !issue.path.length ? issue.keys : [],
    )
    .at(0);
  throw Error(
    projectKey
      ? `conversations.${projectKey} is a project setting: set it in projects.<id>.conversations or the repository's .foundry/project.json; this Foundry's conversations holds only joining`
      : `conversations: ${parsed.error.issues.map((issue) => `${['conversations', ...issue.path].join('.')} ${issue.message}`).join('; ')}`,
  );
}

/** Refuses a `conversations` value with the field that is wrong. */
export function validateConversationSettings(where: string, value: unknown): void {
  if (value === undefined) return;
  const parsed = conversationSettingsSchema.safeParse(value);
  if (!parsed.success)
    throw Error(
      `${where}: ${parsed.error.issues.map((issue) => `${[where, ...issue.path].join('.')} ${issue.message}`).join('; ')}`,
    );
}

export interface ConversationSettings {
  floor: z.infer<typeof floorModeSchema>;
  /** Agent turns without the owner before the conversation pauses (§4.4). */
  maxAgentTurns: number;
  conch: { holdSeconds: number; agentMayPass: boolean };
  /**
   * `silent`: agents hear the thread but don't speak (posts are notes, sends are refused) until the
   * leader lets them draft, the "marker" (Aron, 2026-11-01). `drafting`: agents may propose.
   */
  agents: 'silent' | 'drafting';
  commissionHours: number;
}

/** Proposals in the design (§10): talk, six agent turns, a five-minute conch the agent can't pass. */
export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = Object.freeze({
  floor: 'talk',
  maxAgentTurns: 6,
  conch: Object.freeze({ holdSeconds: 300, agentMayPass: false }),
  agents: 'drafting',
  commissionHours: 24,
});

/**
 * A shared thread (one with a member) defaults to the conch (Aron, 2026-11-01): outside agents are
 * present, so one speaker at a time with the host as leader. A layer of the cascade, never a write to
 * the thread's own floor, so it lifts when the last member leaves.
 */
export const SHARED_CONVERSATION_DEFAULTS: ConversationSettings = Object.freeze({
  ...DEFAULT_CONVERSATION_SETTINGS,
  floor: 'conch',
});

/**
 * The one floor mechanism (§4.3). `speak-when-spoken-to`: one per released send, consumed by the
 * reply that names it; its id is the send's journal seq, which is what the member reads. `conch`:
 * one standing invitation, held from when it was given for `holdSeconds` (posting doesn't extend it),
 * expired lazily at admission.
 */
export interface Invitation {
  id: string;
  to: ConversationMember;
  by: ConversationMember;
  standing: boolean;
  expiresAt: string | null;
  /**
   * A commissioned task's report (§4.9 point 8): admitted by its reply in every floor mode, the conch
   * included, until it expires; kept across a mode change. `notify`: the report reaches only the
   * owner, never the other members.
   */
  commission?: ThreadCommission['report'];
}

/** The wrapper's state, one record per conversation thread. Depth is derived from the journal. */
export interface ConversationRecord {
  invitations: Invitation[];
  /**
   * `depth`: the bound was reached; lifted by the owner's next message or a resume. `owner`: the
   * owner paused it; lifted only by a resume. `atSeq` is the journal seq it was set at.
   */
  paused?: { reason: 'depth' | 'owner'; at: string; atSeq: number };
  /** A resume restarts the depth count here (the owner's messages restart it too). */
  resumedAtSeq?: number;
  /**
   * Where members' reads start: the journal seq when the thread was first shared, so what the owner
   * said before the share stays his (review round 4, B3). 0 once the owner shares the history.
   */
  sharedFromSeq?: number;
  /**
   * Members on this machine (§4.11 point 2): another Foundry thread of the owner's, his Codex or a
   * second Claude, joined in-process with no Signet. Each one's record carries its permissions.
   */
  locals?: LocalMemberRecord[];
  /**
   * Each agent's voice where the owner set it (§4.11 point 1): `host` is the thread's own main
   * agent, a local member is keyed `local:<threadId>`. Unset: the `agents` default.
   */
  voices?: Record<string, Voice>;
  /**
   * Whether the host's sends to a Signet member wait for the owner (§4.5), keyed `signet:<id>`,
   * where the owner set it. Unset: the joining default for the member's audience. The host's own
   * setting, never the grant's (signet 0.18).
   */
  outbound?: Record<string, ConversationOutbound>;
  /** Members asking for the conch, newest last, until it moves. */
  requests: Array<{ member: ConversationMember; displayName: string; at: string }>;
  /** Per-thread overrides, the last step of the cascade. */
  settings: ConversationSettingsInput;
}

/** Speaking may propose and post when the floor allows; listening hears everything, woken by nothing. */
export type Voice = 'speaking' | 'listening';

/**
 * The owner's own agents talk to the host's agent by default (§4.11 point 2): they read the log
 * (`member.log`) and their posts wake it (`member.wake`); they don't take the conch. The log they
 * hear is what was posted: the host agent's own answers stay the host's side (§4.9 point 2, M8).
 */
export const DEFAULT_LOCAL_PERMISSIONS: readonly ConversationPermission[] = Object.freeze([
  'member.log',
  'member.wake',
]);

export interface LocalMemberRecord {
  /** The member's own Foundry thread on this machine. */
  threadId: string;
  displayName: string;
  /** The same conversation permissions a Signet member holds (signet `conversationPermissionSchema`). */
  permissions: ConversationPermission[];
  joinedAt: string;
  /** It hears the log from here on (the host journal seq when it joined). */
  fromSeq: number;
  /** The host journal seq the mirror has read through (readable or not), so no pass re-reads it. */
  mirroredSeq?: number;
  /** The newest mirrored host seq a wake covered: it is woken again only for something newer. */
  wokenSeq?: number;
}

/**
 * The host's log mirrored into a local member's own thread (phase `shared-entry`, CONVERSATIONS.md
 * §4.10): one row per host entry it may read, keyed by the host's journal seq, never admitted, exempt
 * from depth and floor. Collected for its agent's next turn by `deliverNotes`.
 */
export interface SharedEntryRecord {
  hostThreadId: string;
  hostName: string;
  hostSeq: number;
  /** Who said it, as the member reads it ("the owner", a member's name, "the host agent"). */
  speaker: string;
  /** `agent`: the host agent's own answer, which the owner's agents hear (Aron, 2026-11-01). */
  kind: 'owner' | 'agent' | 'post' | 'send';
  /** A send addressed to this member: something it was asked. */
  addressed: boolean;
  text: string;
  /** The host's words (`agent`, `send`): the host turn that said them, whose actors they carry (§4.12). */
  hostTurnId?: string;
}

/**
 * An aside (phase `aside`, ATTENTION-BOARD M6, Aron 2026-11-01): person to person, out of the log.
 * Every person in the thread sees it; no agent does (mirror, notes, the journal seed and the agent's
 * context all skip it) until someone promotes it, which posts it once. People only: the owner, or a
 * member's person through `thread.prompt` with `aside`.
 */
export interface AsideRecord {
  member: ConversationMember;
  memberKey: string;
  displayName: string;
  /** The author's own id for it: a retry keeps it, so it is recorded once. */
  postId: string;
  text: string;
}

/** An aside promoted to the log (phase `aside-promoted`): the owner's message, or the member's post. */
export interface AsidePromotedRecord {
  asideId: string;
  /** The owner's aside became a message on this turn. */
  turnId?: string;
  /** A member's aside became its post at this journal seq. */
  postSeq?: number;
}

/** A plain-text control the host's agent carried out for the owner (§4.11 point 4), shown and reversible. */
export interface ConversationControlRecord {
  action: 'voice' | 'floor' | 'conch' | 'join' | 'leave' | 'outbound';
  /** The agent or member it changed (`host`, or a member's display name). */
  target?: string;
  before: string | null;
  after: string | null;
  /** `owner`: through the viewer or the owner's own message; `confirmed`: he confirmed the agent's ask. */
  by: 'owner' | 'confirmed';
}

export const emptyConversation = (): ConversationRecord => ({
  invitations: [],
  requests: [],
  settings: {},
});

/** Another party whose words a turn took in, and what they hold on the conversation now (§4.12). */
export interface TurnActor {
  member: ConversationMember;
  displayName: string;
  permissions: ConversationPermission[];
}

/** A member's post as the journal holds it (phase `member-post`). */
export interface MemberPostRecord {
  postId: string;
  /** Who posted: a Signet member (through Kingdom) or a local one (another thread on this machine). */
  member: ConversationMember;
  /** `<kind>:<id>` of `member`, top-level so the journal can match it in SQL (`phasesOf`). */
  memberKey: string;
  displayName: string;
  text: string;
  delivery: 'note' | 'turn';
  /** Admitted while agents were silent: a person talking, so it costs no agent turn (§4.9). */
  silent?: boolean;
  /** The Kingdom `AccessExecution` the post arrived under (a Signet member's post). */
  executionId?: string;
  /** The grant revision the post's frame carried (a Signet member's post). */
  acceptedRevision?: number;
  inReplyTo?: string;
  /** The turn the post opened (`delivery: 'turn'`). */
  turnId?: string;
  /** A report against a `notify` commission: the owner reads it, the other members never do. */
  notify?: boolean;
  /** Admitted as instructions (`agent.instruct`, §4.12); absent, the post is data. */
  posts?: 'instructions';
}

/**
 * Something this side holds for the owner before it leaves (§4.5): a send to a member of a hosted
 * conversation (`send`, readable once released), or a post into a conversation this Foundry joined
 * through a Signet it holds (`post`, delivered once released). Phase `outbound-held`; its answer is
 * an `outbound-resolution` row.
 */
export interface HeldRecord {
  heldId: string;
  kind: 'send' | 'post';
  text: string;
  /** `review`: held until the owner answers. `auto`: released as it was written. */
  outbound: 'review' | 'auto';
  status: 'pending' | 'released';
  /** `send`: the member it is addressed to. */
  to?: ConversationMember;
  toName?: string;
  /**
   * `send`: it asks the member's agent for work; its person fixed how the report comes back (M1).
   * `expiresAt` is set when the send is released, not drafted (round 5): a send released at once
   * carries it here, a reviewed one on its resolution.
   */
  commission?: { report: ThreadCommission['report']; expiresAt?: string };
  /** `post`: the access source (a held Signet) and the remote thread. */
  accessId?: string;
  remoteThreadId?: string;
  inReplyTo?: string;
  /** `post`: the member's own post id, kept across a retry. */
  postId?: string;
}

/** The owner's answer to a held item (phase `outbound-resolution`), self-contained for the view. */
export interface HeldResolutionRecord {
  heldId: string;
  kind: HeldRecord['kind'];
  to?: ConversationMember;
  toName?: string;
  commission?: ThreadCommission;
  action: 'released' | 'withdrawn';
  /** The text that left: as written, or as the owner edited it. */
  text: string;
  by: 'human' | 'policy' | 'timeout';
  /** Which surface answered: the viewer, an ACP host, or the owner's remote client. */
  surface?: string;
}

/** What Kingdom answered when a released `post` was delivered (phase `outbound-delivered`). */
export interface HeldDeliveryRecord {
  heldId: string;
  executionId?: string;
  error?: string;
}

/** What a thread's runtime asks of its conversation wrapper (`agents/thread-runtime.ts`). */
export interface ConversationWrapper {
  /** A conversation thread is always wrapped, so its notes reach the executor (§4.1). */
  wraps(threadId: string): boolean;
  /**
   * Member notes not yet delivered that ride this owner turn, labelled (§4.2, §4.5); marked
   * delivered to it.
   */
  deliverNotes(threadId: string, turnId: string | undefined): PromptBlock[];
  /**
   * Who is in and what each member may do, in plain words (§4.5); undefined: not a conversation.
   * `held`: the thread's context already carries a roster, so one is due even when no member is left.
   */
  roster(threadId: string, held?: boolean): string | undefined;
  /** The floor now, for the turn being sent; undefined: not a conversation. */
  floorNow(threadId: string): string | undefined;
  /** One admitted post, labelled, for the Wardens' between-turns pass on it. */
  notePost(
    threadId: string,
    member: ConversationMember,
    postId: string,
  ): { displayName: string; text: string } | undefined;
}

/** A wrapper bound later (the service exists once the viewer does); until then nothing is wrapped. */
export function lateConversationWrapper(
  resolve: () => ConversationWrapper | undefined,
): ConversationWrapper {
  return {
    wraps: (threadId) => resolve()?.wraps(threadId) ?? false,
    deliverNotes: (threadId, turnId) => resolve()?.deliverNotes(threadId, turnId) ?? [],
    roster: (threadId, held) => resolve()?.roster(threadId, held),
    floorNow: (threadId) => resolve()?.floorNow(threadId),
    notePost: (threadId, member, postId) => resolve()?.notePost(threadId, member, postId),
  };
}

export const MAX_HELD_TEXT = threadTextLimit;

/** A member's key in maps and journal matches: `<kind>:<id>`. */
export const memberKey = (member: ConversationMember) => `${member.kind}:${member.id}`;

/** The journal rows a conversation writes on its main thread (the ordered ones: `JOURNAL_ORDERED_PHASES`). */
export type ConversationPhase =
  | 'aside'
  | 'aside-promoted'
  | 'shared-entry'
  | 'shared-entry-delivered'
  | 'conversation-control'
  | 'member-post'
  | 'member-post-withdrawn'
  | 'member-post-delivered'
  | 'outbound-held'
  | 'outbound-resolution'
  | 'outbound-delivered';
