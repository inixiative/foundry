import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KastleClient, kastleEnvelopeSchema, kastleSelectionSchema } from "../src/providers/kastle-client";
import { KastleAccessClient, kastleAccessSourceSchema } from "../src/providers/kastle-access-client";

test("Kingdom Integration selection/envelope use canonical wire fields and reject old or ambiguous names", async () => {
  const integrationId = crypto.randomUUID(), runId = crypto.randomUUID(), bindingId = crypto.randomUUID();
  const envelope = { id: bindingId, kastleId: crypto.randomUUID(), installationId: crypto.randomUUID(), runId,
    integrationId, capacityId: crypto.randomUUID(), model: "controlled", effort: "low", runtime: "claude",
    expiresAt: new Date(Date.now() + 60000).toISOString(), gatewayPath: `/api/v1/access/gateway/${bindingId}` };
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    expect(await request.json()).toEqual({ runId, selection: { integrationIds: [integrationId] } });
    return Response.json({ data: envelope });
  } });
  try {
    const client = new KastleClient(server.url.origin, "synthetic");
    expect((await client.resolve(runId, { integrationIds: [integrationId] })).integrationId).toBe(integrationId);
    expect(kastleSelectionSchema.safeParse({ connectionIds: [integrationId] }).success).toBe(false);
    expect(kastleSelectionSchema.safeParse({ integrationIds: [integrationId], connectionIds: [integrationId] }).success).toBe(false);
    const { integrationId: _, ...withoutIntegration } = envelope;
    expect(kastleEnvelopeSchema.safeParse({ ...withoutIntegration, connectionId: integrationId }).success).toBe(false);
    expect(kastleEnvelopeSchema.safeParse({ ...envelope, connectionId: integrationId }).success).toBe(false);
    expect(calls).toBe(1);
  } finally { server.stop(true); }
});

test("read routes the exact discovered resource Integration and rejects foreign grant identity before execute", async () => {
  const directory = await mkdtemp(join(tmpdir(), "integration-contract-"));
  const integrationId = crypto.randomUUID(), resourceIntegrationId = crypto.randomUUID();
  const signetId = crypto.randomUUID(), resourceId = crypto.randomUUID();
  const executions: any[] = [];
  let foreign = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("describe")) return Response.json({ data: {
      signetId, integrationId: foreign ? crypto.randomUUID() : integrationId, provider: "archive", name: "Controlled",
      expiresAt: null, lifecycle: "task", taskId: crypto.randomUUID(), currentRevision: 1, remainingRequests: 2,
      operations: [{ key: "documents.read", name: "Read", resources: [{ id: resourceId, name: "Controlled", kind: "document", integrationId: resourceIntegrationId }] }],
    } });
    executions.push(body);
    expect(Object.keys(body as object).sort()).toEqual(["requestId", "runId", "integrationId", "signetId", "taskId", "operation", "input"].sort());
    return Response.json({ data: { executionId: crypto.randomUUID(), result: { title: "Controlled" } } });
  } });
  try {
    const source = { id: crypto.randomUUID(), name: "Controlled", url: server.url.origin,
      credentialFile: join(directory, "credential.json"), integrationId, signetId, projectIds: ["P"] };
    await writeFile(source.credentialFile, JSON.stringify({ secret: "kastle_" + "a".repeat(43) }), { mode: 0o600 });
    const client = new KastleAccessClient(source);
    const input = { requestId: crypto.randomUUID(), runId: crypto.randomUUID(), operation: "documents.read", resourceId, limit: 1 };
    await client.read(input);
    expect(executions[0].integrationId).toBe(resourceIntegrationId);
    expect(executions[0]).not.toHaveProperty("connectionId");
    foreign = true;
    await expect(client.read({ ...input, requestId: crypto.randomUUID() })).rejects.toThrow("another grant");
    expect(executions).toHaveLength(1);
    const { integrationId: _, ...withoutIntegration } = source;
    expect(kastleAccessSourceSchema.safeParse({ ...withoutIntegration, connectionId: integrationId }).success).toBe(false);
    expect(kastleAccessSourceSchema.safeParse({ ...source, connectionId: integrationId }).success).toBe(false);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
