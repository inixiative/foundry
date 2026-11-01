/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
/**
 * What a thread touches, in Atlas concepts: the files its recent turns read and wrote (the tool
 * calls the journal holds), mapped through the project's `atlas graph` (the same read the
 * Cartographer uses). Also which other threads in the project touch the same concepts.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { READ_TOOLS, WRITE_TOOLS } from '@inixiative/foundry-core';
import { type AtlasGraph, readAtlasGraph } from '../agents/cartographer';
import type { LocalSessionStore } from '../persistence/local-session-store';
import { turnFiles } from './turn-flow';

const TURNS = 40;
const CACHE_MS = 60_000;
const graphs = new Map<string, { at: number; graph: AtlasGraph | null }>();

/** The project's graph, cached a minute (a spawn per read is too slow for a panel). */
async function graphOf(root: string): Promise<AtlasGraph | null> {
  const hit = graphs.get(root);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.graph;
  const graph = await readAtlasGraph(root);
  graphs.set(root, { at: Date.now(), graph });
  return graph;
}

export const atlasMapped = (root: string) =>
  existsSync(join(root, '.atlas')) || existsSync(join(root, 'MAP.md'));

/** The two store reads this needs. */
type TurnReads = Pick<LocalSessionStore, 'recentTurnIds' | 'turnFlowRecord'>;

/** Repo-relative paths a thread read and wrote on its recent turns. */
export function threadPaths(store: TurnReads, threadId: string, root: string) {
  const read = new Set<string>();
  const written = new Set<string>();
  const relative = (path: string) =>
    path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  for (const turnId of store.recentTurnIds(threadId, TURNS)) {
    const record = store.turnFlowRecord(threadId, turnId, [...WRITE_TOOLS, ...READ_TOOLS]);
    const uses = record?.toolUses ?? [];
    for (const file of turnFiles(uses)) written.add(relative(file.path));
    for (const use of uses) {
      if (use.kind !== 'tool_use' || !use.toolName || !READ_TOOLS.has(use.toolName)) continue;
      const input = (use.toolInput ?? {}) as Record<string, unknown>;
      const path = input.file_path ?? input.notebook_path ?? input.path;
      if (typeof path === 'string' && path) read.add(relative(path));
    }
  }
  return { read, written };
}

export interface ConceptTouch {
  concept: string;
  files: number;
  changed: number;
  /** The touched files in this concept, repo-relative (the first few). */
  paths: string[];
  doc: string | null;
}

/** The concepts a set of read and written paths fall in, most-touched first. */
export function conceptsTouched(
  graph: AtlasGraph,
  paths: { read: Set<string>; written: Set<string> },
): ConceptTouch[] {
  const touches: ConceptTouch[] = [];
  for (const [concept, members] of Object.entries(graph.conceptToFiles ?? {})) {
    const files = members.filter((f) => paths.read.has(f) || paths.written.has(f));
    if (!files.length) continue;
    touches.push({
      concept,
      files: files.length,
      changed: files.filter((f) => paths.written.has(f)).length,
      paths: files.slice(0, 5),
      doc: graph.thesaurus?.[concept]?.doc ?? null,
    });
  }
  return touches.sort((a, b) => b.files - a.files || a.concept.localeCompare(b.concept));
}

/** The thread's concepts, and the other threads of its project that share any of them. */
export async function threadAtlas(
  store: TurnReads,
  threadId: string,
  root: string,
  siblings: readonly { id: string; name: string }[],
) {
  if (!atlasMapped(root)) return { mapped: false as const };
  const graph = await graphOf(root);
  if (!graph) return { mapped: false as const, error: 'atlas graph could not be read' };
  const concepts = conceptsTouched(graph, threadPaths(store, threadId, root));
  const mine = new Set(concepts.map((c) => c.concept));
  const shared = siblings
    .filter((s) => s.id !== threadId)
    .map((s) => ({
      threadId: s.id,
      name: s.name,
      concepts: conceptsTouched(graph, threadPaths(store, s.id, root))
        .map((c) => c.concept)
        .filter((c) => mine.has(c)),
    }))
    .filter((s) => s.concepts.length);
  return { mapped: true as const, concepts, shared };
}
