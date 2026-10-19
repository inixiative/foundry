/**
 * @atlas
 * @kind adapter
 * @partOf feature:composition
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  fenceSegments,
  INSTRUCTION_FILE_LIMIT,
  type InstructionFile,
  readInstructionFile,
  secretInstructionPath,
  withinAny,
  withinPath,
} from './markdown-docs';

/**
 * A registered Markdown hierarchy: a ladder or tree of instruction nodes (computer, org, project,
 * each shared or personal), composed for one working location into one ordered list of files, with
 * duplicates removed. Harness-agnostic: which files a node reads, its tier and its position are data.
 * Tiers are opaque labels here; the caller ranks them and decides who may see each.
 *
 * The same ladder composes every slot (e.g. instructions, domain knowledge) for every role (the main
 * thread, each middleware role): a location names the role and slot it composes for, nodes and
 * sources say which roles and slots they serve, and paths take `{role}` and `{slot}`.
 */

/** When a node or source applies. Every listed key must hold; within a key, any value. */
export interface HierarchyMatch {
  /** The working directory is inside one of these. */
  readonly paths?: readonly string[];
  /** The thread's project id is one of these. */
  readonly projects?: readonly string[];
  /** The thread's owner (e.g. a Kingdom owner key) is one of these. */
  readonly owners?: readonly string[];
  /** The harness the composed prompt is for. */
  readonly harness?: readonly string[];
  /** The role composed for (e.g. "main", a Warden's agent id). */
  readonly roles?: readonly string[];
  /** The slot composed (e.g. "instructions", "domainKnowledge"). */
  readonly slots?: readonly string[];
}

/** Which directories of the root-to-cwd walk a walk source visits. */
export interface HierarchySpan {
  /** Only directories inside one of these. */
  readonly within?: readonly string[];
  /** Only directories outside all of these. */
  readonly outside?: readonly string[];
  /** Only these exact directories. */
  readonly only?: readonly string[];
  /** Never these exact directories. */
  readonly except?: readonly string[];
}

/** A file, a glob, or the first existing of several paths. */
export interface HierarchyFileSource {
  /** Names the source, so a harness that loads it natively can leave it out (`harnessLoads`). */
  readonly id?: string;
  readonly when?: HierarchyMatch;
  /**
   * Absolute, `~/`, `{var}`-templated or (inside a walk, or with an anchor) relative. A glob expands
   * in path order; a list loads the first that exists.
   */
  readonly path: string | readonly string[];
  /** Rule files: frontmatter is stripped, and a file whose frontmatter names `paths` is skipped. */
  readonly rules?: boolean;
  /** Read as is: no comment stripping and no `@path` imports (e.g. an auto-memory index). */
  readonly raw?: boolean;
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

/** The same file sources, looked up in each directory of the walk from the filesystem root to the cwd. */
export interface HierarchyWalkSource {
  readonly id?: string;
  readonly when?: HierarchyMatch;
  readonly walk: readonly HierarchyFileSource[];
  readonly span?: HierarchySpan;
}

export type HierarchySource = HierarchyFileSource | HierarchyWalkSource;

export interface HierarchyNode {
  readonly id: string;
  /** computer, org, project, or any other level name. */
  readonly scope: string;
  /** Personal to the user rather than shared with a team or org. */
  readonly personal: boolean;
  /** The node's corpus tier, opaque to the composer. */
  readonly tier: string;
  readonly label?: string;
  /** A child applies only where its parent applies, and orders after it. */
  readonly parent?: string;
  readonly when?: HierarchyMatch;
  /**
   * The directory the node is about, which places its files in the walk order. Default: the
   * `when.paths` entry the cwd is inside. None: the node sits before every directory (computer level).
   */
  readonly anchor?: string;
  readonly sources: readonly HierarchySource[];
  /** Where its files may `@import` from: anywhere, or inside these roots (`{dir}`: the importing file's directory). */
  readonly imports?: 'anywhere' | readonly string[];
  /** Paths that are this node's wherever they are reached: an import of one keeps the narrower tier. */
  readonly owns?: {
    readonly names?: readonly string[];
    readonly within?: readonly string[];
    readonly dirs?: readonly string[];
  };
}

/** Where a prompt is composed for. */
export interface HierarchyLocation {
  readonly cwd: string;
  readonly home: string;
  /** Values for `{name}` in paths. A path naming an absent variable is skipped. */
  readonly vars: Readonly<Record<string, string | undefined>>;
  readonly projectId?: string;
  readonly owner?: string;
  readonly harness?: string;
  /** Source ids the harness loads natively; those sources are left out. */
  readonly harnessLoads?: readonly string[];
  /** The role composed for; also `{role}` in paths. */
  readonly role?: string;
  /** The slot composed; also `{slot}` in paths. */
  readonly slot?: string;
  /**
   * With a `slot`: which nodes' unslotted sources (no `slots` on the source, its walk or its node)
   * compose into it. "all" (the default) or these node ids. Slotted sources follow `slots` only.
   */
  readonly unslotted?: 'all' | readonly string[];
  /**
   * Instruction homes (a CLAUDE_CONFIG_DIR, a CODEX_HOME) judged only below themselves by the
   * secret check, so one under `~/.config` still loads.
   */
  readonly trusted?: readonly string[];
}

export interface HierarchyFile extends InstructionFile {
  /** The node the file belongs to (an import may belong to a narrower node than its importer). */
  readonly node: string;
  readonly tier: string;
}

export type HierarchyDuplicateKind = 'path' | 'content' | 'section';

/** One thing left out as a duplicate, and the copy that was kept. */
export interface HierarchyDuplicate {
  readonly kind: HierarchyDuplicateKind;
  readonly path: string;
  readonly node: string;
  /** The section's heading, for a section duplicate. */
  readonly heading?: string;
  readonly chars: number;
  readonly keptPath: string;
  readonly keptNode: string;
}

/** A file the walk or a configured path reached but refused to load. */
export interface HierarchyRefusal {
  readonly path: string;
  readonly node: string;
  /** Where its symlinks lead. */
  readonly real: string;
  readonly reason: 'secret' | 'outside-boundary';
}

export interface HierarchyStack {
  readonly files: HierarchyFile[];
  /** Files reached a second time (the same real path); the first reach is kept. */
  readonly duplicates: HierarchyDuplicate[];
  /** Files refused: a secret where they are or where they lead, or a real path outside the node's boundary. */
  readonly refused: HierarchyRefusal[];
  /**
   * Every path consulted, found or not (candidate files, glob directories, imports). When none of
   * them changed (`hierarchyFingerprint`), discovery would return the same stack.
   */
  readonly probes: readonly string[];
}

export interface HierarchyDiscoverOptions {
  /** Lower is narrower (more private). An import never widens past its own location's tier. */
  tierRank: (tier: string) => number;
  /** Import hops; Claude Code follows four. */
  maxDepth?: number;
}

const VAR = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;
const GLOB = /[*?[]/;

/** `~/` and `{var}` expanded; undefined when a variable is absent. */
export function expandHierarchyPath(
  template: string,
  vars: Readonly<Record<string, string | undefined>>,
  home: string,
): string | undefined {
  let missing = false;
  const out = template.replace(VAR, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) missing = true;
    return value ?? '';
  });
  if (missing) return undefined;
  if (out === '~') return home;
  return out.startsWith('~/') ? join(home, out.slice(2)) : out;
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function matches(when: HierarchyMatch | undefined, location: HierarchyLocation): boolean {
  if (!when) return true;
  if (when.harness && !(location.harness && when.harness.includes(location.harness))) return false;
  if (when.projects && !(location.projectId && when.projects.includes(location.projectId)))
    return false;
  if (when.owners && !(location.owner && when.owners.includes(location.owner))) return false;
  if (when.roles && !(location.role && when.roles.includes(location.role))) return false;
  if (when.slots && !(location.slot && when.slots.includes(location.slot))) return false;
  if (when.paths && !matchedPath(when.paths, location)) return false;
  return true;
}

/** Location variables plus `{role}` and `{slot}`. */
const locationVars = (location: HierarchyLocation) => ({
  ...location.vars,
  ...(location.role !== undefined ? { role: location.role } : {}),
  ...(location.slot !== undefined ? { slot: location.slot } : {}),
});

/** Whether a source no `when` along its chain assigns to a slot composes into the location's slot. */
function unslottedApplies(node: HierarchyNode, location: HierarchyLocation): boolean {
  if (location.slot === undefined) return true;
  const unslotted = location.unslotted ?? 'all';
  return unslotted === 'all' || unslotted.includes(node.id);
}

function matchedPath(paths: readonly string[], location: HierarchyLocation): string | undefined {
  const cwd = resolve(location.cwd);
  const vars = locationVars(location);
  return paths
    .map((path) => expandHierarchyPath(path, vars, location.home))
    .filter((path): path is string => !!path)
    .map((path) => resolve(path))
    .find((path) => withinAny([path])(cwd));
}

/** A selected node, its place in the ladder and the directory it is about. */
export interface SelectedHierarchyNode {
  readonly node: HierarchyNode;
  /** Ladder order: parents before children, siblings in registration order. */
  readonly rank: number;
  readonly anchor?: string;
}

/**
 * The nodes that apply at `location`, in ladder order (a depth-first walk of the tree, roots and
 * children in registration order). A node applies when its `when` holds and its parent applies.
 */
export function selectHierarchyNodes(
  nodes: readonly HierarchyNode[],
  location: HierarchyLocation,
): SelectedHierarchyNode[] {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string | undefined, HierarchyNode[]>();
  for (const node of nodes) {
    const parent = node.parent && ids.has(node.parent) ? node.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const selected: SelectedHierarchyNode[] = [];
  let rank = 0;
  const visit = (node: HierarchyNode, inherited: string | undefined) => {
    const position = rank++;
    if (!matches(node.when, location)) return;
    // A node with no anchor of its own sits with its parent (org personal beside its org).
    const own =
      node.anchor !== undefined
        ? expandHierarchyPath(node.anchor, locationVars(location), location.home)
        : node.when?.paths
          ? matchedPath(node.when.paths, location)
          : undefined;
    // A declared anchor that cannot resolve (an absent variable) means the node has nowhere to be.
    if (node.anchor !== undefined && !own) return;
    const anchor = own ? resolve(own) : inherited;
    selected.push({ node, rank: position, ...(anchor ? { anchor } : {}) });
    for (const child of children.get(node.id) ?? []) visit(child, anchor);
  };
  for (const root of children.get(undefined) ?? []) visit(root, undefined);
  return selected.sort((a, b) => a.rank - b.rank);
}

/** Path depth: the walk order of a directory. A node with no anchor sits before them all. */
const depth = (path: string | undefined) =>
  path === undefined ? -1 : resolve(path).split(sep).filter(Boolean).length;

interface Unit {
  readonly position: number;
  readonly rank: number;
  readonly seq: number;
  readonly selected: SelectedHierarchyNode;
  readonly source: HierarchyFileSource;
  readonly path: string;
}

/** Files under `base` matching `pattern`, in path order. Glob characters in `base` are literal. */
async function expandGlob(
  base: string,
  pattern: string,
  probe: (path: string) => void,
): Promise<string[]> {
  const found: string[] = [];
  probe(base);
  try {
    if (!statSync(base).isDirectory()) return [];
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: base, followSymlinks: true }))
      found.push(join(base, rel));
  } catch {
    return [];
  }
  // A file added or removed changes its directory: every directory the pattern can reach is
  // consulted, matched or not yet (a new rules/sub/new.md), up to a bound.
  if (pattern.includes('/') || pattern.includes('**')) {
    let dirs = 0;
    try {
      for await (const rel of new Bun.Glob('**').scan({
        cwd: base,
        onlyFiles: false,
        followSymlinks: true,
      })) {
        const path = join(base, rel);
        if (!isDirectory(path)) continue;
        probe(path);
        if (++dirs >= GLOB_PROBE_DIRECTORIES) break;
      }
    } catch {
      /* unreadable: the base directory's own change still shows */
    }
  }
  return found.sort();
}

const GLOB_PROBE_DIRECTORIES = 256;
const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The state of `probes` (each path's identity, size and modification time, or its absence). Equal
 * fingerprints mean no consulted file or directory changed since. Cheap: one stat per path.
 */
export function hierarchyFingerprint(probes: readonly string[]): string {
  return probes
    .map((path) => {
      try {
        const info = statSync(path);
        return `${path}\0${info.ino}:${info.size}:${info.mtimeMs}`;
      } catch {
        return `${path}\0-`;
      }
    })
    .join('\n');
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** A rule loads at launch unless its frontmatter scopes it to `paths`. Unreadable: skipped. */
function launchRule(path: string): boolean {
  try {
    const frontmatter = FRONTMATTER.exec(readFileSync(path, 'utf8'))?.[1];
    return !frontmatter || !/^paths\s*:/m.test(frontmatter);
  } catch {
    return false;
  }
}

/** The directories from just below the filesystem root down to `cwd`. */
function walkChain(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); dirname(dir) !== dir; dir = dirname(dir)) dirs.unshift(dir);
  return dirs;
}

function inSpan(
  dir: string,
  span: HierarchySpan | undefined,
  expand: (paths: readonly string[] | undefined) => string[] | undefined,
): boolean {
  if (!span) return true;
  const within = expand(span.within);
  const outside = expand(span.outside);
  const only = expand(span.only);
  const except = expand(span.except);
  // An exclusion that cannot resolve (an absent variable) fails closed: nothing is in the span.
  if (
    (outside && outside.length !== span.outside?.length) ||
    (except && except.length !== span.except?.length)
  )
    return false;
  if (within && !within.some((root) => withinPath(dir, root))) return false;
  if (outside?.some((root) => withinPath(dir, root))) return false;
  if (only && !only.includes(dir)) return false;
  if (except?.includes(dir)) return false;
  return true;
}

/**
 * Every file the selected nodes read at `location`, in composition order: computer-level nodes
 * first, then each directory from the filesystem root down to the cwd; within one place, shared
 * nodes before personal ones, each in ladder order (parents before children); within a node, its
 * sources in order.
 * Each file is followed by its `@path` imports; a file reached again is recorded, not loaded.
 */
export async function discoverHierarchy(
  nodes: readonly HierarchyNode[],
  location: HierarchyLocation,
  options: HierarchyDiscoverOptions,
): Promise<HierarchyStack> {
  const selected = selectHierarchyNodes(nodes, location);
  const chain = walkChain(location.cwd);
  const loadedNatively = new Set(location.harnessLoads ?? []);
  const units: Unit[] = [];
  let seq = 0;
  const probes = new Set<string>();
  const probe = (path: string) => {
    probes.add(path);
  };
  // A trusted root is trusted as written and where its symlinks lead (~/.claude -> ~/.config/claude).
  const trusted = [
    ...new Set(
      (location.trusted ?? []).flatMap((root) => {
        try {
          return [root, realpathSync(root)];
        } catch {
          return [root];
        }
      }),
    ),
  ];
  const secret = (path: string) => secretInstructionPath(path, trusted);
  const refused: HierarchyRefusal[] = [];

  const realOf = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const varsFor = (entry: SelectedHierarchyNode, dir?: string) => ({
    ...locationVars(location),
    ...(entry.anchor ? { anchor: entry.anchor } : {}),
    ...(dir ? { dir } : {}),
  });
  const expandAll = (
    paths: readonly string[] | undefined,
    vars: Readonly<Record<string, string | undefined>>,
  ) =>
    paths
      ?.map((path) => expandHierarchyPath(path, vars, location.home))
      .filter((path): path is string => !!path)
      .map((path) => resolve(path));

  const plan = async (
    entry: SelectedHierarchyNode,
    source: HierarchyFileSource,
    position: number,
    base: string | undefined,
    vars: Readonly<Record<string, string | undefined>>,
    slotted: boolean,
  ) => {
    if (!matches(source.when, location) || (source.id && loadedNatively.has(source.id))) return;
    if (!slotted && !source.when?.slots && !unslottedApplies(entry.node, location)) return;
    const place = (path: string) => (isAbsolute(path) ? path : base ? join(base, path) : undefined);
    const literal = (template: string) => {
      const expanded = expandHierarchyPath(template, vars, location.home);
      return expanded === undefined ? undefined : place(expanded);
    };
    let paths: string[];
    if (typeof source.path !== 'string') {
      const first = source.path
        .map(literal)
        .filter((path): path is string => !!path)
        .find((path) => {
          probe(path);
          return isFile(path);
        });
      paths = first ? [first] : [];
    } else {
      // Glob characters count only where the template has them, never in a directory a variable names.
      const segments = source.path.split('/');
      const globAt = segments.findIndex((segment) => GLOB.test(segment));
      if (globAt < 0) {
        const path = literal(source.path);
        if (path) probe(path);
        paths = path ? [path] : [];
      } else {
        const root = segments.slice(0, globAt).join('/');
        const dir =
          root === '' && source.path.startsWith('/') ? '/' : root ? literal(root) : place('.');
        paths = dir ? await expandGlob(resolve(dir), segments.slice(globAt).join('/'), probe) : [];
      }
    }
    // A configured path is held to the import rule too, on where it resolves: no dotfiles, keys or credentials.
    paths = paths.filter((path) => {
      if (!isFile(path) || (!secret(path) && !secret(realOf(path)))) return true;
      refused.push({ path, node: entry.node.id, real: realOf(path), reason: 'secret' });
      return false;
    });
    if (source.rules) paths = paths.filter(launchRule);
    for (const path of paths)
      units.push({ position, rank: entry.rank, seq: seq++, selected: entry, source, path });
  };

  for (const entry of selected) {
    const nodeSlotted = !!entry.node.when?.slots;
    for (const source of entry.node.sources) {
      if ('walk' in source) {
        if (!matches(source.when, location) || (source.id && loadedNatively.has(source.id)))
          continue;
        const spanVars = varsFor(entry);
        for (const dir of chain) {
          if (!inSpan(dir, source.span, (paths) => expandAll(paths, spanVars))) continue;
          for (const file of source.walk)
            await plan(
              entry,
              file,
              depth(dir),
              dir,
              varsFor(entry, dir),
              nodeSlotted || !!source.when?.slots,
            );
        }
      } else {
        await plan(entry, source, depth(entry.anchor), entry.anchor, varsFor(entry), nodeSlotted);
      }
    }
  }
  const personal = (unit: Unit) => (unit.selected.node.personal ? 1 : 0);
  units.sort(
    (a, b) =>
      a.position - b.position || personal(a) - personal(b) || a.rank - b.rank || a.seq - b.seq,
  );

  // An import keeps the narrower of its importer's tier and the tier of any node that owns its path.
  const owners = selected.map((entry) => {
    const vars = varsFor(entry);
    return {
      node: entry.node,
      names: entry.node.owns?.names,
      within: expandAll(entry.node.owns?.within, vars),
      dirs: expandAll(entry.node.owns?.dirs, vars),
    };
  });
  /** The narrowest node owning the path as spelled or where its symlinks lead. */
  const owner = (spelled: string): HierarchyNode | undefined => {
    let narrowest: HierarchyNode | undefined;
    const paths = [...new Set([spelled, realOf(spelled)])];
    for (const own of owners) {
      const hit = paths.some(
        (path) =>
          own.names?.includes(basename(path)) ||
          (own.within?.length && withinAny(own.within)(path)) ||
          own.dirs?.includes(dirname(path)),
      );
      if (hit && (!narrowest || options.tierRank(own.node.tier) < options.tierRank(narrowest.tier)))
        narrowest = own.node;
    }
    return narrowest;
  };

  /** The node a file reached through `via` belongs to: the narrower of `via` and any node owning its path. */
  const tierOf = (path: string, via: HierarchyNode) => {
    const own = owner(path);
    return own && options.tierRank(own.tier) < options.tierRank(via.tier) ? own : via;
  };
  const seen = new Set<string>();
  /** Each loaded file by real path: where it was kept and its index in `files`. */
  const kept = new Map<string, { path: string; node: string; index: number }>();
  /**
   * A file reached again loads once, where first reached. A later reach that would give it a wider
   * tier (a shared file also imported by a personal one) widens it, so a personal first reach never
   * hides a shared file from a team.
   */
  const reachedAgain = (path: string, real: string, via: HierarchyNode) => {
    const prior = kept.get(real);
    if (!prior) return;
    duplicates.push({
      kind: 'path',
      path,
      node: via.id,
      chars: 0,
      keptPath: prior.path,
      keptNode: prior.node,
    });
    const wider = tierOf(path, via);
    const file = files[prior.index]!;
    if (options.tierRank(wider.tier) > options.tierRank(file.tier)) {
      files[prior.index] = { ...file, node: wider.id, tier: wider.tier };
      kept.set(real, { ...prior, node: wider.id });
    }
  };
  const files: HierarchyFile[] = [];
  const duplicates: HierarchyDuplicate[] = [];
  for (const unit of units) {
    const { node } = unit.selected;
    probe(unit.path);
    if (unit.source.raw) {
      if (!isFile(unit.path)) continue;
      const real = realOf(unit.path);
      if (kept.has(real)) {
        reachedAgain(unit.path, real, node);
        continue;
      }
      if (statSync(real).size > INSTRUCTION_FILE_LIMIT) continue;
      const raw = readFileSync(unit.path, 'utf8');
      let content = raw;
      if (unit.source.maxLines !== undefined)
        content = content.split('\n').slice(0, unit.source.maxLines).join('\n');
      if (unit.source.maxBytes !== undefined)
        content = Buffer.from(content).subarray(0, unit.source.maxBytes).toString('utf8');
      const final = tierOf(unit.path, node);
      seen.add(real);
      kept.set(real, { path: unit.path, node: final.id, index: files.length });
      files.push({
        path: unit.path,
        content,
        ...(raw !== content ? { raw } : {}),
        depth: 0,
        node: final.id,
        tier: final.tier,
      });
      continue;
    }
    const allowed =
      node.imports === undefined || node.imports === 'anywhere'
        ? undefined
        : withinAny(
            node.imports
              .map((root) =>
                expandHierarchyPath(
                  root,
                  { ...varsFor(unit.selected), dir: dirname(unit.path) },
                  location.home,
                ),
              )
              .filter((root): root is string => !!root),
          );
    // A shared node's file is held to its import boundary on where it resolves, like an import: a
    // committed CLAUDE.md symlinked out of the repository never loads as the repository's. A
    // personal node's file (CLAUDE.local.md pointing at private notes) reaches no shared audience.
    const real = realOf(unit.path);
    if (!node.personal && allowed && isFile(unit.path) && !allowed(real)) {
      refused.push({ path: unit.path, node: node.id, real, reason: 'outside-boundary' });
      continue;
    }
    const read = await readInstructionFile(unit.path, {
      home: location.home,
      seen,
      trusted,
      onProbe: probe,
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      ...(allowed ? { allows: allowed } : {}),
      onDuplicate: ({ path, real }) => reachedAgain(path, real, node),
    });
    for (const file of read) {
      let content = file.content;
      if (file.depth === 0 && unit.source.rules) content = content.replace(FRONTMATTER, '');
      // Every file keeps the narrower tier of its node and any node owning its path, found or imported.
      const final = tierOf(file.path, node);
      kept.set(realOf(file.path), { path: file.path, node: final.id, index: files.length });
      files.push({
        ...file,
        content,
        ...(content !== file.content ? { raw: file.raw ?? file.content } : {}),
        node: final.id,
        tier: final.tier,
      });
    }
  }
  return { files, duplicates, refused, probes: [...probes] };
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Blank lines, trailing whitespace, line endings and runs of spaces inside a line do not make two
 * texts different; indentation does (nested lists, YAML, code).
 */
const normalizeBody = (text: string) =>
  text
    .split(/\r?\n|\r/)
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)![0];
      return indent + line.slice(indent.length).replace(/\s+/g, ' ').trimEnd();
    })
    .filter((line) => line.trim())
    .join('\n');

const normalizeHeading = (heading: string) =>
  heading
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;

interface Section {
  readonly heading: string;
  readonly level: number;
  /** Line range [start, end) including the heading and every subsection. */
  readonly start: number;
  readonly end: number;
  /** Same heading path, heading and body (subsections included). Absent for a section with no body. */
  readonly key?: string;
}

/**
 * ATX sections outside fenced code and frontmatter; each spans its subsections. A section's key
 * covers its enclosing headings too, document title included, so `Testing > Rules` and
 * `Deploy > Rules` never match.
 */
export function markdownSections(text: string): Section[] {
  const all = text.split('\n');
  const front = FRONTMATTER.exec(text)?.[0];
  const skip = front ? front.split('\n').length - (front.endsWith('\n') ? 1 : 0) : 0;
  const headings: Array<{ line: number; level: number; heading: string }> = [];
  let line = 0;
  for (const segment of fenceSegments(text)) {
    const lines = segment.text.split('\n');
    if (!segment.code)
      lines.forEach((value, i) => {
        const match = HEADING.exec(value);
        if (match && line + i >= skip)
          headings.push({ line: line + i, level: match[1]!.length, heading: match[2] ?? '' });
      });
    line += lines.length;
  }
  return headings.map((heading, i) => {
    const next = headings.slice(i + 1).find((other) => other.level <= heading.level);
    const end = next ? next.line : all.length;
    const body = normalizeBody(all.slice(heading.line + 1, end).join('\n'));
    const path: string[] = [];
    let level = heading.level;
    for (let j = i - 1; j >= 0; j--)
      if (headings[j]!.level < level) {
        path.unshift(normalizeHeading(headings[j]!.heading));
        level = headings[j]!.level;
      }
    return {
      heading: heading.heading.replace(/[ \t]+#+[ \t]*$/, '').trim(),
      level: heading.level,
      start: heading.line,
      end,
      ...(body
        ? {
            key: digest(
              `${path.join('\n')}\n${heading.level}\n${normalizeHeading(heading.heading)}\n${body}`,
            ),
          }
        : {}),
    };
  });
}

/** `lines` without the dropped ranges; a blank line left doubled at a cut is removed, nothing else changes. */
function cut(lines: readonly string[], dropped: readonly Section[]): string {
  const out: string[] = [];
  let atCut = false;
  lines.forEach((line, i) => {
    if (dropped.some((section) => i >= section.start && i < section.end)) {
      atCut = true;
      return;
    }
    if (atCut && !line.trim() && (out.length === 0 || !out.at(-1)!.trim())) return;
    atCut = atCut && !line.trim();
    out.push(line);
  });
  return out.join('\n');
}

export interface HierarchyDedupeOptions {
  /** Two files with the same text: keep the more specific. Default true. */
  readonly content?: boolean;
  /** The same heading and body in two files: keep the more specific file's copy. Default true. */
  readonly sections?: boolean;
}

/**
 * Removes repeated content from an ordered stack (general first, specific last): identical files,
 * then identical sections (normalized heading and body, subsections included). The most specific
 * copy is kept; each removal names it. Filter by audience before deduping, so a kept copy the
 * audience cannot see never hides one it can.
 */
export function dedupeHierarchy<F extends HierarchyFile>(
  files: readonly F[],
  options: HierarchyDedupeOptions = {},
): { files: F[]; duplicates: HierarchyDuplicate[] } {
  const duplicates: HierarchyDuplicate[] = [];
  let out = [...files];
  if (options.content !== false) {
    const later = new Map<string, F>();
    const keep: F[] = [];
    for (const file of [...out].reverse()) {
      const text = normalizeBody(file.content);
      if (!text) {
        keep.unshift(file);
        continue;
      }
      const key = digest(text);
      const prior = later.get(key);
      if (prior) {
        duplicates.push({
          kind: 'content',
          path: file.path,
          node: file.node,
          chars: file.content.length,
          keptPath: prior.path,
          keptNode: prior.node,
        });
        continue;
      }
      later.set(key, file);
      keep.unshift(file);
    }
    out = keep;
  }
  if (options.sections !== false) {
    const later = new Map<string, F>();
    const keep: F[] = [];
    for (const file of [...out].reverse()) {
      const sections = markdownSections(file.content);
      const dropped: Section[] = [];
      for (const section of sections) {
        if (dropped.some((outer) => section.start >= outer.start && section.end <= outer.end))
          continue;
        const prior = section.key ? later.get(section.key) : undefined;
        if (!prior) continue;
        dropped.push(section);
        const lines = file.content.split('\n').slice(section.start, section.end).join('\n');
        duplicates.push({
          kind: 'section',
          path: file.path,
          node: file.node,
          heading: section.heading,
          chars: lines.length,
          keptPath: prior.path,
          keptNode: prior.node,
        });
      }
      for (const section of sections) {
        if (!section.key || later.has(section.key)) continue;
        if (dropped.some((outer) => section.start >= outer.start && section.end <= outer.end))
          continue;
        later.set(section.key, file);
      }
      if (!dropped.length) {
        keep.unshift(file);
        continue;
      }
      const content = cut(file.content.split('\n'), dropped);
      if (content.trim()) keep.unshift({ ...file, content, raw: file.raw ?? file.content });
    }
    out = keep;
  }
  return { files: out, duplicates: duplicates.reverse() };
}

/** A duplicate removed while deduping slots together: which slot lost the copy and which kept it. */
export interface HierarchySlotDuplicate extends HierarchyDuplicate {
  readonly slot: number;
  readonly keptSlot: number;
}

/**
 * Dedupe one role's slots together (each an ordered stack, general first), in slot order: a file or
 * section repeated in a later slot is kept there and cut from the earlier one, so a role never reads
 * the same text twice. Filter by audience first, as for `dedupeHierarchy`.
 */
export function dedupeHierarchySlots<F extends HierarchyFile>(
  slots: readonly (readonly F[])[],
  options: HierarchyDedupeOptions = {},
): { slots: F[][]; duplicates: HierarchySlotDuplicate[] } {
  // The slot rides on the node id through dedupe (a cut file is a spread copy) and is split off after.
  const SEP = '\u0000';
  const tagged = slots.flatMap((files, slot) =>
    files.map((file) => ({ ...file, node: `${slot}${SEP}${file.node}` })),
  );
  const split = (node: string) => {
    const at = node.indexOf(SEP);
    return { slot: Number(node.slice(0, at)), node: node.slice(at + 1) };
  };
  const { files, duplicates } = dedupeHierarchy(tagged, options);
  const out: F[][] = slots.map(() => []);
  for (const file of files) {
    const { slot, node } = split(file.node);
    out[slot]!.push({ ...file, node } as F);
  }
  return {
    slots: out,
    duplicates: duplicates.map((duplicate) => {
      const lost = split(duplicate.node);
      const kept = split(duplicate.keptNode);
      return {
        ...duplicate,
        node: lost.node,
        keptNode: kept.node,
        slot: lost.slot,
        keptSlot: kept.slot,
      };
    }),
  };
}
