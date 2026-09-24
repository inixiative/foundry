import { mkdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { computeHash, copyMessageIdentity, type LogicalMessageIdentity, type ContextSource, type SourceLoadHint, type SourceSelectionReport, REQUIRED_CONTEXT_BLOCKED } from "../context-layer";
import type { HydrationAdapter, ContextRef } from "../hydrator";
import { normalizeScope, type OwnershipScope } from "../scope";
import type { Signal } from "../signal";
import type { MemoryEntry, MemoryVisibility } from "../tools";

export type { MemoryEntry } from "../tools";

// ---------------------------------------------------------------------------
// Bounded selection — the retained log is complete; the injected text is not
// ---------------------------------------------------------------------------

/**
 * How a memory source chooses what to inject automatically. Every visible
 * record stays retrievable; this only governs the automatic message input.
 */
export interface MemorySelectionPolicy {
  /** Character budget for automatically selected content, excluding the omission summary. */
  readonly budgetChars: number;
  /** Kinds that are always injected, oldest first, and never dropped for budget. */
  readonly pinnedKinds: readonly string[];
  /** Runtime audit kinds retained in the log but never injected unless relevant to the message. */
  readonly auditOnlyKinds: readonly string[];
  /** Newest non-pinned, non-audit captures to consider. */
  readonly recentLimit: number;
  /** Longest single record injected verbatim; longer records are excerpted with a marker. */
  readonly maxEntryChars: number;
  /** Pinned records larger than this are named but not injected: a rule without its ending is not the rule. */
  readonly pinnedHardCapChars: number;
  /**
   * What happens to a pinned record above the hard cap. "inject": supply it in
   * full anyway (default; no scoped retrieval is assumed to exist). "block":
   * refuse to prepare model input and surface a `required-context-blocked`
   * conflict that the executor turns into an explicit error before any
   * provider call. Neither mode ever names a retrieval tool that may not exist.
   */
  readonly oversizedPinned: "inject" | "block";
  /** Most records retrieved for relevance to the current message. */
  readonly retrievalLimit: number;
  /** Distinct focus terms an audit record must match to be retrieved. Other kinds need one. */
  readonly auditRelevanceTerms: number;
}

export const DEFAULT_MEMORY_SELECTION: MemorySelectionPolicy = Object.freeze({
  budgetChars: 6000,
  pinnedKinds: Object.freeze(["instruction", "pin", "pinned", "convention", "correction", "decision", "requirement"]),
  auditOnlyKinds: Object.freeze(["dispatch", "classification", "context_loaded", "session_compacted",
    "auxiliary_session_compacted", "info", "domain_learning", "tool_observation"]),
  recentLimit: 8,
  maxEntryChars: 1200,
  pinnedHardCapChars: 24_000,
  oversizedPinned: "inject",
  retrievalLimit: 6,
  auditRelevanceTerms: 2,
});

const NUMERIC_BOUNDS: Record<string, readonly [number, number]> = {
  budgetChars: [200, 5_000_000], maxEntryChars: [50, 5_000_000], pinnedHardCapChars: [100, 50_000_000],
  recentLimit: [0, 10_000], retrievalLimit: [0, 10_000], auditRelevanceTerms: [1, 48],
};
const KIND_LISTS = new Set(["pinnedKinds", "auditOnlyKinds"]);

/**
 * Runtime validation for a selection policy override coming from persisted or
 * operator JSON, where the TypeScript interface gives no protection. Throws a
 * descriptive Error naming the offending field; returns a defensive copy.
 */
export function validateMemorySelection(input: unknown): Partial<MemorySelectionPolicy> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`memory selection policy must be an object, got ${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    // Own-property lookup: inherited names such as constructor or __proto__ are not policy fields.
    const bounds = Object.hasOwn(NUMERIC_BOUNDS, key) ? NUMERIC_BOUNDS[key] : undefined;
    if (bounds) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < bounds[0] || value > bounds[1]) {
        throw new Error(`memory selection policy ${key} must be an integer between ${bounds[0]} and ${bounds[1]}, got ${JSON.stringify(value)}`);
      }
      out[key] = value;
    } else if (KIND_LISTS.has(key)) {
      if (!Array.isArray(value) || value.length > 256 || value.some((k) => typeof k !== "string" || !k.trim() || k.length > 64)
        || new Set(value).size !== value.length) {
        throw new Error(`memory selection policy ${key} must be an array of unique non-empty strings, got ${JSON.stringify(value)}`);
      }
      out[key] = [...value];
    } else if (key === "oversizedPinned") {
      if (value !== "inject" && value !== "block") throw new Error(`memory selection policy oversizedPinned must be "inject" or "block", got ${JSON.stringify(value)}`);
      out[key] = value;
    } else {
      throw new Error(`memory selection policy has unknown field ${JSON.stringify(key)}`);
    }
  }
  if (typeof out.maxEntryChars === "number" && typeof out.budgetChars === "number" && out.maxEntryChars > out.budgetChars) {
    throw new Error(`memory selection policy maxEntryChars (${out.maxEntryChars}) cannot exceed budgetChars (${out.budgetChars})`);
  }
  return out as Partial<MemorySelectionPolicy>;
}

export type MemorySelectionReport = SourceSelectionReport;

const STOPWORDS = new Set(["that", "this", "with", "from", "have", "what", "when", "where", "which", "will", "would",
  "should", "could", "about", "there", "their", "these", "those", "does", "into", "only", "also", "than", "then",
  "them", "they", "your", "just", "like", "make", "made", "over", "under", "after", "before", "while", "please"]);

/** Deterministic terms from the current message: lowercase words of four or more letters, no stopwords. */
export function focusTerms(focus: string, max = 48): string[] {
  const seen = new Set<string>();
  for (const raw of focus.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const term = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (term.length < 4 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    if (seen.size >= max) break;
  }
  return [...seen];
}

type CharRange = readonly [number, number];
type Excerpt = { text: string; truncated: boolean; ranges?: CharRange[] };

/** Render the named character ranges of a record; every excerpt states exactly which parts of the record it carries. */
function renderRanges(entry: MemoryEntry, ranges: CharRange[]): string {
  const total = entry.content.length;
  const pieces = ranges.map(([a, b]) => `${a > 0 ? "… " : ""}${entry.content.slice(a, b)}${b < total ? " …" : ""}`);
  return `${pieces.join(" ")} [excerpt: chars ${ranges.map(([a, b]) => `${a}-${b}`).join(", ")} of ${total}; full record ${entry.id} retained in the owned log]`;
}

/** Leading excerpt for records selected by recency, where no particular passage is the point. */
function prefixExcerpt(entry: MemoryEntry, max: number): Excerpt {
  if (entry.content.length <= max) return { text: entry.content, truncated: false };
  const ranges: CharRange[] = [[0, max]];
  return { text: renderRanges(entry, ranges), truncated: true, ranges };
}

/**
 * Excerpt for records selected by relevance: windows around the first
 * occurrence of each matched term, merged and capped at `max` chars in total,
 * so the injected text carries the evidence that made the record relevant
 * rather than an unrelated prefix.
 */
function matchExcerpt(entry: MemoryEntry, matched: readonly string[], max: number): Excerpt {
  const total = entry.content.length;
  if (total <= max) return { text: entry.content, truncated: false };
  const lower = entry.content.toLowerCase();
  const hits = matched.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (!hits.length) return prefixExcerpt(entry, max);
  const width = Math.max(1, Math.floor(max / hits.length));
  const ranges: CharRange[] = [];
  for (const hit of hits) {
    const end = Math.min(total, Math.max(0, hit - Math.floor(width / 2)) + width);
    const start = Math.max(0, end - width);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) ranges[ranges.length - 1] = [last[0], Math.max(last[1], end)];
    else ranges.push([start, end]);
  }
  return { text: renderRanges(entry, ranges), truncated: true, ranges };
}

function line(entry: MemoryEntry, text: string, note?: string): string {
  const when = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp).toISOString() : "unknown time";
  return `[${entry.kind}] ${entry.id} (${when}${note ? `; ${note}` : ""}): ${text}`;
}

/**
 * Select what to inject from the records a reader may see. Pure and
 * deterministic: the same records, policy and focus always yield the same
 * text and report. Never mutates or drops a record from the log. Every
 * considered record ends in exactly one of `selected` or `omitted`.
 */
export function selectMemory(
  visible: readonly MemoryEntry[],
  policy: MemorySelectionPolicy = DEFAULT_MEMORY_SELECTION,
  focus?: string,
  currentMessage?: LogicalMessageIdentity,
): { text: string; report: MemorySelectionReport } {
  const identity = copyMessageIdentity(currentMessage);
  const entries = [...visible].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const pinned = new Set(policy.pinnedKinds);
  const audit = new Set(policy.auditOnlyKinds);
  const selected: MemorySelectionReport["selected"][number][] = [];
  const omitted = new Map<string, MemorySelectionReport["omitted"][number]>();
  const conflicts: MemorySelectionReport["conflicts"][number][] = [];
  const taken = new Set<string>();
  let used = 0;
  const omit = (e: MemoryEntry, reason: string) => omitted.set(e.id, { id: e.id, reason, chars: e.content.length, kind: e.kind });
  const select = (e: MemoryEntry, reason: string, rendered: string, extra: Partial<MemorySelectionReport["selected"][number]> = {}) => {
    used += rendered.length;
    taken.add(e.id);
    omitted.delete(e.id);
    selected.push({ id: e.id, reason, chars: rendered.length, kind: e.kind, timestamp: e.timestamp, ...extra });
  };
  const withExcerpt = (x: Excerpt) => (x.truncated ? { truncated: true, ranges: x.ranges } : {});

  // 1. Pinned: explicit instructions, conventions, corrections, decisions. Injected in full, never
  //    excerpted. A record beyond the hard cap is named, not paraphrased, so the model knows a rule
  //    exists that it must read before acting instead of receiving its introduction as the rule.
  const pinnedLines: string[] = [];
  const overBudget: string[] = [];
  const oversized: string[] = [];
  for (const entry of entries) {
    if (!pinned.has(entry.kind)) continue;
    if (entry.content.length > policy.pinnedHardCapChars) {
      oversized.push(entry.id);
      if (policy.oversizedPinned === "block") {
        // A mandatory record that cannot be carried is a reason to stop, not a
        // note to the model. The executor refuses provider execution on this conflict.
        const notice = line(entry, `BLOCKED: ${entry.content.length} chars exceeds the ${policy.pinnedHardCapChars}-char pinned cap and no scoped retrieval is available. Execution must not proceed without this record.`);
        used += notice.length;
        pinnedLines.push(notice);
        taken.add(entry.id);
        omit(entry, REQUIRED_CONTEXT_BLOCKED);
        continue;
      }
    }
    // Pinned records are carried in full: a rule without its ending is not the rule.
    const rendered = line(entry, entry.content);
    if (used + rendered.length > policy.budgetChars) overBudget.push(entry.id);
    pinnedLines.push(rendered);
    select(entry, "pinned", rendered);
  }
  if (overBudget.length) {
    conflicts.push({ kind: "pinned-over-budget", ids: overBudget,
      detail: `Pinned records exceed the ${policy.budgetChars}-char budget; they are injected in full anyway and the overrun is visible here.` });
  }
  if (oversized.length) {
    conflicts.push(policy.oversizedPinned === "block"
      ? { kind: REQUIRED_CONTEXT_BLOCKED, ids: oversized,
          detail: `Pinned records larger than the ${policy.pinnedHardCapChars}-char cap cannot be carried and no scoped retrieval is available; provider execution is refused until an operator raises the cap or supplies retrieval.` }
      : { kind: "pinned-oversized", ids: oversized,
          detail: `Pinned records larger than the ${policy.pinnedHardCapChars}-char cap were injected in full because no scoped retrieval is available; the overrun is visible here.` });
  }

  // The current request's own audit is not independent evidence for it.
  // Pinning wins above; owner and explicit message identity must both match.
  // Text matches, nested IDs and legacy records without an owner prove nothing.
  for (const entry of entries) {
    if (!identity || taken.has(entry.id) || !audit.has(entry.kind) || !sameOwner(entry.owner, identity)) continue;
    let content: unknown;
    try { content = JSON.parse(entry.content); } catch { continue; }
    if (!content || typeof content !== "object" || Array.isArray(content) ||
      !("messageId" in content) || content.messageId !== identity.messageId) continue;
    taken.add(entry.id);
    omitted.set(entry.id, { id: entry.id, kind: entry.kind, chars: entry.content.length,
      reason: "current-message-audit", excludedFor: identity });
  }

  // 2. Relevant to this message: retrieved across every visible kind, audit kinds need a stronger match.
  const terms = focus ? focusTerms(focus) : [];
  const relevantLines: string[] = [];
  if (terms.length) {
    const scored = entries
      .filter((e) => !taken.has(e.id))
      .map((e) => {
        const lower = e.content.toLowerCase();
        const matched = terms.filter((t) => lower.includes(t));
        return { e, matched };
      })
      .filter(({ e, matched }) => matched.length >= (audit.has(e.kind) ? policy.auditRelevanceTerms : 1))
      .sort((a, b) => b.matched.length - a.matched.length || b.e.timestamp - a.e.timestamp || a.e.id.localeCompare(b.e.id));
    for (const { e, matched } of scored) {
      if (relevantLines.length >= policy.retrievalLimit) { omit(e, "retrieval-limit"); continue; }
      const x = matchExcerpt(e, matched, policy.maxEntryChars);
      const rendered = line(e, x.text, `matched: ${matched.join(", ")}`);
      if (used + rendered.length > policy.budgetChars) { omit(e, "budget"); continue; }
      relevantLines.push(rendered);
      select(e, "relevant", rendered, { matched, ...withExcerpt(x) });
    }
  }

  // 3. Recent captures: newest non-audit records within the budget. A record left out above may
  //    still be selected here; `select` clears its earlier omission so the sets stay disjoint.
  const recentLines: string[] = [];
  let recentSeen = 0;
  for (const entry of [...entries].reverse()) {
    if (taken.has(entry.id) || pinned.has(entry.kind)) continue;
    if (audit.has(entry.kind)) { omit(entry, "audit-only"); continue; }
    recentSeen += 1;
    if (recentSeen > policy.recentLimit) { omit(entry, "recent-limit"); continue; }
    const x = prefixExcerpt(entry, policy.maxEntryChars);
    const rendered = line(entry, x.text);
    if (used + rendered.length > policy.budgetChars) { omit(entry, "budget"); continue; }
    recentLines.push(rendered);
    select(entry, "recent", rendered, withExcerpt(x));
  }

  // 4. Omission summary in the injected text itself, so the model and the operator see the same account.
  const omittedList = [...omitted.values()];
  const auditOmitted = omittedList.filter((o) => o.reason === "audit-only" || o.reason === "current-message-audit");
  const currentAuditCount = omittedList.filter((o) => o.reason === "current-message-audit").length;
  const otherOmitted = omittedList.length - auditOmitted.length;
  const byKind = new Map<string, number>();
  for (const o of auditOmitted) byKind.set(o.kind ?? "unknown", (byKind.get(o.kind ?? "unknown") ?? 0) + 1);
  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", ");
  const retainedChars = entries.reduce((sum, e) => sum + e.content.length, 0);
  const summary = [
    `${auditOmitted.length} audit records (${auditOmitted.reduce((s, o) => s + o.chars, 0)} chars${kinds ? `; ${kinds}` : ""})` +
      ` and ${otherOmitted} other captures were not injected.`,
    `The complete owned log (${entries.length} records, ${retainedChars} chars) is retained unchanged; records not shown here were not supplied to this turn.`,
    ...(currentAuditCount ? [`${currentAuditCount} records were excluded as the current message's own audit (matched logical message, thread and project identity).`] : []),
    `Selection budget ${policy.budgetChars} chars, used ${used}${used > policy.budgetChars ? " (exceeded by pinned records)" : ""}.`,
  ].join(" ");

  const sections: string[] = [];
  if (pinnedLines.length) sections.push(`## Pinned (${pinnedLines.length})\n${pinnedLines.join("\n")}`);
  if (relevantLines.length) sections.push(`## Relevant to this message (${relevantLines.length})\n${relevantLines.join("\n")}`);
  if (recentLines.length) sections.push(`## Recent captures (${recentLines.length})\n${recentLines.join("\n")}`);
  sections.push(`## Not injected\n${summary}`);

  return {
    text: sections.join("\n\n"),
    report: {
      selected, omitted: omittedList, considered: entries.length,
      retained: { count: entries.length, chars: retainedChars },
      budget: { chars: policy.budgetChars, used, exceeded: used > policy.budgetChars },
      conflicts,
      ...(identity ? { currentMessage: identity } : {}),
      ...(focus ? { focus: { hash: computeHash(focus), terms: terms.length } } : {}),
    },
  };
}

/**
 * What a reader may see. Thread/project identify the reader; `includeUnowned`
 * is the explicit opt-in for legacy records written before ownership existed.
 */
export interface MemoryReadScope extends OwnershipScope {
  readonly includeUnowned?: boolean;
}

/** Options for a memory-backed ContextSource. */
export interface MemorySourceOpts {
  /** Only entries of this kind. */
  kind?: string;
  /**
   * Widest visibility the source exposes once bound to a thread:
   * - "thread" (default): the thread's own entries plus project/global publications.
   * - "project": project and global publications only (never another thread's captures).
   * - "global": global publications only, identical for every thread and project.
   */
  scope?: MemoryVisibility;
  /** Expose unowned legacy records too. Off by default; a deliberate compatibility choice. */
  includeUnowned?: boolean;
  /**
   * Bounded automatic selection instead of the full formatted log. An object
   * overrides the default policy; `false` keeps the legacy full dump. Absent
   * means legacy behaviour so existing callers are unchanged.
   */
  selection?: Partial<MemorySelectionPolicy> | false;
}

/** Whether one entry is visible to a reader. */
export function entryVisibleTo(entry: MemoryEntry, scope: MemoryReadScope): boolean {
  switch (entry.visibility) {
    case "global":
      return true;
    case "project":
      return !!scope.projectId && entry.owner?.projectId === scope.projectId;
    case "thread":
      // A thread id alone is not identity: the owner's project must match too,
      // so a same-named thread in another project cannot read it.
      return (
        !!scope.threadId &&
        entry.owner?.threadId === scope.threadId &&
        (!entry.owner?.projectId || entry.owner.projectId === scope.projectId)
      );
    default:
      return scope.includeUnowned === true;
  }
}

/** Whether two owners are the same thread and project. */
function sameOwner(a: OwnershipScope | undefined, b: OwnershipScope | undefined): boolean {
  const x = normalizeScope(a);
  const y = normalizeScope(b);
  return x.threadId === y.threadId && x.projectId === y.projectId;
}

/** Readers get copies: a caller can never mutate the stored record by reference. */
function copyEntry(entry: MemoryEntry): MemoryEntry {
  return structuredClone(entry);
}

function formatEntries(entries: MemoryEntry[]): string {
  return entries
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((e) => `[${e.kind}] ${e.id}: ${e.content}`)
    .join("\n");
}

/**
 * A simple file-based memory system.
 *
 * Stores entries as JSON files in a directory. Each entry has an id,
 * content, kind, timestamp, and (for anything captured after ownership
 * existed) an owner and visibility. No external deps — just the filesystem.
 *
 * Reads for a thread go through `view(scope)`; the unscoped methods below
 * are the operator's whole-store view and must not be handed to a thread.
 *
 * Use this as the default built-in memory. Swap for pgvector, Redis,
 * MuninnDB, etc. in production.
 */
export class FileMemory {
  readonly dir: string;
  private _entries: Map<string, MemoryEntry> = new Map();
  private _loaded = false;

  constructor(dir: string) {
    this.dir = resolve(dir);
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Resolve an entry path safely — prevents path traversal. */
  private _safePath(id: string): string {
    const safe = id.replace(/[\/\\\.]+/g, "_");
    const path = join(this.dir, `${safe}.json`);
    const rel = relative(this.dir, resolve(path));
    if (rel.startsWith("..") || rel.includes("/..")) {
      throw new Error(`Invalid entry id: ${id}`);
    }
    return path;
  }

  /** Load all entries from disk. */
  async load(): Promise<void> {
    const files = new Bun.Glob("*.json").scanSync(this.dir);
    for (const file of files) {
      const path = join(this.dir, file);
      const data = await Bun.file(path).json();
      this._entries.set(data.id, data as MemoryEntry);
    }
    this._loaded = true;
  }

  /** Ensure entries are loaded (idempotent). */
  async ensureLoaded(): Promise<void> {
    if (!this._loaded) await this.load();
  }

  /** Write an entry to memory exactly as given (owner/visibility included). */
  async write(entry: MemoryEntry): Promise<void> {
    this._entries.set(entry.id, entry);
    const path = this._safePath(entry.id);
    await Bun.write(path, JSON.stringify(entry, null, 2));
  }

  /**
   * Change who may read an existing entry. Publishing to a project requires
   * the entry to have a project owner; the owner itself never changes.
   */
  async publish(id: string, visibility: MemoryVisibility): Promise<MemoryEntry> {
    const entry = this._entries.get(id);
    if (!entry) throw new Error(`Memory entry not found: ${id}`);
    if (visibility === "project" && !entry.owner?.projectId) {
      throw new Error(`Cannot publish "${id}" to a project: it has no project owner`);
    }
    if (visibility === "thread" && !entry.owner?.threadId) {
      throw new Error(`Cannot restrict "${id}" to a thread: it has no thread owner`);
    }
    const updated = { ...entry, visibility };
    await this.write(updated);
    return updated;
  }

  /** Read an entry by id. */
  get(id: string): MemoryEntry | undefined {
    return this._entries.get(id);
  }

  /** Get all entries, optionally filtered by kind. */
  all(kind?: string): MemoryEntry[] {
    const entries = [...this._entries.values()];
    return kind ? entries.filter((e) => e.kind === kind) : entries;
  }

  /** Search entries by content substring. */
  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return [...this._entries.values()].filter((e) =>
      e.content.toLowerCase().includes(lower)
    );
  }

  /** Delete an entry. Removes from disk first to prevent desync. */
  async delete(id: string): Promise<boolean> {
    if (!this._entries.has(id)) return false;
    const path = this._safePath(id);
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(path);
    } catch (err) {
      console.warn(`[FileMemory] unlink failed for "${id}":`, (err as Error).message);
    }
    this._entries.delete(id);
    return true;
  }

  /** Get all entries as a formatted string (for use as context). */
  toContext(): string {
    const entries = [...this._entries.values()];
    if (entries.length === 0) return "(no entries)";
    return formatEntries(entries);
  }

  /** A reader/writer restricted to what one thread or project may see. */
  view(scope: MemoryReadScope): MemoryView {
    return new MemoryView(this, scope);
  }

  /**
   * Create a ContextSource over this memory. Unbound, it exposes only
   * globally published entries; `bind(scope)` narrows or widens per the
   * source's declared scope for the owning thread/project.
   */
  asSource(id: string, opts?: string | MemorySourceOpts): ContextSource {
    const options: MemorySourceOpts = typeof opts === "string" ? { kind: opts } : opts ?? {};
    const mem = this;
    const policy: MemorySelectionPolicy | undefined = options.selection === undefined || options.selection === false
      ? undefined
      : { ...DEFAULT_MEMORY_SELECTION, ...validateMemorySelection(options.selection) };

    const make = (bound: OwnershipScope): ContextSource => {
      let lastReport: MemorySelectionReport | undefined;
      const readScope = (): MemoryReadScope => ({
        // Resolve the bound scope at load time: a thread's project may be
        // assigned after creation, and every refresh must honor it.
        ...(options.scope === "global"
          ? {}
          : options.scope === "project"
            ? { projectId: bound.projectId }
            : { threadId: bound.threadId, projectId: bound.projectId }),
        includeUnowned: options.includeUnowned,
      });
      const source: ContextSource = {
        id,
        async load(hint?: SourceLoadHint) {
          await mem.ensureLoaded();
          const entries = mem.view(readScope()).all(options.kind);
          if (!policy) {
            if (entries.length === 0) return "";
            return formatEntries(entries);
          }
          // A load hint cannot impersonate another visible record's owner.
          const identity = hint?.currentMessage && sameOwner(bound, hint.currentMessage) ? hint.currentMessage : undefined;
          const { text, report } = selectMemory(entries, policy, hint?.focus, identity);
          lastReport = report;
          return text;
        },
        bind: (scope) => make(scope),
      };
      if (policy) {
        return { ...source, focusable: true, report: () => lastReport };
      }
      return source;
    };

    return make({});
  }

  /** Create a HydrationAdapter for this memory system. */
  asAdapter(): HydrationAdapter {
    const mem = this;
    return {
      system: "file-memory",
      async hydrate(ref: ContextRef): Promise<string> {
        await mem.ensureLoaded();
        const entry = mem.get(ref.locator);
        return entry ? entry.content : "";
      },
      async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
        await mem.ensureLoaded();
        return refs.map((r) => {
          const entry = mem.get(r.locator);
          return entry ? entry.content : "";
        });
      },
    };
  }

  /**
   * Create a signal handler that writes signals to this memory.
   * Wire this into a thread's bus via the runtime, which supplies the owner;
   * captured signals are private to that owner. Without an owner the entry
   * is written unowned and stays hidden from every scoped read.
   */
  signalWriter() {
    const mem = this;
    return async (signal: Signal, owner?: OwnershipScope): Promise<void> => {
      const scope = normalizeScope(owner);
      const entry: MemoryEntry = {
        id: signal.id,
        kind: signal.kind,
        content:
          typeof signal.content === "string"
            ? signal.content
            : JSON.stringify(signal.content),
        source: signal.source,
        timestamp: signal.timestamp,
        meta: { confidence: signal.confidence, refs: signal.refs },
        ...(scope.threadId
          ? { owner: scope, visibility: "thread" as const }
          : scope.projectId
            ? { owner: scope, visibility: "project" as const }
            : {}),
      };
      await mem.write(entry);
    };
  }
}

/**
 * Scoped reader/writer over a FileMemory. Reads never return entries the
 * scope may not see; writes are owned by the scope and private by default.
 * Publishing is explicit: pass `visibility: "project"` or `"global"`.
 */
export class MemoryView {
  readonly scope: MemoryReadScope;
  private _memory: FileMemory;

  constructor(memory: FileMemory, scope: MemoryReadScope) {
    this._memory = memory;
    this.scope = scope;
  }

  private _visible(entry: MemoryEntry | undefined): entry is MemoryEntry {
    return !!entry && entryVisibleTo(entry, this.scope);
  }

  get(id: string): MemoryEntry | undefined {
    const entry = this._memory.get(id);
    return this._visible(entry) ? copyEntry(entry) : undefined;
  }

  all(kind?: string): MemoryEntry[] {
    return this._memory.all(kind).filter((e) => this._visible(e)).map(copyEntry);
  }

  search(query: string, limit?: number): MemoryEntry[] {
    const hits = this._memory.search(query).filter((e) => this._visible(e)).map(copyEntry);
    return limit === undefined ? hits : hits.slice(0, limit);
  }

  recent(limit = 20, kind?: string): MemoryEntry[] {
    return this.all(kind)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Write an entry owned by this scope. Private unless a wider visibility is
   * declared. An existing id may only be rewritten by its owner: another
   * scope cannot replace a record it cannot see, nor one it can merely read,
   * and unowned legacy records are never overwritten through a scoped view.
   */
  async write(entry: MemoryEntry): Promise<void> {
    const owner = normalizeScope(this.scope);
    const visibility = entry.visibility ?? "thread";
    if (visibility === "thread" && !owner.threadId) {
      throw new Error(`Cannot write thread-private entry "${entry.id}" without a thread scope`);
    }
    if (visibility === "project" && !owner.projectId) {
      throw new Error(`Cannot publish "${entry.id}" to a project without a project scope`);
    }
    const existing = this._memory.get(entry.id);
    if (existing) {
      if (!existing.owner) {
        throw new Error(`Cannot overwrite unowned legacy record "${entry.id}" through a scoped view`);
      }
      if (!sameOwner(existing.owner, owner)) {
        throw new Error(`Cannot overwrite "${entry.id}": it is owned by another thread or project`);
      }
    }
    await this._memory.write({ ...entry, owner, visibility });
  }

  /**
   * Delete an entry this scope owns. Invisible entries and records merely
   * published to this scope are reported as not found; reading never grants
   * deletion.
   */
  async delete(id: string): Promise<boolean> {
    const entry = this._memory.get(id);
    if (!this._visible(entry)) return false;
    if (!sameOwner(entry.owner, this.scope)) return false;
    return this._memory.delete(id);
  }
}

/**
 * Simple file-based doc source — reads a file and returns its content.
 */
export function fileSource(id: string, path: string): ContextSource {
  return {
    id,
    async load() {
      const file = Bun.file(path);
      if (!(await file.exists())) return "";
      return file.text();
    },
  };
}

/**
 * Inline source — just returns a static string. Useful for testing.
 */
export function inlineSource(id: string, content: string): ContextSource {
  return {
    id,
    async load() {
      return content;
    },
  };
}
