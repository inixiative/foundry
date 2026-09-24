import { expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalArchiveStore } from "@inixiative/session-archive/local";
import { RuntimeJobWorker } from "../src/providers/runtime-job-worker";
import { lockRuntimeJob } from "../src/providers/runtime-job-lock";
import { RuntimeJobRegistry } from "../src/providers/runtime-job-handler";
import { z } from "zod";

const connectionJob = () => ({ id: crypto.randomUUID(), installationId: crypto.randomUUID(), kind: "connectionCheck", status: "claimed", expiresAt: new Date(Date.now() + 600000).toISOString(), payload: null });
const privateRuntime = async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-jobs-"));
  const credentialFile = join(directory, "runtime.json");
  await writeFile(credentialFile, JSON.stringify({ secret: `kastle_runtime_${"a".repeat(43)}` }), { mode: 0o600 });
  return { directory, credentialFile };
};

test("local Archive failure retries receipt persistence before reporting completion", async () => {
  const { directory, credentialFile } = await privateRuntime();
  const job = connectionJob();
  let reports = 0;
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("reportRuntimeJob")) reports++;
    return Response.json({ data: path.endsWith("pollRuntimeJob") ? job : {} });
  }) as typeof fetch;
  const worker = new RuntimeJobWorker({ url: "https://kingdom.example", installationId: job.installationId, credentialFile }, transport);
  try {
    await writeFile(join(directory, "archives"), "blocked");
    await expect(worker.check()).rejects.toThrow();
    expect(reports).toBe(0);
    await unlink(join(directory, "archives"));
    await worker.check();
    expect(reports).toBe(1);
    const store = new LocalArchiveStore(join(directory, "archives", "archives.sqlite"));
    try { expect(store.list()).toHaveLength(1); expect(JSON.stringify(store.read(store.list()[0].id))).not.toContain("kastle_runtime_"); }
    finally { store.close(); }
  } finally { worker.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("OS job lock excludes concurrent execution and releases after a killed owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-job-lock-"));
  const path = join(directory, "active.sqlite");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const unlock = await lockRuntimeJob(path);
    expect(unlock).not.toBeNull();
    expect(await lockRuntimeJob(path)).toBeNull();
    unlock!();
    child = Bun.spawn([process.execPath, "-e", 'const {Database}=require("bun:sqlite");const d=new Database(process.argv[1]);d.exec("BEGIN IMMEDIATE");console.log("locked");setInterval(()=>{},1000);', path], { stdout: "pipe", stderr: "pipe" });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    expect(await lockRuntimeJob(path)).toBeNull();
    child.kill(9); await child.exited;
    const recovered = await lockRuntimeJob(path);
    expect(recovered).not.toBeNull(); recovered!();
  } finally { child?.kill(); await rm(directory, { recursive: true, force: true }); }
});

test("worker refuses a foreign installation and broad or substituted job capabilities", async () => {
  const { directory, credentialFile } = await privateRuntime();
  const job = connectionJob();
  let calls = 0;
  const transport = (async () => { calls++; return Response.json({ data: job }); }) as typeof fetch;
  try {
    const worker = new RuntimeJobWorker({ url: "https://kingdom.example", installationId: crypto.randomUUID(), credentialFile }, transport);
    await expect(worker.check()).rejects.toThrow("identity"); expect(calls).toBe(1); worker.stop();
    const foreignKind = { ...job, kind: "shell", command: "do not execute" };
    const another = new RuntimeJobWorker({ url: "https://kingdom.example", installationId: job.installationId, credentialFile }, (async () => Response.json({ data: foreignKind })) as typeof fetch);
    await expect(another.check()).rejects.toThrow(); another.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an unregistered kind fails closed and a registered handler owns its payload, expiry and actions", async () => {
  const { directory, credentialFile } = await privateRuntime();
  const installationId = crypto.randomUUID();
  const expired = { id: crypto.randomUUID(), installationId, kind: "externalKind", status: "claimed", expiresAt: new Date(Date.now() - 1000).toISOString(), external: { note: "payload" } };
  const paths: string[] = [];
  const transport = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    return Response.json({ data: path.endsWith("pollRuntimeJob") ? expired : {} });
  }) as typeof fetch;
  try {
    const closed = new RuntimeJobWorker({ url: "https://kingdom.example", installationId, credentialFile }, transport);
    await expect(closed.check()).rejects.toThrow('No runtime job handler is registered for kind "externalKind"');
    expect(paths).toEqual(["/api/v1/access/pollRuntimeJob"]);
    closed.stop();

    const seen: { note: string }[] = [];
    const handlers = new RuntimeJobRegistry().register({
      kind: "externalKind", ignoresExpiry: true, requestTimeoutMs: { externalAction: 4500 },
      payload: z.looseObject({ external: z.object({ note: z.string() }) }).transform(value => value.external),
      run: async (_job, payload, context) => { seen.push(payload); await context.request("externalAction", {}); },
    });
    const worker = new RuntimeJobWorker({ url: "https://kingdom.example", installationId, credentialFile }, transport, handlers);
    await worker.check();
    expect(seen).toEqual([{ note: "payload" }]);
    expect(paths).toEqual(["/api/v1/access/pollRuntimeJob", "/api/v1/access/pollRuntimeJob", "/api/v1/access/externalAction"]);
    worker.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
