import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { kingdomUrl, readPrivateJson } from '@inixiative/signet';
import { z } from 'zod';
import { ownerKey, ownerKeySchema, ownerRefSchema } from './kingdom-client';
import { installationCredentialSchema } from './kingdom-credential-file';

/** An installation credential before Kingdom has named its owner (pairing, manual enrollment). */
export const kingdomInstallationSchema = z
  .object({
    url: z.string().transform(kingdomUrl),
    installationId: z.string().uuid(),
    credentialFile: z.string().refine(isAbsolute, 'Credential path must be absolute'),
  })
  .strict();
export type KingdomInstallation = z.input<typeof kingdomInstallationSchema>;

/** One paired Kingdom: the installation plus the owner Kingdom approved it for. */
export const kingdomRuntimeSchema = kingdomInstallationSchema
  .extend({ owner: ownerKeySchema })
  .strict();
export type KingdomRuntimeSettings = z.input<typeof kingdomRuntimeSchema>;

/** Stable id of a paired Kingdom, derived from its natural key (API origin + owner); survives re-pairing. */
export const kingdomRuntimeId = (runtime: { url: string; owner: string }) =>
  createHash('sha256')
    .update(`${kingdomUrl(runtime.url)} ${runtime.owner}`)
    .digest('hex')
    .slice(0, 12);

/** Every paired Kingdom, at most once per Kingdom + owner and once per installation. */
export const kingdomRuntimesSchema = z
  .array(kingdomRuntimeSchema)
  .superRefine((runtimes, context) => {
    const ids = runtimes.map(kingdomRuntimeId),
      installations = runtimes.map((runtime) => runtime.installationId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        message:
          'Each Kingdom owner may be paired once; pair again with --replace instead of adding a second runtime',
      });
    if (new Set(installations).size !== installations.length)
      context.addIssue({ code: 'custom', message: 'Each Kingdom installation may be paired once' });
  });

/** Operator-facing: names the paired Kingdoms to choose from; safe to print. */
export class KingdomSelectionError extends Error {}

/** The paired Kingdom a selector names: its id or its API origin; without a selector, the only one paired. */
export function selectKingdomRuntime<T extends { url: string; owner: string }>(
  runtimes: readonly T[] | undefined,
  selector?: string,
): T {
  const origin = (() => {
    try {
      return selector ? kingdomUrl(selector) : undefined;
    } catch {
      return undefined;
    }
  })();
  const candidates = (runtimes ?? []).filter(
    (runtime) =>
      !selector || kingdomRuntimeId(runtime) === selector || kingdomUrl(runtime.url) === origin,
  );
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length)
    throw new KingdomSelectionError(
      selector
        ? `No paired Kingdom matches ${selector}. Run bun run kingdom status to list them.`
        : 'Pair this Foundry with Kingdom first: bun run kingdom pair',
    );
  throw new KingdomSelectionError(
    `Several Kingdoms are paired${selector ? ` at ${selector}` : ''}; choose one with --kingdom ID (bun run kingdom status lists them).`,
  );
}

/** Kingdom's owner reference: the model plus whichever ids identify it. */
export type RuntimeOwner = {
  ownerModel: string;
  userId?: string | null;
  organizationId?: string | null;
  spaceId?: string | null;
};
/** Enrolled runtime identity returned by `runtimeHeartbeat`. */
export type RuntimeIdentity = {
  installationId: string;
  userId: string | null;
  owner: RuntimeOwner;
  expiresAt: string;
};

const identitySchema = z.object({
  data: z.object({
    installationId: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    expiresAt: z.string().datetime(),
    owner: ownerRefSchema,
  }),
});

/** One heartbeat with the installation credential; resolves to Kingdom's current identity for it. */
export async function readRuntimeIdentity(
  installation: KingdomInstallation,
  options: {
    transport?: typeof fetch;
    sessionCount?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RuntimeIdentity> {
  const { url, installationId, credentialFile } = installation;
  const settings = kingdomInstallationSchema.parse({ url, installationId, credentialFile });
  const { secret } = installationCredentialSchema.parse(
    await readPrivateJson(settings.credentialFile),
  );
  const response = await (options.transport ?? fetch)(
    `${settings.url}/api/v1/access/runtimeHeartbeat`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(5000),
      ]),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ sessionCount: options.sessionCount ?? 0 }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw Error('Runtime refused');
  }
  const { data } = identitySchema.parse(await response.json());
  if (data.installationId !== settings.installationId || Date.parse(data.expiresAt) <= Date.now())
    throw Error('Runtime identity mismatch');
  return data;
}

export class KingdomRuntimeConnection {
  private settings: z.output<typeof kingdomRuntimeSchema>;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private available = false;
  constructor(
    settings: KingdomRuntimeSettings,
    private sessionCount: () => number,
    private transport: typeof fetch = fetch,
  ) {
    this.settings = kingdomRuntimeSchema.parse(settings);
  }
  get connected() {
    return this.available;
  }
  get runtime(): Readonly<z.output<typeof kingdomRuntimeSchema>> {
    return this.settings;
  }
  get id() {
    return kingdomRuntimeId(this.settings);
  }
  check(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.heartbeat()
      .then(
        () => {
          this.available = true;
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
    this.available = false;
  }
  private async heartbeat(): Promise<void> {
    const identity = await readRuntimeIdentity(this.settings, {
      transport: this.transport,
      sessionCount: this.sessionCount(),
      signal: this.controller.signal,
    });
    if (ownerKey(identity.owner) !== this.settings.owner) throw Error('Runtime owner changed');
  }
}
