import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { kingdomUrl, ownerRefSchema } from './kingdom-client';
import { installationCredentialSchema, readPrivateJson } from './kingdom-credential-file';
import { RuntimeJobRegistry } from './runtime-job-handler';
import { RuntimeJobWorker } from './runtime-job-worker';

export const kingdomRuntimeSchema = z
  .object({
    url: z.string().transform(kingdomUrl),
    installationId: z.string().uuid(),
    credentialFile: z.string().refine(isAbsolute, 'Credential path must be absolute'),
  })
  .strict();
export type KingdomRuntimeSettings = z.input<typeof kingdomRuntimeSchema>;
const identitySchema = z.object({
  data: z.object({
    installationId: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    expiresAt: z.string().datetime(),
    owner: ownerRefSchema,
  }),
});

export class KingdomRuntimeConnection {
  private settings: z.output<typeof kingdomRuntimeSchema>;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private available = false;
  private jobs?: RuntimeJobWorker;
  constructor(
    settings: KingdomRuntimeSettings,
    private sessionCount: () => number,
    private transport: typeof fetch = fetch,
    private handlers: RuntimeJobRegistry = new RuntimeJobRegistry(),
  ) {
    this.settings = kingdomRuntimeSchema.parse(settings);
  }
  get connected() {
    return this.available;
  }
  check(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.heartbeat()
      .then(
        () => {
          this.available = true;
          void this.jobs?.check().catch(() => {});
        },
        () => {
          this.available = false;
          throw Error('Kingdom runtime unavailable; check enrollment, expiry and connection');
        },
      )
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  async start(): Promise<void> {
    this.jobs ??= new RuntimeJobWorker(this.settings, this.transport, this.handlers);
    if (!this.timer)
      this.timer = setInterval(() => {
        void this.check().catch(() => {});
      }, 15000);
    this.timer.unref();
    await this.check();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    this.jobs?.stop();
    this.available = false;
  }
  private async heartbeat(): Promise<void> {
    const { secret } = installationCredentialSchema.parse(
      await readPrivateJson(this.settings.credentialFile),
    );
    const response = await this.transport(`${this.settings.url}/api/v1/access/runtimeHeartbeat`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(
        Object.assign(
          { sessionCount: this.sessionCount() },
          ...this.handlers.all().map((handler) => handler.heartbeatBody?.() ?? {}),
        ),
      ),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('Runtime refused');
    }
    const { data } = identitySchema.parse(await response.json());
    for (const handler of this.handlers.all()) handler.verifyIdentity?.(data);
    if (
      data.installationId !== this.settings.installationId ||
      Date.parse(data.expiresAt) <= Date.now()
    )
      throw Error('Runtime identity mismatch');
  }
}
