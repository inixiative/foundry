import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const MAX_FILE_BYTES = 1024 * 1024;

export function projectPath(root: string, relative: string, missing = false): string {
  if (!relative || isAbsolute(relative) || relative.includes("\\") || relative.includes("\0") ||
      relative.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Expected a project-relative path without traversal");
  }
  let current = realpathSync(root);
  for (const part of relative.split("/")) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Gloss does not follow symlinks");
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return current;
}

export function sourcePath(root: string, file: string): string {
  if (!/\.(ts|tsx|mts|cts)$/.test(file) || file.split("/").some(p => p.startsWith(".") || p === "node_modules")) {
    throw new Error("Select a TypeScript source file outside hidden and dependency directories");
  }
  return projectPath(root, file);
}

export function boundedFile(path: string): void {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("File is not regular or exceeds 1 MiB");
}

// Gloss's repo-wide writers are synchronous. Reject linked trees before handing
// control to them, including dangling links that existsSync would miss.
export function auditWriteTree(root: string): void {
  let entries = 0;
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 100_000) throw new Error("Project exceeds the maintenance scan limit");
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) throw new Error("Maintenance refused: project contains symlinks");
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  };
  walk(resolve(root));
}

export function glossFiles(root: string): string[] {
  const directory = projectPath(root, ".gloss", true);
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  let entries = 0;
  const walk = (path: string, prefix: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (++entries > 20_000) throw new Error("Gloss tree exceeds the listing limit");
      if (entry.isSymbolicLink()) throw new Error("Gloss does not follow symlinks");
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(join(path, entry.name), relative + "/");
      else if (entry.isFile() && /\.(ts|tsx|mts|cts)\.md$/.test(relative)) files.push(relative.slice(0, -3));
    }
  };
  walk(directory, "");
  return files.sort();
}
