import { join, relative, basename, extname } from "node:path";
import type { ContextSource } from "../context-layer";
import type { HydrationAdapter, ContextRef } from "../hydrator";

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
  constructor(dir: string, glob: string = "**/*.md") {
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
    if (!(await file.exists())) return "";
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
        if (files.size === 0) return "";

        const parts: string[] = [];
        for (const [path, content] of files) {
          parts.push(`## ${path}\n\n${content}`);
        }
        return parts.join("\n\n---\n\n");
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

  /** Create a HydrationAdapter. Refs use relative paths as locators. */
  asAdapter(): HydrationAdapter {
    const docs = this;
    return {
      system: "markdown",
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
 * Convenience: create a ContextSource from a single CLAUDE.md or similar file.
 */
export function claudemdSource(id: string, path: string): ContextSource {
  return {
    id,
    async load() {
      const file = Bun.file(path);
      if (!(await file.exists())) return "";
      return file.text();
    },
  };
}
