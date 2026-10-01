// Copy into an external consumer installed from packed tarballs; never deep-import source.
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type {
  RuntimeJobHandler, RuntimeJobContext, RuntimeJobRequest, RuntimeIdentity,
  RuntimeJob, KingdomRuntimeSettings,
} from "@inixiative/foundry/runtime";

let accidentalNetwork = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { accidentalNetwork++; throw Error("Consumer test cannot use network"); }) as unknown as typeof fetch;
const runtime = await import("@inixiative/foundry/runtime");
const { RuntimeJobRegistry, RuntimeJobWorker, KingdomRuntimeConnection, SignetClient, SignetHttpError, runtimeJobSchema, kingdomRuntimeSchema } = runtime;

// Compile-time contract checks: the seam exposes no arbitrary Signet action or credential helper.
type SignetAction = Parameters<InstanceType<typeof SignetClient>["post"]>[0];
const allowedAction: SignetAction = "settleTask";
// @ts-expect-error A package export must not widen the existing Signet operation set.
const unavailableAction: SignetAction = "oracleUnapprovedAction";
void allowedAction; void unavailableAction;

const id = () => crypto.randomUUID();

test("installed tarball exposes only the named seam and performs no import-time network", async () => {
  expect(Object.keys(runtime).sort()).toEqual([
    "RuntimeJobRegistry", "RuntimeJobWorker", "KingdomRuntimeConnection", "SignetClient",
    "SignetHttpError", "runtimeJobSchema", "kingdomRuntimeSchema",
  ].sort());
  const resolved = await realpath(import.meta.resolve("@inixiative/foundry/runtime").replace(/^file:\/\//, ""));
  expect(resolved).toContain("/node_modules/@inixiative/foundry/");
  expect(accidentalNetwork).toBe(0);
  const hidden = "@inixiative/foundry/src/providers/runtime-job-handler";
  await expect(import(hidden)).rejects.toThrow();
});

test("consumer handler runs through controlled worker; unknown kind still refuses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-package-consumer-"));
  try {
    const settings: KingdomRuntimeSettings = { url: "https://kingdom.invalid", owner: `Organization::${id()}:`, installationId: id(), credentialFile: join(directory, "installation.json") };
    await writeFile(settings.credentialFile, JSON.stringify({ secret: "kingdom_runtime_" + "a".repeat(43) }), { mode: 0o600 });
    let executed = 0;
    const handler: RuntimeJobHandler<{ value: string }> = {
      kind: "consumerExample",
      payload: z.looseObject({ payload: z.object({ value: z.string() }).strict() }).transform(job => job.payload),
      async run(job: RuntimeJob, payload, context: RuntimeJobContext) {
        const request: RuntimeJobRequest = context.request;
        expect(job.installationId).toBe(settings.installationId);
        expect(payload.value).toBe("controlled");
        expect(context.stopped()).toBe(false);
        expect(context.directory).toContain(job.id);
        expect(context.runtimeDirectory).toBe(directory);
        executed++;
        await request("reportRuntimeJob", { jobId: job.id, status: "completed" });
      },
    };
    const registry = new RuntimeJobRegistry().register(handler);
    expect(() => registry.register(handler)).toThrow("already registered");
    expect(registry.kinds).toContain("connectionCheck");
    let kind = "consumerExample";
    const actions: string[] = [];
    const transport = (async (url: string | URL | Request) => {
      const action = String(url).split("/").at(-1)!; actions.push(action);
      return Response.json({ data: action === "pollRuntimeJob" ? {
        id: id(), installationId: settings.installationId, kind,
        status: "claimed", expiresAt: new Date(Date.now() + 60000).toISOString(), payload: { value: "controlled" },
      } : null });
    }) as typeof fetch;
    const worker = new RuntimeJobWorker(kingdomRuntimeSchema.parse(settings), transport, registry);
    await worker.check();
    expect(executed).toBe(1);
    expect(actions).toEqual(["pollRuntimeJob", "reportRuntimeJob"]);
    kind = "unregistered";
    await expect(worker.check()).rejects.toThrow("No runtime job handler");
    expect(executed).toBe(1);
    worker.stop();
    const before = actions.length; await worker.check(); expect(actions.length).toBe(before);
    const identity: RuntimeIdentity = { installationId: settings.installationId, userId: null, owner: { ownerModel: "Organization", organizationId: id() }, expiresAt: new Date().toISOString() };
    expect(identity.installationId).toBe(settings.installationId);
    const connection = new KingdomRuntimeConnection(settings, () => 0, transport, registry);
    expect(connection.connected).toBe(false); connection.stop();
    expect(runtimeJobSchema.safeParse({ kind: "bad" }).success).toBe(false);
    const client = new SignetClient(settings.url, join(directory, "absent.json"), id());
    await expect(client.post("describe", {})).rejects.toThrow();
    expect(new SignetHttpError(403).status).toBe(403);
    expect(accidentalNetwork).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

process.on("exit", () => { globalThis.fetch = originalFetch; });
