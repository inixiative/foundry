import { computeHash } from './context-layer';
import type { PromptBlock } from './context-stack';

/** One standing part of a thread's context (a layer with its prompt, or the agent's own prompt), keyed by content hash. */
export interface StandingPart {
  readonly id: string;
  readonly hash: string;
  readonly text: string;
}

/**
 * A turn's context split for a provider that keeps a native session. Standing parts go into the
 * session's system prompt once, when the session starts; afterwards only parts whose hash differs
 * from what the session holds are sent with the turn. The per-turn text is sent every turn.
 */
export interface SessionDelivery {
  /** Every standing part, in context order. */
  readonly standing: readonly StandingPart[];
  /** Per-turn context (routing, Warden advice); sent with every turn. */
  readonly turn: string;
  /**
   * The thread's delivery ledger: part id → hash the session holds from an earlier turn's message.
   * Cleared on compaction, reset when a session starts.
   */
  readonly held: Readonly<Record<string, string>>;
}

export interface DeliveredPart {
  readonly id: string;
  readonly hash: string;
}

/** What a session provider actually delivered for one turn. */
export interface SessionDeliveryReport {
  /** "started": this turn ran on a session that started with `base` as its system prompt. */
  readonly session: 'started' | 'held';
  /** The parts the session's system prompt carries. */
  readonly base: readonly DeliveredPart[];
  /** Standing parts sent in this turn's message because the session did not hold their hash. */
  readonly sent: readonly DeliveredPart[];
  /**
   * A started session that resumed the conversation the thread's ledger describes (a relaunch in
   * this process): the ledger still holds, so it is kept and extended rather than reset.
   */
  readonly ledgerKept?: true;
}

/** Group assembled layer blocks (a layer's prompt block, then its content block) into standing parts. */
export function standingParts(blocks: readonly PromptBlock[]): StandingPart[] {
  const parts: Array<{ id: string; texts: string[] }> = [];
  for (const block of blocks) {
    const id = block.id ?? `${block.role}:${parts.length}`;
    const last = parts.at(-1);
    if (last && last.id === id) last.texts.push(block.text);
    else parts.push({ id, texts: [block.text] });
  }
  // Two layers may share an id (a configured layer and a runtime-owned one); each is its own part.
  const seen = new Map<string, number>();
  return parts.map(({ id, texts }) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return standingPart(n === 1 ? id : `${id}#${n}`, texts.join('\n\n'));
  });
}

/** A warm layer as the standing part the executor assembles: its prompt, then its content. */
export function layerPart(layer: { id: string; prompt?: string; content: string }): StandingPart {
  return standingPart(
    layer.id,
    layer.prompt ? `${layer.prompt}\n\n${layer.content}` : layer.content,
  );
}

export function standingPart(id: string, text: string): StandingPart {
  return { id, hash: computeHash(text), text };
}
