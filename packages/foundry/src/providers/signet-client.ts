import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { kastleUrl } from "./kastle-client";
import { readPrivateJson, writePrivateJson } from "./kastle-credential-file";

const publicKeySchema = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const signetKeySchema = publicKeySchema.extend({ d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const signetCredentialSchema = z.object({
  url: z.string().transform(kastleUrl), signetId: z.string().uuid(), enrollmentId: z.string().uuid(),
  lifecycle: z.enum(["request", "task", "ongoing"]), taskId: z.string().uuid().nullable(), keyFile: z.string().refine(isAbsolute), renewalCredential: z.string().regex(/^signet_renew_[A-Za-z0-9_-]{43}$/),
  accessToken: z.string().regex(/^kastle_[A-Za-z0-9_-]{43}$/), expiresAt: z.string().datetime(), renewalExpiresAt: z.string().datetime(), idleExpiresAt: z.string().datetime(), tokenType: z.literal("DPoP"),
}).strict();
export const deliveredSignetSchema = signetCredentialSchema.omit({ url: true, keyFile: true });
const renewalResponseSchema = deliveredSignetSchema.omit({ signetId: true, renewalCredential: true });
const refreshing = new Map<string, Promise<z.infer<typeof signetCredentialSchema>>>();

export const generateSignetKey = () => signetKeySchema.parse(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }));
export const signetPublicKey = (key: unknown) => publicKeySchema.parse(createPublicKey(createPrivateKey({ key: signetKeySchema.parse(key), format: "jwk" })).export({ format: "jwk" }));

export class SignetHttpError extends Error {
  constructor(readonly status: number) { super(`Signet request refused (${status})`); }
}
export async function signetPost(url: string, action: string, body: unknown, headers: Record<string, string> = {}, onDispatch?: () => void): Promise<unknown> {
  if (!/^[a-zA-Z]+$/.test(action)) throw Error("Invalid Signet action");
  onDispatch?.();
  const response = await fetch(`${kastleUrl(url)}/api/v1/access/${action}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  if (!response.ok) { await response.body?.cancel(); throw new SignetHttpError(response.status); }
  const reader = response.body?.getReader();
  if (!reader) throw Error("Signet response unavailable");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1_048_576) throw Error("Signet response exceeds limit");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return z.object({ data: z.unknown() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).data;
}
export async function signetProof(url: string, action: string, keyFile: string, token?: string): Promise<string> {
  const key = signetKeySchema.parse(await readPrivateJson(keyFile));
  const nonce = z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(await signetPost(url, "nonce", {})).nonce;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "dpop+jwt", jwk: signetPublicKey(key) });
  const payload = encode({ htu: `${kastleUrl(url)}/api/v1/access/${action}`, htm: "POST", nonce, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), ...(token ? { ath: createHash("sha256").update(token).digest("base64url") } : {}) });
  const input = `${header}.${payload}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: createPrivateKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
export class SignetClient {
  constructor(private url: string, private credentialFile: string, private signetId: string) { this.url = kastleUrl(url); }
  private async credentials(force = false) {
    const credential = signetCredentialSchema.parse(await readPrivateJson(this.credentialFile));
    if (credential.url !== this.url || credential.signetId !== this.signetId) throw Error("Signet credential audience mismatch");
    if (Date.parse(credential.idleExpiresAt) <= Date.now()) throw Error("Signet enrollment idle timeout; use signet reenroll with your Foundry identity");
    if (!force && Date.parse(credential.expiresAt) > Date.now() + 30000) return credential;
    if (Date.parse(credential.renewalExpiresAt) <= Date.now()) throw Error("Signet enrollment expired; request renewed approval");
    const existing = refreshing.get(this.credentialFile); if (existing) return existing;
    const refresh = (async () => {
      const response = renewalResponseSchema.parse(await signetPost(this.url, "renewSignet", { renewalCredential: credential.renewalCredential }, { DPoP: await signetProof(this.url, "renewSignet", credential.keyFile) }));
      if (response.enrollmentId !== credential.enrollmentId || response.lifecycle !== credential.lifecycle || response.taskId !== credential.taskId) throw Error("Signet enrollment changed");
      const updated = signetCredentialSchema.parse({ ...credential, ...response });
      await writePrivateJson(this.credentialFile, updated);
      return updated;
    })();
    refreshing.set(this.credentialFile, refresh);
    try { return await refresh; } finally { refreshing.delete(this.credentialFile); }
  }
  async renew(): Promise<void> { await this.credentials(true); }
  async post(action: "describe" | "execute" | "closeTask" | "runtimeJobStep" | "medicalQuestionStep", body: unknown, onDispatch?: () => void) {
    const credential = await this.credentials();
    return signetPost(this.url, action, body, { authorization: `DPoP ${credential.accessToken}`, DPoP: await signetProof(this.url, action, credential.keyFile, credential.accessToken) }, onDispatch);
  }
}
