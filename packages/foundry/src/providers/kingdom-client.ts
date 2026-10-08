import { kingdomUrl } from '@inixiative/signet';
import { z } from 'zod';
import { refreshSecretPattern, runSecretPattern } from './kingdom-secrets';

export const kingdomSelectionSchema = z
  .object({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    poolId: z.string().uuid().optional(),
    capacityIds: z.array(z.string().uuid()).optional(),
    integrationIds: z.array(z.string().uuid()).optional(),
    category: z.string().optional(),
    projectId: z.string().uuid().optional(),
    tagIds: z.array(z.string().uuid()).optional(),
    inferredTags: z.array(z.string()).optional(),
  })
  .strict();
const ownerId = z.string().uuid().nullable().optional();
/** Kingdom's owner reference: the model plus whichever ids identify it. */
export const ownerRefSchema = z.object({
  ownerModel: z.string(),
  userId: ownerId,
  organizationId: ownerId,
  spaceId: ownerId,
});
export type OwnerRef = z.infer<typeof ownerRefSchema>;
/** Kingdom's canonical owner key: `ownerModel:userId:organizationId:spaceId`, absent ids empty. */
export const ownerKey = (owner: OwnerRef) =>
  [owner.ownerModel, owner.userId ?? '', owner.organizationId ?? '', owner.spaceId ?? ''].join(':');
const uuidOrEmpty =
  '(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?';
export const ownerKeySchema = z
  .string()
  .regex(
    new RegExp(`^(?:User|OrganizationUser|Organization|Space|SpaceUser)(?::${uuidOrEmpty}){3}$`),
  );
export const kingdomEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    owner: ownerRefSchema,
    installationId: z.string().uuid(),
    runId: z.string().uuid(),
    integrationId: z.string().uuid(),
    capacityId: z.string().uuid(),
    model: z.string(),
    effort: z.string(),
    runtime: z.enum(['claude', 'codex']),
    expiresAt: z.string().datetime(),
    gatewayPath: z.string(),
  })
  .strict();
export type KingdomSelection = z.infer<typeof kingdomSelectionSchema>;
export type KingdomRunEnvelope = z.infer<typeof kingdomEnvelopeSchema>;
export class KingdomClient {
  readonly origin: string;
  constructor(
    origin: string,
    private credential: string,
  ) {
    this.origin = kingdomUrl(origin);
  }
  private async post(action: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.origin}/api/v1/access/${action}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.credential}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Kingdom ${action} failed (${response.status})`);
    }
    const result = z.object({ data: z.unknown() }).parse(await response.json());
    return result.data;
  }
  async resolve(
    runId: string,
    selection: KingdomSelection,
    spreadId?: string,
  ): Promise<KingdomRunEnvelope> {
    const run = kingdomEnvelopeSchema.parse(
      await this.post('resolveRun', {
        runId,
        selection: kingdomSelectionSchema.parse(selection),
        ...(spreadId ? { spreadId } : {}),
      }),
    );
    const expected = `/api/v1/access/gateway/${run.id}${run.runtime === 'codex' ? '/v1' : ''}`;
    if (run.gatewayPath !== expected || run.runId !== runId)
      throw Error('Kingdom returned a mismatched run binding');
    return run;
  }
  async delegate(bindingId: string) {
    return z
      .object({ secret: z.string().regex(refreshSecretPattern), expiresAt: z.string().datetime() })
      .parse(await this.post('delegateRun', { bindingId }));
  }
  async refresh(bindingId: string) {
    return z
      .object({
        id: z.string().uuid(),
        secret: z.string().regex(runSecretPattern),
        expiresAt: z.string().datetime(),
      })
      .parse(await this.post('refreshRun', { bindingId }));
  }
  async revoke(bindingId: string) {
    await this.post('revokeRun', { bindingId });
  }
}
