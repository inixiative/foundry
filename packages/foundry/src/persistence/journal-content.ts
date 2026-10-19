/**
 * @atlas
 * @kind service
 * @partOf primitive:journal
 */
import { createHash } from 'node:crypto';

/**
 * Journal records reference their bulk by hash instead of embedding it. Every Warden's request and
 * segments carry the same composed instructions turn after turn, and a turn's injection artifact is
 * recorded on its message and again on its trace; stored once in `session_content`, a record holds a
 * reference in each place and reads back whole.
 *
 * - Text of at least `CONTENT_REF_MIN` chars becomes `{ $content: <sha256>, chars }`, or, when it
 *   has several sections, `{ $chunks: <sha256 of the section hash list>, chars }`: a Warden's request
 *   repeats its composed knowledge inside a per-turn message, and only the changed sections are new.
 * - An object or array at depth `JSON_REF_DEPTH` or deeper whose JSON (its own bulk already
 *   referenced) is at least `CONTENT_REF_MIN` bytes becomes `{ $json: <sha256>, bytes }`. Shallower
 *   structure stays inline, so the store's SQL projections (`$.meta.injection`, `$.content.domain`,
 *   `$.summary`) still read it.
 */
export const CONTENT_REF_MIN = 1024;
export const JSON_REF_DEPTH = 3;
/** Sections start at a markdown heading once a chunk holds `CHUNK_MIN` chars; none grows past `CHUNK_MAX` at a line end. */
const CHUNK_MIN = 512;
const CHUNK_MAX = 8192;

export interface ContentRef {
  readonly $content: string;
  readonly chars: number;
}

export interface ChunksRef {
  readonly $chunks: string;
  readonly chars: number;
}

export interface JsonRef {
  readonly $json: string;
  readonly bytes: number;
}

/** Recorded on a record whose bulk was moved out to keep its row under its limit. */
export interface SpillNote {
  readonly reason: string;
  readonly limit: number;
  /** Bytes of the row before spilling (bulk below `JSON_REF_DEPTH` already referenced). */
  readonly bytes: number;
  readonly paths: string[];
}

/**
 * Where content lives: `put` stores text (with the hashes it references, for a section list or a
 * nested record) and returns its hash; `get` returns the text for a hash.
 */
export interface ContentStore {
  put(text: string, references?: readonly string[]): string;
  get(hash: string): string;
}

const REFERENCE = /"\$(?:content|chunks|json)":"([0-9a-f]{64})"/g;

/** The hashes a stored JSON text references directly. */
export const referencedHashes = (json: string): string[] => [
  ...new Set([...json.matchAll(REFERENCE)].map((match) => match[1]!)),
];

export const contentHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const HASH = /^[0-9a-f]{64}$/;

function isRef(value: unknown, key: string, size: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const hash = (value as Record<string, unknown>)[key];
  return (
    keys.length === 2 &&
    keys.includes(key) &&
    keys.includes(size) &&
    typeof hash === 'string' &&
    HASH.test(hash)
  );
}

export const isContentRef = (value: unknown): value is ContentRef =>
  isRef(value, '$content', 'chars');
export const isChunksRef = (value: unknown): value is ChunksRef => isRef(value, '$chunks', 'chars');
export const isJsonRef = (value: unknown): value is JsonRef => isRef(value, '$json', 'bytes');
const isAnyRef = (value: unknown) => isContentRef(value) || isChunksRef(value) || isJsonRef(value);

/** Split text at content-defined places (headings, else line ends past `CHUNK_MAX`), so an edit moves few boundaries. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split(/(?<=\n)/)) {
    if (
      current.length >= CHUNK_MIN &&
      (line.startsWith('#') || current.length + line.length > CHUNK_MAX)
    ) {
      chunks.push(current);
      current = '';
    }
    current += line;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Serialize a record for the journal with its bulk referenced. A row still over `limit.bytes` moves
 * its largest remaining subtrees out by reference until it fits and records why under `spillKey`; a
 * record is never refused for its size.
 */
export function encodeRecord(value: unknown, content: ContentStore, limit?: SpillLimit): string {
  const referenced = reference(value, content, 0);
  const text = JSON.stringify(referenced);
  if (!limit || Buffer.byteLength(text) <= limit.bytes) return text;
  return spill(referenced, text, content, limit);
}

/** Parse a journal record, restoring everything it references. */
export function decodeRecord<T = unknown>(text: string, content: ContentStore): T {
  return JSON.parse(text, (_key, item) => {
    if (isContentRef(item)) return content.get(item.$content);
    if (isChunksRef(item))
      return (JSON.parse(content.get(item.$chunks)) as string[])
        .map((hash) => content.get(hash))
        .join('');
    if (isJsonRef(item)) return decodeRecord(content.get(item.$json), content);
    return item;
  }) as T;
}

function text(value: string, content: ContentStore): ContentRef | ChunksRef {
  const chunks = chunkText(value);
  if (chunks.length === 1) return { $content: content.put(value), chars: value.length };
  const hashes = chunks.map((chunk) => content.put(chunk));
  return { $chunks: content.put(JSON.stringify(hashes), hashes), chars: value.length };
}

const jsonRef = (json: string, content: ContentStore): JsonRef => ({
  $json: content.put(json, referencedHashes(json)),
  bytes: Buffer.byteLength(json),
});

/** Bottom-up: children are referenced before their parent's own size is judged. */
function reference(value: unknown, content: ContentStore, depth: number, key = ''): unknown {
  if (typeof value === 'string')
    return value.length >= CONTENT_REF_MIN ? text(value, content) : value;
  if (!value || typeof value !== 'object') return value;
  // Honor toJSON (Dates, class instances) and boxed primitives exactly as JSON.stringify would.
  const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
  if (typeof toJSON === 'function') return reference(toJSON.call(value, key), content, depth, key);
  if (value instanceof String || value instanceof Number || value instanceof Boolean)
    return reference(value.valueOf(), content, depth, key);
  let node: unknown;
  if (Array.isArray(value))
    node = value.map((item, index) =>
      item === undefined || typeof item === 'function' || typeof item === 'symbol'
        ? null
        : reference(item, content, depth + 1, String(index)),
    );
  else {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      out[key] = reference(item, content, depth + 1, key);
    }
    node = out;
  }
  if (depth < JSON_REF_DEPTH) return node;
  const json = JSON.stringify(node);
  return json.length >= CONTENT_REF_MIN ? jsonRef(json, content) : node;
}

type Container = Record<string, unknown> | unknown[];

/** A record's row limit: why it spilled, under which key, and root children never moved whole. */
export interface SpillLimit {
  bytes: number;
  spillKey: string;
  reason: string;
  /** Root children the store reads in SQL (`$.content.domain`): only what is below them moves. */
  keep?: readonly string[];
}

const MIN_SPILL = 256;

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The largest object or array directly under `node` that is not already a reference. */
function largestChild(
  node: Container,
  skip: ReadonlySet<string> = new Set(),
): { key: string | number; size: number } | undefined {
  let best: { key: string | number; size: number } | undefined;
  for (const [key, item] of Object.entries(node)) {
    if (!item || typeof item !== 'object' || isAnyRef(item)) continue;
    // A kept child is only skipped when nothing larger sits under it worth moving.
    if (skip.has(key) && !largestChild(item as Container)) continue;
    const bytes = size(item);
    if (!best || bytes > best.size)
      best = { key: Array.isArray(node) ? Number(key) : key, size: bytes };
  }
  return best;
}

/**
 * Move subtrees out until the row fits. Each round walks down from the root through the child that
 * holds most of its parent and moves out the node where no single child dominates: the bulk leaves
 * while the small fields beside it (owners, domains, decisions, ids) stay inline and queryable. A
 * direct child of the root never moves out whole (the store's SQL reads `$.content.domain`,
 * `$.summary`); the walk always goes at least one level below it.
 */
function spill(record: unknown, text: string, content: ContentStore, limit: SpillLimit): string {
  const bytes = Buffer.byteLength(text);
  const root = (
    record && typeof record === 'object' && !Array.isArray(record) ? record : { value: record }
  ) as Record<string, unknown>;
  const keep = new Set(limit.keep ?? []);
  const reserve = 1024; // room for the note itself
  const paths: string[] = [];
  while (size(root) + reserve > limit.bytes) {
    let parent: Container = root;
    let path = '$';
    let pick = largestChild(parent, keep);
    if (!pick) break;
    for (;;) {
      const node = (parent as Record<string | number, unknown>)[pick.key] as Container;
      const child = largestChild(node);
      // A kept root child is never moved whole: the walk goes below it.
      const mustDescend = parent === root && keep.has(String(pick.key));
      if (!child || (!mustDescend && child.size * 2 < pick.size)) break;
      path += Array.isArray(parent) ? `[${pick.key}]` : `.${pick.key}`;
      parent = node;
      pick = child;
    }
    if (parent === root && keep.has(String(pick.key))) break; // nothing movable below it
    // Moving out something smaller than its reference only grows the row.
    if (pick.size <= MIN_SPILL) break;
    path += Array.isArray(parent) ? `[${pick.key}]` : `.${pick.key}`;
    const slot = parent as Record<string | number, unknown>;
    slot[pick.key] = jsonRef(JSON.stringify(slot[pick.key]), content);
    paths.push(path);
  }
  const note: SpillNote = {
    reason: limit.reason,
    limit: limit.bytes,
    bytes,
    paths: paths.length > 20 ? [...paths.slice(0, 20), `… ${paths.length - 20} more`] : paths,
  };
  return JSON.stringify({ ...root, [limit.spillKey]: note });
}
