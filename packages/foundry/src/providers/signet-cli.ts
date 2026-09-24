import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ConfigStore } from "../viewer/config";
import { installationCredentialSchema, readPrivateJson, writePrivateJson } from "./kastle-credential-file";
import { deliveredSignetSchema, generateSignetKey, SignetClient, signetCredentialSchema, signetPost, signetProof, signetPublicKey } from "./signet-client";
import { kastleUrl } from "./kastle-client";

const pendingSchema = z.object({ url: z.string().transform(kastleUrl), requestId: z.string().uuid(), reviewCode: z.string(), deviceCode: z.string(), expiresAt: z.string().datetime(), keyFile: z.string(), connectionId: z.string().uuid(), name: z.string(), projectId: z.string().min(1), threadId: z.string().optional() });
const proposalSchema = z.object({ name: z.string().min(1), connectionId: z.string().uuid(), resources: z.array(z.object({ resourceId: z.string().uuid(), operations: z.array(z.string()).min(1), lens: z.object({ documentIds: z.array(z.string().uuid()).optional(), fields: z.array(z.enum(["id", "title", "content", "tags", "createdAt"])).optional() }).strict().default({}) }).strict()).min(1), lifecycle: z.enum(["request", "task", "ongoing"]), taskId: z.string().uuid().optional(), expiresAt: z.string().datetime().nullable(), maxRequests: z.number().int().min(1), maxConcurrent: z.number().int().min(1) }).strict();
const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true, options: {
  "config-dir": { type: "string", default: ".foundry" }, proposal: { type: "string" }, project: { type: "string" }, thread: { type: "string" }, pending: { type: "string" }, credential: { type: "string" }, revision: { type: "string" }, task: { type: "string" }, reason: { type: "string", default: "completed" },
} });
const directory = resolve(values["config-dir"]!);
const store = new ConfigStore(directory);
const command = positionals[0];
const connect = async (pending: z.infer<typeof pendingSchema>, delivered: z.infer<typeof deliveredSignetSchema>) => {
  const credentialFile = join(directory, `signet-${delivered.signetId}.json`);
  await writePrivateJson(credentialFile, signetCredentialSchema.parse({ ...delivered, url: pending.url, keyFile: pending.keyFile }));
  const config = await store.load();
  const existing = config.kastleAccess?.find(source => source.signetId === delivered.signetId && source.url === pending.url);
  const source = { id: existing?.id ?? crypto.randomUUID(), url: pending.url, credentialFile, signetId: delivered.signetId, connectionId: pending.connectionId, name: pending.name, projectIds: [pending.projectId], ...(pending.threadId ? { threadIds: [pending.threadId] } : {}) };
  await store.save({ ...config, kastleAccess: [...(config.kastleAccess ?? []).filter(source => source.id !== existing?.id), source] });
  console.log(JSON.stringify({ connected: true, signetId: delivered.signetId, accessId: source.id, projectId: pending.projectId, expiresAt: delivered.expiresAt, idleExpiresAt: delivered.idleExpiresAt, renewalExpiresAt: delivered.renewalExpiresAt, restartViewer: true }));
};
try {
  if (command === "request") {
    if (!values.proposal || !values.project) throw Error("Usage: signet request --proposal FILE --project ID [--thread ID] [--config-dir DIR]");
    const proposal = proposalSchema.parse(await Bun.file(resolve(values.proposal)).json());
    if (proposal.lifecycle === "task" && !values.thread) throw Error("Usage: task grants require --thread ID to bind the configured access to the requesting Foundry thread");
    const config = await store.load();
    if (!config.kingdomRuntime) throw Error("Connect Foundry to Kingdom before requesting a Signet");
    const runtime = installationCredentialSchema.parse(await readPrivateJson(config.kingdomRuntime.credentialFile));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const keyFile = join(directory, `signet-key-${crypto.randomUUID()}.json`);
    const key = generateSignetKey();
    await writePrivateJson(keyFile, key);
    const result = await signetPost(config.kingdomRuntime.url, "requestSignet", { ...proposal, publicKey: signetPublicKey(key) }, { authorization: `Bearer ${runtime.secret}`, DPoP: await signetProof(config.kingdomRuntime.url, "requestSignet", keyFile) });
    const pending = pendingSchema.parse({ ...(typeof result === "object" ? result : {}), url: config.kingdomRuntime.url, keyFile, connectionId: proposal.connectionId, name: proposal.name, projectId: values.project, threadId: values.thread });
    const pendingFile = join(directory, `signet-request-${pending.requestId}.json`);
    await writePrivateJson(pendingFile, pending);
    console.log(JSON.stringify({ requestId: pending.requestId, reviewCode: pending.reviewCode, expiresAt: pending.expiresAt, pendingFile, next: "Approve this code in Kingdom, then run signet collect --pending FILE" }));
  } else if (command === "collect") {
    if (!values.pending) throw Error("Usage: signet collect --pending FILE [--config-dir DIR]");
    const pending = pendingSchema.parse(await readPrivateJson(resolve(values.pending)));
    if (Date.parse(pending.expiresAt) <= Date.now()) throw Error("Approval delivery window expired; request a new approval");
    const response = deliveredSignetSchema.parse(await signetPost(pending.url, "collectSignet", { deviceCode: pending.deviceCode }, { DPoP: await signetProof(pending.url, "collectSignet", pending.keyFile) }));
    await connect(pending, response);
  } else if (command === "reenroll") {
    if (!values.credential || !values.revision) throw Error("Usage: signet reenroll --credential FILE --revision ACCEPTED_REVISION [--config-dir DIR]");
    const path = resolve(values.credential), credential = signetCredentialSchema.parse(await readPrivateJson(path));
    const config = await store.load();
    if (!config.kingdomRuntime || kastleUrl(config.kingdomRuntime.url) !== credential.url) throw Error("Foundry must be connected to the Signet issuer");
    const runtime = installationCredentialSchema.parse(await readPrivateJson(config.kingdomRuntime.credentialFile));
    const response = await signetPost(credential.url, "enrollSignet", { signetId: credential.signetId, expectedRevision: z.coerce.number().int().min(1).parse(values.revision), name: "Foundry", publicKey: signetPublicKey(await readPrivateJson(credential.keyFile)) }, { authorization: `Bearer ${runtime.secret}`, DPoP: await signetProof(credential.url, "enrollSignet", credential.keyFile) });
    const delivered = deliveredSignetSchema.parse({ ...(typeof response === "object" ? response : {}), signetId: credential.signetId });
    await writePrivateJson(path, signetCredentialSchema.parse({ ...credential, ...delivered }));
    console.log(JSON.stringify({ connected: true, signetId: credential.signetId, enrollmentId: delivered.enrollmentId, idleExpiresAt: delivered.idleExpiresAt }));
  } else if (command === "close") {
    if (!values.credential || !values.task) throw Error("Usage: signet close --credential FILE --task UUID [--reason completed|cancelled]");
    const path = resolve(values.credential), credential = signetCredentialSchema.parse(await readPrivateJson(path));
    const result = await new SignetClient(credential.url, path, credential.signetId).post("closeTask", { signetId: credential.signetId, taskId: z.string().uuid().parse(values.task), reason: z.enum(["completed", "cancelled"]).parse(values.reason) });
    console.log(JSON.stringify(result));
  } else throw Error("Usage: signet request|collect|reenroll|close");
} catch (error) {
  console.error(error instanceof Error && (error.message.startsWith("Usage:") || error.message.startsWith("Signet request refused") || error.message.startsWith("Approval delivery")) ? error.message : "Signet setup unavailable. Check Foundry identity, owner approval, private files and the selected context. No credentials were printed.");
  process.exitCode = 1;
}
