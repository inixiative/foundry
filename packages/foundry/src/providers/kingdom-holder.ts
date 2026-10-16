import { SignetClient, SignetHttpError, signetCredentialFile } from '@inixiative/signet';
import { signetDescriptionSchema } from '@inixiative/signet/contracts';
import { z } from 'zod';
import {
  type KingdomIntegration,
  kingdomInstallationPaths,
  kingdomIntegrationId,
} from './kingdom-installation-connection';

const person = z.object({ id: z.string(), name: z.string().nullable(), email: z.string() });

/**
 * Who holds a paired Kingdom's Signet, from Kingdom's extended `access/describe`: the integration
 * this Foundry is, the owner it belongs to (an organization, a space or a person), who approved it,
 * and where to see and manage it in Kingdom. An older Kingdom sends no `holder`.
 */
export const signetHolderSchema = z.object({
  integration: z.object({ id: z.string(), name: z.string(), provider: z.string().nullable() }),
  owner: z.object({
    ownerModel: z.string(),
    name: z.string().nullable(),
    organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
    space: z.object({ id: z.string(), name: z.string() }).nullable(),
    user: person.nullable(),
  }),
  issuedBy: person.nullable(),
  webUrl: z.string().nullable(),
  manageUrl: z.string().nullable(),
});
export type SignetHolder = z.infer<typeof signetHolderSchema>;

/** `signetDescriptionSchema` strips unknown fields, so the published `describe()` drops `holder`. */
export const heldSignetDescriptionSchema = signetDescriptionSchema.extend({
  holder: signetHolderSchema.nullish(),
});

export interface HolderView {
  /** `described`: Kingdom answered; `revoked`: Kingdom refused the Signet (403); `unavailable`: no answer. */
  status: 'described' | 'revoked' | 'unavailable';
  holder: SignetHolder | null;
  checkedAt: number;
}

type Describe = (credentialFile: string, url: string, signetId: string) => Promise<unknown>;

const describeWithSignet: Describe = async (credentialFile, url, signetId) =>
  new SignetClient(url, credentialFile, signetId).post('describe', { signetId }, undefined, {
    timeoutMs: 5_000,
  });

/**
 * Holder descriptions per paired Kingdom, cached: read at most once per `ttlMs`, again after the
 * Installation socket reports a change (`stale()`), and shared by concurrent readers.
 */
export class KingdomHolders {
  private cache = new Map<string, { view: HolderView; stale: boolean }>();
  private inflight = new Map<string, Promise<HolderView>>();
  private readonly ttlMs: number;
  private readonly describe: Describe;
  constructor(
    private configDir: string,
    options: { ttlMs?: number; describe?: Describe } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.describe = options.describe ?? describeWithSignet;
  }

  /** The Installation snapshot changed: what Kingdom holds may have too. */
  stale() {
    for (const entry of this.cache.values()) entry.stale = true;
  }

  forget(id: string) {
    this.cache.delete(id);
  }

  /** The cached view when fresh; otherwise a new read, waiting at most `waitMs` before answering with the last one. */
  async get(integration: KingdomIntegration, waitMs = 3_000): Promise<HolderView> {
    const id = kingdomIntegrationId(integration);
    const cached = this.cache.get(id);
    if (cached && !cached.stale && Date.now() - cached.view.checkedAt < this.ttlMs)
      return cached.view;
    let read = this.inflight.get(id);
    if (!read) {
      read = this.read(integration).then((view) => {
        this.cache.set(id, { view, stale: false });
        return view;
      });
      read.finally(() => this.inflight.delete(id)).catch(() => {});
      this.inflight.set(id, read);
    }
    const fallback: HolderView = cached?.view ?? {
      status: 'unavailable',
      holder: null,
      checkedAt: Date.now(),
    };
    return Promise.race([read, Bun.sleep(waitMs).then(() => fallback)]);
  }

  private async read(integration: KingdomIntegration): Promise<HolderView> {
    const checkedAt = Date.now();
    const file = signetCredentialFile(
      kingdomInstallationPaths(this.configDir, integration.url).directory,
      integration.signetId,
    );
    try {
      const described = heldSignetDescriptionSchema.parse(
        await this.describe(file, integration.url, integration.signetId),
      );
      return { status: 'described', holder: described.holder ?? null, checkedAt };
    } catch (error) {
      if (error instanceof SignetHttpError && error.status === 403)
        return { status: 'revoked', holder: null, checkedAt };
      return { status: 'unavailable', holder: null, checkedAt };
    }
  }
}
