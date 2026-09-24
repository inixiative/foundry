import type { AssembledContext, PromptBlock } from "./context-stack";
import { computeHash } from "./context-layer";
import type { LayerInstanceState, LogicalMessageIdentity } from "./context-layer";
import type { LLMMessage } from "./types";

export type InjectionSegmentKind =
  | "instructions"
  | "domain-knowledge"
  | "thread-knowledge"
  | "routing"
  | "guard-findings";

export interface InjectionBlock {
  readonly id: string;
  readonly kind: InjectionSegmentKind;
  readonly source: string;
  readonly text: string;
  readonly hash: string;
  readonly tokens: number;
  readonly freshness?: {
    readonly state?: string;
    readonly lastWarmed?: number | null;
  };
}

/** One decorator's recorded participation in a turn. */
export interface DecorationParticipant {
  readonly id: string;
  /** contribute | abstain | error | timeout | omitted */
  readonly decision: string;
  readonly reason?: string;
  /** The three named inputs the participant worked from, never inferred. */
  readonly segments: {
    readonly instructions: string;
    readonly domainKnowledge: string;
    readonly threadKnowledge: string;
  };
  readonly provenance: Record<string, unknown>;
  /**
   * The provider input this participant supplied at its phase, frozen at the call boundary, or
   * that no call was made. Absent on records written before capture existed. Recording the input
   * is evidence of what was supplied to the provider interface, not that a native model received it.
   */
  readonly request?: ParticipantRequest;
}

/** What one participant supplied to its provider at one phase, or why it made no call. */
export type ParticipantRequest =
  | {
      readonly status: "supplied";
      readonly phase: string;
      readonly providerId: string;
      readonly messages: readonly LLMMessage[];
      readonly capturedAt: number;
    }
  | { readonly status: "not-sent"; readonly phase: string; readonly reason: string }
  /** A call may have been made, but its input was never observed (e.g. the caller threw first). Not "not-sent". */
  | { readonly status: "unobserved"; readonly phase: string; readonly reason: string };

/**
 * The composed, immutable decoration delivered alongside a user message:
 * the blocks appended to the executor context plus who contributed them.
 */
export interface MessageDecoration {
  readonly input: { readonly hash: string; readonly capturedAt: number; readonly currentMessage?: LogicalMessageIdentity };
  readonly blocks: PromptBlock[];
  readonly participants: DecorationParticipant[];
  readonly omissions: Array<{ readonly id: string; readonly reason: string }>;
  readonly conflicts: Array<{ readonly kind: string; readonly id: string; readonly detail: string }>;
}

/**
 * What a completed dispatch actually delivered, per included layer, against
 * what the decorator assessed. Attached to `ExecutionResult.meta.delivery`
 * by the runtime after the delivery ledger is committed.
 */
export interface DeliveryRecord {
  readonly layers: Array<{
    readonly id: string;
    readonly threadId?: string;
    readonly projectId?: string;
    /** Domain that owns this layer, when a participant assessed it. */
    readonly domain?: string;
    /** Hash the decorator assessed, when a domain owns this layer. */
    readonly assessedHash?: string;
    /** Owner revision the decorator assessed, for owner-versioned layers. */
    readonly assessedRevision?: number;
    /** Hash the executor assembled and sent. */
    readonly deliveredHash: string;
    /** Owner revision of the bytes actually assembled, from the layer's own version mark at assembly. */
    readonly deliveredRevision?: number;
    /**
     * How the delivered snapshot relates to the assessed one: the same revision, a later revision committed
     * between assessment and assembly, no owner mark on the delivered bytes, or an inconsistent pair.
     */
    readonly relation?: "assessed" | "advanced" | "unknown" | "inconsistent";
    /** True when the layer changed between assessment and delivery. */
    readonly drift: boolean;
  }>;
  /** Layer ids committed to the delivery ledger. */
  readonly committed: string[];
  /**
   * How the turn treated learning still pending from earlier work:
   * `pending` means preparation continued immediately with committed knowledge.
   * `settled` and `timeout` are retained for historical artifacts.
   */
  readonly learningBarrier?: {
    readonly outcome: "none" | "settled" | "timeout" | "pending" | "closed";
    readonly closed?: ReadonlyArray<{ domain: string; reason: string }>;
    readonly waitedMs: number;
    readonly pending: Array<{ readonly domain: string; readonly reviews: number }>;
    readonly stale: string[];
  };
}

export interface InjectionArtifact {
  readonly capturedAt?: number;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly messageId?: string;
  /** Integrity-bound initial provider callback; never a native acknowledgment. */
  readonly providerBoundary?: import("./delivery-evidence").ProviderBoundaryReceipt;
  readonly userMessage: string;
  readonly blocks: InjectionBlock[];
  /** Decoration delivered with this turn, when a decorator ran. */
  readonly decoration?: MessageDecoration;
  /** The sealed pre-message plan that produced the decoration. */
  readonly plan?: unknown;
  /** Segmented reading view, not the provider's wire format. */
  readonly text: string;
  readonly tokens: number;
  readonly executorContext?: string;
  /** Initial provider messages, before native-runtime wrapping or tool followups. */
  readonly providerMessages?: LLMMessage[];
  readonly layers?: Array<LayerInstanceState & {
    id: string;
    prompt?: string;
    sourceIds: string[];
    included: boolean;
  }>;
}

export interface BuildInjectionArtifactOpts {
  readonly userMessage: string;
  readonly assembled: AssembledContext;
  readonly layerFreshness?: Record<string, { state?: string; lastWarmed?: number | null }>;
  readonly routing?: string;
  readonly guardFindings?: string;
  /** Decoration blocks are appended after the assembled layers, in order. */
  readonly decoration?: MessageDecoration;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function segmentKindForBlock(block: PromptBlock): InjectionSegmentKind {
  if (block.role === "system") return "instructions";
  if (block.role === "layer") return "instructions";
  if (block.id === "__thread-state" || block.id === "thread-state" || block.id === "memory") {
    return "thread-knowledge";
  }
  return "domain-knowledge";
}

function blockTitle(kind: InjectionSegmentKind): string {
  switch (kind) {
    case "routing":
      return "Tags / Routing";
    case "instructions":
      return "Instructions";
    case "domain-knowledge":
      return "Domain Knowledge";
    case "thread-knowledge":
      return "Thread State";
    case "guard-findings":
      return "Prior Guard Findings";
  }
}

function makeBlock(
  kind: InjectionSegmentKind,
  source: string,
  text: string,
  freshness?: InjectionBlock["freshness"],
): InjectionBlock {
  return {
    id: `${kind}:${source}:${computeHash(text)}`,
    kind,
    source,
    text,
    hash: computeHash(text),
    tokens: estimateTextTokens(text),
    freshness,
  };
}

/**
 * Build a segmented reading view of the context supplied to an executor.
 *
 * The artifact keeps Foundry's intervention boundaries visible: the user
 * message remains separate from injected routing, instructions, domain
 * knowledge, thread state, and guard findings.
 */
export function buildInjectionArtifact(opts: BuildInjectionArtifactOpts): InjectionArtifact {
  const blocks: InjectionBlock[] = [];

  if (opts.routing?.trim()) {
    blocks.push(makeBlock("routing", "route", opts.routing.trim()));
  }

  for (const block of [...opts.assembled.blocks, ...(opts.decoration?.blocks ?? [])]) {
    if (!block.text.trim()) continue;
    // An explicit segment always wins; the id heuristic only classifies plain layers.
    const kind = (block.segment as InjectionSegmentKind | undefined) ?? segmentKindForBlock(block);
    const source = block.source ?? block.id ?? block.role;
    blocks.push(makeBlock(kind, source, block.text, block.id ? opts.layerFreshness?.[block.id] : undefined));
  }

  if (opts.guardFindings?.trim()) {
    blocks.push(makeBlock("guard-findings", "guards", opts.guardFindings.trim()));
  }

  const sections = [
    "# User Message",
    opts.userMessage,
    "# Foundry Injection",
  ];

  const byKind = new Map<InjectionSegmentKind, InjectionBlock[]>();
  for (const block of blocks) {
    const existing = byKind.get(block.kind) ?? [];
    existing.push(block);
    byKind.set(block.kind, existing);
  }

  const order: InjectionSegmentKind[] = [
    "routing",
    "instructions",
    "domain-knowledge",
    "thread-knowledge",
    "guard-findings",
  ];

  for (const kind of order) {
    const grouped = byKind.get(kind);
    if (!grouped?.length) continue;
    sections.push(`## ${blockTitle(kind)}`);
    sections.push(grouped.map((block) => block.text).join("\n\n"));
  }

  const text = sections.join("\n\n");
  return {
    userMessage: opts.userMessage,
    blocks,
    text,
    tokens: estimateTextTokens(text),
    ...(opts.decoration ? { decoration: opts.decoration } : {}),
  };
}

/**
 * Convert an AssembledContext (from stack.assemble()) into LLMMessages
 * ready for any provider.
 */
export function assembledToMessages(
  assembled: AssembledContext,
  userPayload: string
): LLMMessage[] {
  const messages: LLMMessage[] = [];

  if (assembled.blocks.length > 0) {
    const systemParts: string[] = [];

    for (const block of assembled.blocks) {
      if (block.role === "system") {
        systemParts.push(block.text);
      } else if (block.role === "layer") {
        systemParts.push(`[${block.id}]: ${block.text}`);
      } else if (block.role === "content") {
        systemParts.push(block.text);
      }
    }

    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  messages.push({ role: "user", content: userPayload });

  return messages;
}

/**
 * Split LLMMessages into provider-friendly parts.
 */
export function splitSystemMessage(messages: LLMMessage[]): {
  system: string | undefined;
  turns: LLMMessage[];
} {
  const systemParts: string[] = [];
  const turns: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      turns.push(msg);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    turns,
  };
}
