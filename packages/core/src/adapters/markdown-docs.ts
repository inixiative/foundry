import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ContextSource } from '../context-layer';
import type { ContextRef, HydrationAdapter } from '../hydrator';

/**
 * Markdown directory adapter.
 *
 * Reads a directory of .md files as context. Perfect for:
 * - CLAUDE.md and project docs
 * - Architecture decision records
 * - Convention files
 * - Any docs/ directory
 *
 * Zero external deps — just filesystem.
 */
export class MarkdownDocs {
  readonly dir: string;
  readonly glob: string;
  private _cache: Map<string, { content: string; mtime: number }> = new Map();

  /**
   * @param dir — root directory to scan
   * @param glob — file pattern (default: all .md files recursively)
   */
  constructor(dir: string, glob: string = '**/*.md') {
    this.dir = dir;
    this.glob = glob;
  }

  /** Scan and load all matching files. */
  async load(): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const scanner = new Bun.Glob(this.glob).scan({ cwd: this.dir, absolute: false });

    for await (const relPath of scanner) {
      const absPath = join(this.dir, relPath);
      const file = Bun.file(absPath);
      const stat = await file.stat();
      const cached = this._cache.get(relPath);

      // Use cache if file hasn't changed
      if (cached && cached.mtime === stat.mtimeMs) {
        results.set(relPath, cached.content);
      } else {
        const content = await file.text();
        this._cache.set(relPath, { content, mtime: stat.mtimeMs });
        results.set(relPath, content);
      }
    }

    return results;
  }

  /** Read a single file by relative path. */
  async readFile(relPath: string): Promise<string> {
    const absPath = join(this.dir, relPath);
    const file = Bun.file(absPath);
    if (!(await file.exists())) return '';
    return file.text();
  }

  /** List all matching files. */
  async list(): Promise<string[]> {
    const paths: string[] = [];
    const scanner = new Bun.Glob(this.glob).scan({ cwd: this.dir, absolute: false });
    for await (const relPath of scanner) {
      paths.push(relPath);
    }
    return paths;
  }

  /**
   * Create a ContextSource that loads all docs as one string.
   * Each file is prefixed with its path as a header.
   */
  asSource(id: string): ContextSource {
    const docs = this;
    return {
      id,
      async load() {
        const files = await docs.load();
        if (files.size === 0) return '';

        const parts: string[] = [];
        for (const [path, content] of files) {
          parts.push(`## ${path}\n\n${content}`);
        }
        return parts.join('\n\n---\n\n');
      },
    };
  }

  /**
   * Create a ContextSource for a single file.
   */
  fileSource(id: string, relPath: string): ContextSource {
    const docs = this;
    return {
      id,
      async load() {
        return docs.readFile(relPath);
      },
    };
  }

  /**
   * Create a ContextSource that emits a compact topology of the corpus —
   * one line per file with its H1 title and H2 headings. No full content.
   *
   * This is the docs-warden warm-cache substrate for corpora too large to
   * hold inline (400KB+). The warden's advise LLM sees this ~50-tokens-per-file
   * index and picks file paths; the orchestrator hydrates selected files
   * on demand via HydrationAdapter.
   *
   * Output format (stable, deterministic — safe to diff across warm cycles):
   *
   *   docs/claude/API_ROUTES.md — API Routes
   *     H2: Overview, Naming, Validation, Error shapes
   *
   *   docs/claude/AUTH.md — Authentication
   *     H2: Session model, Token storage, Refresh flow
   *
   * Files with no H1 fall back to the file basename. Files with no H2s omit
   * the headings line entirely. Empty files are skipped.
   */
  topologySource(id: string, opts: { maxHeadings?: number } = {}): ContextSource {
    const docs = this;
    const maxHeadings = opts.maxHeadings ?? 12;
    return {
      id,
      async load() {
        const files = await docs.load();
        if (files.size === 0) return '';

        const lines: string[] = [];
        const paths = [...files.keys()].sort();

        for (const path of paths) {
          const content = files.get(path) ?? '';
          if (!content.trim()) continue;

          const { title, headings } = extractHeadings(content, maxHeadings);
          const displayTitle = title ?? basename(path, extname(path));
          lines.push(`${path} — ${displayTitle}`);
          if (headings.length > 0) {
            lines.push(`  H2: ${headings.join(', ')}`);
          }
          lines.push('');
        }

        return lines.join('\n').trimEnd();
      },
    };
  }

  /** Create a HydrationAdapter. Refs use relative paths as locators. */
  asAdapter(): HydrationAdapter {
    const docs = this;
    return {
      system: 'markdown',
      async hydrate(ref: ContextRef): Promise<string> {
        return docs.readFile(ref.locator);
      },
      async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
        return Promise.all(refs.map((r) => docs.readFile(r.locator)));
      },
    };
  }
}

/**
 * Extract the first H1 and all H2 headings from markdown content.
 * Returns `{ title: null, headings: [] }` if no structure is found.
 */
function extractHeadings(
  content: string,
  maxHeadings: number,
): { title: string | null; headings: string[] } {
  let title: string | null = null;
  const headings: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    if (title === null) {
      const h1 = /^#\s+(.+?)\s*$/.exec(line);
      if (h1) {
        title = h1[1];
        continue;
      }
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      headings.push(h2[1]);
      if (headings.length >= maxHeadings) break;
    }
  }

  return { title, headings };
}

/** One instruction file as loaded: the file itself or a file it imports with `@path`. */
export interface InstructionFile {
  readonly path: string;
  /** Text with block-level HTML comments removed, as Claude Code injects it. */
  readonly content: string;
  /** Import hops from the file the chain started at (0 for that file). */
  readonly depth: number;
  /** The file whose `@path` loaded this one. */
  readonly importedBy?: string;
}

export interface InstructionReadOptions {
  /** Home directory for `@~/` imports. Default: the process home. */
  home?: string;
  /** Import hops followed from the first file. Claude Code follows four. */
  maxDepth?: number;
  /** Real paths already loaded. Shared across a stack, it loads each file once and ends cycles. */
  seen?: Set<string>;
  /** Whether an import target may load; Claude Code asks before loading imports outside the project. */
  allows?: (path: string) => boolean;
  /** Called when a file is reached again after it already loaded (`seen`); it is not loaded twice. */
  onDuplicate?: (reach: { path: string; real: string; importedBy?: string }) => void;
}

/**
 * Claude Code imports a file with no extension or a text extension, and skips the rest (`.png`, an
 * unknown extension, or `notes.md.` with trailing punctuation). Its own list is longer; this covers
 * the text formats an instruction file plausibly imports.
 */
const TEXT_EXTENSIONS = new Set(
  (
    'md mdx markdown txt text rst adoc org json jsonc json5 yaml yml toml ini cfg conf xml csv tsv ' +
    'html htm css scss sass less ts tsx mts cts js jsx mjs cjs py pyi rb go rs java kt kts swift c h cc ' +
    'cpp hpp cs php sh bash zsh fish ps1 bat sql graphql gql proto prisma tf hcl lua r scala ex exs erl ' +
    'hs ml clj dart pl vue svelte astro gradle lock log diff patch'
  )
    .split(' ')
    .map((ext) => `.${ext}`),
);

/**
 * Never imported, whatever a file asks: dotfiles (`.env`, `.npmrc`), key material and credential
 * directories. Claude Code would import some of these; Foundry refuses because a committed file
 * must not be able to pull a secret into a shared context.
 */
export function secretInstructionPath(path: string): boolean {
  const name = basename(path);
  return (
    name.startsWith('.') ||
    /^id_[a-z0-9]+/i.test(name) ||
    /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) ||
    path.split(sep).some((part) => ['.ssh', '.aws', '.gnupg', '.kube', '.docker'].includes(part))
  );
}

/** Claude Code skips an instruction file larger than this. */
export const INSTRUCTION_FILE_LIMIT = 4 * 1024 * 1024;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Splits markdown into prose and fenced-code segments, in order. */
export function fenceSegments(text: string): Array<{ code: boolean; text: string }> {
  const segments: Array<{ code: boolean; text: string }> = [];
  let fence: string | undefined;
  let lines: string[] = [];
  const flush = (code: boolean) => {
    if (lines.length) segments.push({ code, text: lines.join('\n') });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (!fence && marker) {
      flush(false);
      fence = marker;
      lines.push(line);
    } else if (
      fence &&
      marker &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      !line.trim().slice(marker.length).trim()
    ) {
      lines.push(line);
      flush(true);
      fence = undefined;
    } else lines.push(line);
  }
  flush(fence !== undefined);
  return segments;
}

/** Removes block-level HTML comments outside fenced code, as Claude Code does before injecting. */
export function stripInstructionComments(text: string): string {
  return fenceSegments(text)
    .map((segment) =>
      segment.code
        ? segment.text
        : segment.text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\n|$)/gm, ''),
    )
    .join('\n');
}

/**
 * `@path` imports in document order. An import starts at a line start or after whitespace, so
 * `"@x"` and `a@x` are not imports; `\ ` escapes a space; code spans and fenced blocks are skipped.
 */
export function instructionImports(text: string): string[] {
  const imports: string[] = [];
  for (const segment of fenceSegments(text)) {
    if (segment.code) continue;
    // A code span never crosses a blank line; an indented block after a blank line is code.
    for (const paragraph of segment.text.split(/\n[ \t]*\n/)) {
      if (/^( {4}|\t)/.test(paragraph)) continue;
      const prose = paragraph.replace(/(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2/g, ' ');
      for (const match of prose.matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g))
        imports.push(match[1]!.replace(/\\ /g, ' '));
    }
  }
  return imports;
}

/** Where an import points: `~/` is the home directory, a relative path is relative to the importing file. */
export function resolveInstructionImport(target: string, importer: string, home = homedir()) {
  if (target === '~' || target.startsWith('~/')) return resolve(home, target.slice(2));
  return isAbsolute(target) ? resolve(target) : resolve(dirname(importer), target);
}

/**
 * Read an instruction file and what it imports, the way Claude Code loads CLAUDE.md: the file,
 * then each import depth-first in document order, up to four hops. A missing, non-file, non-text,
 * oversized or already-loaded target is skipped, so a cycle ends and a file shared by two importers
 * loads once.
 */
export async function readInstructionFile(
  path: string,
  options: InstructionReadOptions = {},
): Promise<InstructionFile[]> {
  const seen = options.seen ?? new Set<string>();
  const maxDepth = options.maxDepth ?? 4;
  const files: InstructionFile[] = [];
  const visit = async (file: string, depth: number, importedBy?: string) => {
    let real: string;
    try {
      real = await realpath(file);
      const info = await stat(real);
      if (!info.isFile() || info.size > INSTRUCTION_FILE_LIMIT) return;
    } catch {
      return;
    }
    // An import is judged on where it resolves and where its symlinks lead.
    if (importedBy && (secretInstructionPath(real) || (options.allows && !options.allows(real))))
      return;
    if (seen.has(real)) {
      options.onDuplicate?.({ path: file, real, ...(importedBy ? { importedBy } : {}) });
      return;
    }
    seen.add(real);
    const content = stripInstructionComments(await Bun.file(real).text());
    files.push({ path: file, content, depth, ...(importedBy ? { importedBy } : {}) });
    if (depth >= maxDepth) return;
    for (const target of instructionImports(content)) {
      const next = resolveInstructionImport(target, file, options.home);
      const ext = extname(next).toLowerCase();
      if ((ext && !TEXT_EXTENSIONS.has(ext)) || secretInstructionPath(next)) continue;
      if (!options.allows || options.allows(next)) await visit(next, depth + 1, file);
    }
  };
  await visit(resolve(path), 0);
  return files;
}

/** One file, then each file it imports under its own `Contents of` heading. */
export function formatInstructionFiles(files: readonly InstructionFile[]): string {
  return files
    .filter((file) => file.content.trim())
    .map((file) =>
      file.importedBy ? `Contents of ${file.path}:\n\n${file.content.trim()}` : file.content.trim(),
    )
    .join('\n\n');
}

/** Whether `path` is `root` or inside it. */
export function withinPath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A boundary test for `roots`, as written and with symlinks resolved, so a real path compares too. */
export function withinAny(roots: readonly string[]): (path: string) => boolean {
  const all = roots.flatMap((root) => {
    try {
      return [root, realpathSync(root)];
    } catch {
      return [root];
    }
  });
  return (path) => all.some((root) => withinPath(path, root));
}

/**
 * A ContextSource for one CLAUDE.md or similar file, with its `@path` imports resolved. Imports
 * load from the file's own directory tree only.
 */
export function claudemdSource(id: string, path: string): ContextSource {
  return {
    id,
    async load() {
      return formatInstructionFiles(
        await readInstructionFile(path, { allows: withinAny([dirname(resolve(path))]) }),
      );
    },
  };
}
