import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { kingdomUrl } from './kingdom-client';
import { readPrivateJson, writePrivateJson } from './kingdom-credential-file';
import { accessSecretPattern } from './kingdom-secrets';

const publicKeySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const signetKeySchema = publicKeySchema
  .extend({ d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const signetCredentialSchema = z
  .object({
    url: z.string().transform(kingdomUrl),
    signetId: z.string().uuid(),
    enrollmentId: z.string().uuid(),
    lifecycle: z.enum(['request', 'task', 'ongoing']),
    taskId: z.string().uuid().nullable(),
    keyFile: z.string().refine(isAbsolute),
    renewalCredential: z.string().regex(/^signet_renew_[A-Za-z0-9_-]{43}$/),
    accessToken: z.string().regex(accessSecretPattern),
    expiresAt: z.string().datetime(),
    renewalExpiresAt: z.string().datetime(),
    idleExpiresAt: z.string().datetime(),
    tokenType: z.literal('DPoP'),
  })
  .strict();
export const deliveredSignetSchema = signetCredentialSchema.omit({ url: true, keyFile: true });
const renewalResponseSchema = deliveredSignetSchema.omit({
  signetId: true,
  renewalCredential: true,
});
const refreshing = new Map<string, Promise<z.infer<typeof signetCredentialSchema>>>();

export const generateSignetKey = () =>
  signetKeySchema.parse(
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }),
  );
export const signetPublicKey = (key: unknown) =>
  publicKeySchema.parse(
    createPublicKey(createPrivateKey({ key: signetKeySchema.parse(key), format: 'jwk' })).export({
      format: 'jwk',
    }),
  );

export class SignetHttpError extends Error {
  constructor(readonly status: number) {
    super(`Signet request refused (${status})`);
  }
}
export interface SignetRequestOptions {
  signal?: AbortSignal;
}
const requestSignal = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);

/** Stop this caller waiting without canceling shared credential renewal. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export async function signetPost(
  url: string,
  action: string,
  body: unknown,
  headers: Record<string, string> = {},
  onDispatch?: () => void,
  options: SignetRequestOptions = {},
): Promise<unknown> {
  if (!/^[a-zA-Z]+$/.test(action)) throw Error('Invalid Signet action');
  const signal = requestSignal(options.signal);
  signal.throwIfAborted();
  const serialized = JSON.stringify(body);
  onDispatch?.();
  signal.throwIfAborted();
  const pendingResponse = fetch(`${kingdomUrl(url)}/api/v1/access/${action}`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/json', ...headers },
    body: serialized,
  });
  // Also close a response from a transport that settles after cancellation.
  void pendingResponse.then(
    (response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => {});
    },
    () => {},
  );
  const response = await abortable(pendingResponse, signal);
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SignetHttpError(response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Signet response unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1_048_576) throw Error('Signet response exceeds limit');
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  signal.throwIfAborted();
  return z.object({ data: z.unknown() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    .data;
}
export async function signetProof(
  url: string,
  action: string,
  keyFile: string,
  token?: string,
  options: SignetRequestOptions = {},
): Promise<string> {
  const signal = requestSignal(options.signal);
  signal.throwIfAborted();
  const key = signetKeySchema.parse(await abortable(readPrivateJson(keyFile), signal));
  signal.throwIfAborted();
  const nonce = z
    .object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
    .parse(await signetPost(url, 'nonce', {}, {}, undefined, { signal })).nonce;
  signal.throwIfAborted();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'ES256', typ: 'dpop+jwt', jwk: signetPublicKey(key) });
  const payload = encode({
    htu: `${kingdomUrl(url)}/api/v1/access/${action}`,
    htm: 'POST',
    nonce,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    ...(token ? { ath: createHash('sha256').update(token).digest('base64url') } : {}),
  });
  const input = `${header}.${payload}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: createPrivateKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
export class SignetClient {
  constructor(
    private url: string,
    private credentialFile: string,
    private signetId: string,
  ) {
    this.url = kingdomUrl(url);
  }
  private async credentials(force = false, signal = requestSignal(), allowRenewal = true) {
    signal.throwIfAborted();
    const credential = signetCredentialSchema.parse(
      await abortable(readPrivateJson(this.credentialFile), signal),
    );
    signal.throwIfAborted();
    if (credential.url !== this.url || credential.signetId !== this.signetId)
      throw Error('Signet credential audience mismatch');
    if (Date.parse(credential.idleExpiresAt) <= Date.now())
      throw Error('Signet enrollment idle timeout; use signet reenroll with your Foundry identity');
    if (!allowRenewal) {
      if (Date.parse(credential.expiresAt) <= Date.now())
        throw Error('Task settlement requires an unexpired existing access token');
      return credential;
    }
    if (!force && Date.parse(credential.expiresAt) > Date.now() + 30000) return credential;
    if (Date.parse(credential.renewalExpiresAt) <= Date.now())
      throw Error('Signet enrollment expired; request renewed approval');
    const existing = refreshing.get(this.credentialFile);
    if (existing) return abortable(existing, signal);
    const refresh = (async () => {
      // Renewal belongs to the credential file, not the first waiting caller.
      const refreshSignal = requestSignal();
      const response = renewalResponseSchema.parse(
        await signetPost(
          this.url,
          'renewSignet',
          { renewalCredential: credential.renewalCredential },
          {
            DPoP: await signetProof(this.url, 'renewSignet', credential.keyFile, undefined, {
              signal: refreshSignal,
            }),
          },
          undefined,
          { signal: refreshSignal },
        ),
      );
      if (
        response.enrollmentId !== credential.enrollmentId ||
        response.lifecycle !== credential.lifecycle ||
        response.taskId !== credential.taskId
      )
        throw Error('Signet enrollment changed');
      const updated = signetCredentialSchema.parse({ ...credential, ...response });
      await writePrivateJson(this.credentialFile, updated);
      return updated;
    })();
    refreshing.set(this.credentialFile, refresh);
    const settled = refresh.finally(() => refreshing.delete(this.credentialFile));
    return abortable(settled, signal);
  }
  async renew(options: SignetRequestOptions = {}): Promise<void> {
    const signal = requestSignal(options.signal);
    await this.credentials(true, signal);
    signal.throwIfAborted();
  }
  async post(
    action:
      | 'describe'
      | 'execute'
      | 'closeTask'
      | 'runtimeJobStep'
      | 'verifyAuthority'
      | 'settleTask',
    body: unknown,
    onDispatch?: () => void,
    options: SignetRequestOptions = {},
  ) {
    if (
      ![
        'describe',
        'execute',
        'closeTask',
        'runtimeJobStep',
        'verifyAuthority',
        'settleTask',
      ].includes(action)
    )
      throw Error('Unsupported Signet action');
    const signal = requestSignal(options.signal);
    signal.throwIfAborted();
    const credential = await this.credentials(false, signal, action !== 'settleTask');
    signal.throwIfAborted();
    const proof = await signetProof(this.url, action, credential.keyFile, credential.accessToken, {
      signal,
    });
    signal.throwIfAborted();
    return signetPost(
      this.url,
      action,
      body,
      { authorization: `DPoP ${credential.accessToken}`, DPoP: proof },
      onDispatch,
      { signal },
    );
  }
}
