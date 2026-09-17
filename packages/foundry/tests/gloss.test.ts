import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { ConfigStore } from "../src/viewer/config";
import { registerGlossRoutes } from "../src/viewer/routes/gloss";
import { GlossService, installCommand, runProcess } from "../src/viewer/gloss/service";
import { auditWriteTree, projectPath } from "../src/viewer/gloss/paths";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "foundry-gloss-")); roots.push(root);
  mkdirSync(join(root, "src")); mkdirSync(join(root, ".gloss/src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(join(root, "src/main.ts"), "// why: retained invariant\n// gloss\nexport const answer = () => 42;\n");
  writeFileSync(join(root, ".gloss/src/main.ts.md"), "# src/main.ts\n\n## answer\n\nExplanatory margin. <script>danger()</script>\n");
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();

describe("Gloss adapter uses upstream semantics", () => {
  test("reads actual symbol bindings without modifying source or sidecar", async () => {
    const root = fixture(), service = new GlossService();
    const before = readFileSync(join(root, "src/main.ts"), "utf8");
    const data = await service.run(root, "read", "src/main.ts") as any;
    expect(data.revision).toBe("working-tree");
    expect(data.symbols[0]).toMatchObject({ name: "answer", startLine: 3, markerLine: 2 });
    expect(data.doc.sections[0].body).toContain("<script>");
    expect(readFileSync(join(root, "src/main.ts"), "utf8")).toBe(before);
    expect(await service.run(root, "list")).toEqual({ files: ["src/main.ts"] });
    expect(await service.run(root, "check")).toEqual({ violations: [] });
  });
  test("untracked freshness is unavailable, not fabricated", async () => {
    const result = await new GlossService().run(fixture(), "detail", "src/main.ts", "answer") as any;
    expect(result.freshness.reliable).toBe(false);
    expect(result.dirty).toBeNull();
  });
  test("refuses to attach current history to an older displayed snapshot", async () => {
    const root = fixture(), service = new GlossService();
    const read = await service.run(root, "read", "src/main.ts") as any;
    writeFileSync(join(root, ".gloss/src/main.ts.md"), "# src/main.ts\n\n## answer\n\nNew explanation\n");
    await expect(service.run(root, "detail", "src/main.ts", "answer", read.snapshot)).rejects.toThrow("refresh source");
    await expect(service.run(root, "history", "src/main.ts", "answer", read.snapshot)).rejects.toThrow("refresh source");
  });
  test("git freshness, history and working-tree edits stay distinct", async () => {
    const root = fixture(), service = new GlossService();
    git(root, "init"); git(root, "add", ".");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial");
    const original = await service.run(root, "detail", "src/main.ts", "answer") as any;
    expect(original.freshness.reliable).toBe(true); expect(original.dirty).toBe(false);
    writeFileSync(join(root, "src/main.ts"), "// gloss\nexport const answer = () => 43;\n");
    const changed = await service.run(root, "detail", "src/main.ts", "answer") as any;
    expect(changed.dirty).toBe(true);
    expect((await service.run(root, "history", "src/main.ts", "answer") as any).history).toContain("Explanatory margin");
  });
  test("setup is idempotent, harvest preserves why/directives, check catches orphaned notes", async () => {
    const root = fixture(), service = new GlossService();
    await service.run(root, "setup");
    const first = readFileSync(join(root, "CLAUDE.md"), "utf8");
    await service.run(root, "setup");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(first);
    writeFileSync(join(root, "src/new.ts"), "// why: required\n// useful commentary\nexport const second = 2;\n");
    await service.run(root, "harvest", "src/new.ts");
    expect(readFileSync(join(root, "src/new.ts"), "utf8")).toContain("// why: required");
    expect(readFileSync(join(root, "src/new.ts"), "utf8")).not.toContain("useful commentary");
    expect(readFileSync(join(root, ".gloss/src/new.ts.md"), "utf8")).toContain("useful commentary");
    writeFileSync(join(root, "src/main.ts"), "export const renamed = () => 42;\n");
    expect((await service.run(root, "check") as any).violations.length).toBeGreaterThan(0);
    await service.run(root, "fix");
    expect(readFileSync(join(root, ".gloss/src/main.ts.md"), "utf8")).toContain("Explanatory margin");
  });
  test("isolates custom directives between projects", async () => {
    const a = fixture(), b = fixture(), service = new GlossService();
    writeFileSync(join(a, "package.json"), JSON.stringify({ gloss: { directives: ["@custom"] } }));
    for (const root of [a, b]) writeFileSync(join(root, "src/new.ts"), "// @custom preserved only in A\nexport const second = 2;\n");
    await service.run(a, "harvest"); await service.run(b, "harvest");
    expect(readFileSync(join(a, "src/new.ts"), "utf8")).toContain("@custom");
    expect(readFileSync(join(b, "src/new.ts"), "utf8")).not.toContain("@custom");
  });
});

describe("Gloss boundaries", () => {
  test("rejects traversal, symlinks and oversized source", async () => {
    const root = fixture(), outside = fixture(), service = new GlossService();
    for (const file of ["../escape.ts", "/tmp/escape.ts", "src/../escape.ts", "src\\main.ts", ".env"]) {
      await expect(service.run(root, "read", file)).rejects.toThrow();
    }
    symlinkSync(join(outside, "src"), join(root, "linked"));
    await expect(service.run(root, "read", "linked/main.ts")).rejects.toThrow("symlinks");
    expect(() => auditWriteTree(root)).toThrow("symlinks");
    rmSync(join(root, "linked"));
    symlinkSync("/nonexistent-gloss-target", join(root, ".gloss/src/dangling.ts.md"));
    expect(() => projectPath(root, ".gloss/src/dangling.ts.md", true)).toThrow("symlinks");
    await expect(service.run(root, "setup")).rejects.toThrow("symlinks");
    writeFileSync(join(root, "src/large.ts"), " ".repeat(1024 * 1024 + 1));
    await expect(service.run(root, "read", "src/large.ts")).rejects.toThrow("1 MiB");
  });
  test("does not import project-local package code", async () => {
    const root = fixture();
    mkdirSync(join(root, "node_modules/@inixiative/gloss"), { recursive: true });
    writeFileSync(join(root, "node_modules/@inixiative/gloss/package.json"), '{"main":"index.js"}');
    writeFileSync(join(root, "node_modules/@inixiative/gloss/index.js"), 'throw new Error("project code executed")');
    expect((await new GlossService().run(root, "read", "src/main.ts") as any).symbols[0].name).toBe("answer");
  });
  test("install commands pin the adapter version and disable scripts", () => {
    const root = fixture();
    expect(installCommand(root)).toEqual(["npm", "install", "--save-dev", "--save-exact", "--ignore-scripts", "@inixiative/gloss@0.0.4"]);
    writeFileSync(join(root, "package.json"), '{"packageManager":"bun@1.3.14"}');
    expect(installCommand(root)[0]).toBe(process.execPath);
    writeFileSync(join(root, "package.json"), '{"packageManager":"pnpm@10"}');
    expect(() => installCommand(root)).toThrow("package manager");
  });
  test("refuses overlapping maintenance and releases lock after failure", async () => {
    const root = fixture();
    let release!: (output: string) => void;
    const service = new GlossService(() => new Promise(resolve => { release = resolve; }));
    const pending = service.run(root, "setup");
    await expect(service.run(root, "harvest")).rejects.toThrow("busy");
    await expect(service.run(root, "read", "src/main.ts")).rejects.toThrow("busy");
    release('{"result":{}}'); await pending;
    expect(service.status(root).busy).toBe(false);
    const failing = new GlossService(async () => { throw new Error("fixture failure"); });
    await expect(failing.run(root, "setup")).rejects.toThrow("fixture failure");
    expect(failing.status(root).busy).toBe(false);
  });
  test("timeout terminates and reaps a worker", async () => {
    await expect(runProcess([process.execPath, "-e", "setInterval(()=>{},1000)"], fixture(), undefined, 50)).rejects.toThrow("timed out");
  });
});

describe("project routes", () => {
  async function appFixture() {
    const root = fixture();
    const config = new ConfigStore(join(root, ".foundry"));
    await config.patch("projects", { one: { id: "one", path: root } });
    const app = new Hono(); registerGlossRoutes(app, config);
    const req = (path: string, method = "GET", body?: unknown, extra?: Record<string, string>) => app.request(`/api/projects/one/gloss/${path}`, {
      method, headers: { "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { root, app, req, config };
  }
  test("viewing is available when disabled; writes require enable AND confirmation", async () => {
    const { req, root } = await appFixture();
    expect((await req("read?file=src/main.ts")).status).toBe(200);
    expect((await req("actions", "POST", { action: "setup", confirmed: true })).status).toBe(409);
    expect((await req("settings", "PUT", { enabled: true, display: "hover" })).status).toBe(200);
    expect((await req("actions", "POST", { action: "setup" })).status).toBe(409);
    expect((await req("actions", "POST", { action: "setup", confirmed: true })).status).toBe(200);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("gloss:begin");
    expect((await req("actions", "POST", { action: "watch", confirmed: true })).status).toBe(400);
    await req("settings", "PUT", { enabled: false, display: "margin" });
    expect((await req("read?file=src/main.ts")).status).toBe(200);
    expect((await req("actions", "POST", { action: "check" })).status).toBe(200);
  });
  test("validates settings and project identity; rejects cross-origin writes", async () => {
    const { req, app } = await appFixture();
    expect((await app.request("/api/projects/absent/gloss/status")).status).toBe(404);
    expect((await app.request("/api/projects/__proto__/gloss/status")).status).toBe(404);
    expect((await req("settings", "PUT", { enabled: "true", display: "margin" })).status).toBe(400);
    expect((await req("settings", "PUT", { enabled: true, display: "other" })).status).toBe(400);
    expect((await req("settings", "PUT", { enabled: true, display: "margin" }, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await req("read?file=..%2Foutside.ts")).status).toBe(400);
    expect((await req("settings", "PUT", { enabled: true, display: "margin" })).status).toBe(200);
    expect((await req("status")).status).toBe(200);
    expect((await (await req("status")).json()).settings.enabled).toBe(true);
  });
});
