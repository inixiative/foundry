/**
 * @atlas
 * @kind type
 * @partOf feature:conversations
 */
import type { PromptBlock } from '@inixiative/foundry-core';
import { type ConversationMember, floorModeSchema, threadTextLimit } from '@inixiative/signet';
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
});
export type ConversationSettingsInput = z.infer<typeof conversationSettingsSchema>;

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
}

/** Proposals in the design (§10): talk, six agent turns, a five-minute conch the agent can't pass. */
export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = Object.freeze({
  floor: 'talk',
  maxAgentTurns: 6,
  conch: Object.freeze({ holdSeconds: 300, agentMayPass: false }),
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
  /** Members asking for the conch, newest last, until it moves. */
  requests: Array<{ member: ConversationMember; displayName: string; at: string }>;
  /** Per-thread overrides, the last step of the cascade. */
  settings: ConversationSettingsInput;
}

export const emptyConversation = (): ConversationRecord => ({
  invitations: [],
  requests: [],
  settings: {},
});

/** A member's post as the journal holds it (phase `member-post`). */
export interface MemberPostRecord {
  postId: string;
  signetId: string;
  displayName: string;
  text: string;
  delivery: 'note' | 'turn';
  /** The Kingdom `AccessExecution` the post arrived under. */
  executionId: string;
  acceptedRevision: number;
  inReplyTo?: string;
  /** The turn the post opened (`delivery: 'turn'`). */
  turnId?: string;
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
   * Who is in and each member's terms, in plain words (§4.5); undefined: not a conversation.
   * `held`: the thread's context already carries a roster, so one is due even when no member is left.
   */
  roster(threadId: string, held?: boolean): string | undefined;
  /** One admitted post, labelled, for the Wardens' between-turns pass on it. */
  notePost(
    threadId: string,
    signetId: string,
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
    notePost: (threadId, signetId, postId) => resolve()?.notePost(threadId, signetId, postId),
  };
}

export const MAX_HELD_TEXT = threadTextLimit;

/** The journal rows a conversation writes on its main thread (the ordered ones: `JOURNAL_ORDERED_PHASES`). */
export type ConversationPhase =
  | 'member-post'
  | 'member-post-withdrawn'
  | 'member-post-delivered'
  | 'outbound-held'
  | 'outbound-resolution'
  | 'outbound-delivered';
