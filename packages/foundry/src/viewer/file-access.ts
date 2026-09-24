import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FoundryConfig } from "./config";

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const canonical = async (path: string): Promise<string> => {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
};
export class ViewerFileAccess {
  private protectedPaths = new Set<string>();
  constructor(configDir: string) { this.protectedPaths.add(resolve(configDir)); }
  remember(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "credentialFile" || key === "profileDirectory") && typeof item === "string") this.protectedPaths.add(resolve(item));
      else this.remember(item);
    }
  }
  async resolve(raw: string, config: FoundryConfig): Promise<string> {
    this.remember(config);
    const path = resolve(raw.replace(/^file:\/\//, ""));
    const target = await canonical(path);
    const roots = [resolve("."), ...Object.values(config.projects ?? {}).map(project => resolve(project.path))];
    const allowed = await Promise.all(roots.map(root => canonical(root)));
    if (!roots.some(root => within(path, root)) || !allowed.some(root => within(target, root))) throw Error("Path outside project roots");
    const sensitive = (value: string) => value.split(sep).some(part => [".git", ".ssh", ".codex", ".claude", ".aws", "gcloud", "auth.json", ".credentials.json", "tunnel-token", "kingdom-runtime.json"].includes(part) || (part.startsWith(".env") && !part.endsWith(".example")));
    if (sensitive(path) || sensitive(target)) throw Error("Private configuration cannot be opened in the file editor");
    for (const protectedPath of this.protectedPaths) {
      if (within(path, protectedPath) || within(target, await canonical(protectedPath))) throw Error("Private configuration cannot be opened in the file editor");
    }
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw Error("Only regular project files can be edited");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return target;
  }
}
