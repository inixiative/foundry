import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boundedFile, projectPath } from "./paths";

export const GLOSS_VERSION = "0.0.4";
export type GlossAction = "list" | "read" | "detail" | "history" | "setup" | "check" | "fix" | "harvest" | "install";
export class GlossError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 413 | 503 = 400) { super(message); }
}

export function installCommand(root: string): string[] {
  const path = projectPath(root, "package.json");
  boundedFile(path);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const manager = pkg.packageManager?.split("@")[0];
  if (manager && manager !== "bun" && manager !== "npm") throw new GlossError("Install Gloss with this project's package manager, then retry setup");
  if (!manager && ["pnpm-lock.yaml", "yarn.lock"].some(p => existsSync(projectPath(root, p, true)))) {
    throw new GlossError("Install Gloss with this project's package manager, then retry setup");
  }
  const bun = manager === "bun" || (!manager && ["bun.lock", "bun.lockb"].some(p => existsSync(projectPath(root, p, true))));
  return bun ? [process.execPath, "add", "--dev", "--exact", "--ignore-scripts", `@inixiative/gloss@${GLOSS_VERSION}`] :
    ["npm", "install", "--save-dev", "--save-exact", "--ignore-scripts", `@inixiative/gloss@${GLOSS_VERSION}`];
}

export function runProcess(command: string[], root: string, input?: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: root, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let output = "", stderr = "", bytes = 0, failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Already exited. */ }
    };
    const timer = setTimeout(() => stop(new GlossError("Gloss operation timed out; inspect project changes before retrying", 503)), timeout);
    const collect = (chunk: Buffer, err: boolean) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) return stop(new GlossError("Gloss output exceeds 4 MiB", 413));
      if (err) stderr += chunk.toString(); else output += chunk.toString();
    };
    child.stdout.on("data", chunk => collect(chunk, false));
    child.stderr.on("data", chunk => collect(chunk, true));
    child.stdin.on("error", () => {});
    child.on("error", error => { failure = new GlossError(`Could not start Gloss operation: ${error.message}`, 503); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) {
        try { const data = JSON.parse(output); if (data.error) return reject(new GlossError(data.error)); } catch {}
        return reject(new GlossError(`Gloss operation failed (${code}): ${stderr.slice(-2000) || output.slice(-2000)}`, 503));
      }
      resolve(output);
    });
    child.stdin.end(input ?? "");
  });
}

export class GlossService {
  private busy = new Set<string>();
  private readers = new Map<string, number>();
  constructor(private runner = runProcess) {}

  async run(root: string, action: GlossAction, file?: string, symbol?: string, snapshot?: string): Promise<unknown> {
    root = realpathSync(root);
    const readOnly = ["list", "read", "detail", "history"].includes(action);
    const readers = this.readers.get(root) ?? 0;
    if (this.busy.has(root) || (!readOnly && readers > 0) || readers >= 4) {
      throw new GlossError("Gloss is busy for this project; retry when the current operation finishes", 409);
    }
    if (readOnly) this.readers.set(root, readers + 1); else this.busy.add(root);
    try {
      if (action === "install") {
        // Installation is deliberately separate from setup/harvest and never runs
        // lifecycle scripts from the target project or its dependencies.
        const command = installCommand(root);
        const output = await this.runner(command, root, undefined, 120_000);
        return { version: GLOSS_VERSION, output };
      }
      const output = await this.runner([process.execPath, fileURLToPath(new URL("./worker.ts", import.meta.url))], root,
        JSON.stringify({ root, action, file, symbol, snapshot }));
      return JSON.parse(output).result;
    } finally {
      if (readOnly) {
        const count = (this.readers.get(root) ?? 1) - 1;
        if (count) this.readers.set(root, count); else this.readers.delete(root);
      } else this.busy.delete(root);
    }
  }

  status(root: string) {
    root = realpathSync(root);
    const packagePath = projectPath(root, "package.json", true);
    if (existsSync(packagePath)) boundedFile(packagePath);
    const pkg = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")) : {};
    return { adapterVersion: GLOSS_VERSION, declaredVersion: pkg.devDependencies?.["@inixiative/gloss"] ??
      pkg.dependencies?.["@inixiative/gloss"] ?? null,
      initialized: existsSync(projectPath(root, ".gloss", true)), busy: this.busy.has(root) };
  }
}
