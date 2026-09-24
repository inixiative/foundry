import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewer } from "../src/viewer/server";
import { ConfigStore } from "../src/viewer/config";
import { ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";

test("file editor allows project documents and denies credential reads, writes and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundry-file-gate-"));
  const project = join(root, "project"), configDir = join(project, ".foundry"), outside = join(root, "outside");
  await mkdir(project); await mkdir(outside); await mkdir(configDir, { mode: 0o700 });
  const secretPath = join(project, "private-custom.json"), normal = join(project, "README.md");
  await writeFile(secretPath, "synthetic secret", { mode: 0o600 }); await writeFile(normal, "hello");
  await writeFile(join(configDir, "kingdom-runtime.json"), "synthetic secret");
  await symlink(outside, join(project, "escape")); await symlink(secretPath, join(project, "alias.json"));
  const store = new ConfigStore(configDir), cfg = await store.load();
  cfg.projects.demo = { path: project } as typeof cfg.projects[string];
  await store.save(cfg);
  const thread = new Thread("file-gate", new ContextStack()), viewer = createViewer({ configDir, configStore: store, localStore: null, harness: new Harness(thread), eventStream: new EventStream(), interventions: new InterventionLog(thread.signals) });
  const get = (path: string) => viewer.app.request(`http://localhost/api/files?path=${encodeURIComponent(path)}`);
  const put = (path: string) => viewer.app.request("http://localhost/api/files", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content: "replacement" }) });
  try {
    expect((await get(normal)).status).toBe(200);
    expect((await put(normal)).status).toBe(200);
    for (const path of [join(configDir, "kingdom-runtime.json"), join(project, "alias.json"), join(project, "escape", "new.txt"), join(project, ".env.local")]) {
      expect((await get(path)).status).toBe(403); expect((await put(path)).status).toBe(403);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
