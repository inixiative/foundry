import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  CredentialReference,
  CredentialResolver,
  CredentialScope,
} from '@inixiative/foundry-core';
import { destinationUrl } from '@inixiative/session-archive/config';
import { z } from 'zod';
import { ownerKey, ownerKeySchema } from './kingdom-client';
import {
  installationCredentialSchema,
  readPrivateJson,
  writePrivateJson,
} from './kingdom-credential-file';
import {
  type KingdomRuntimeSettings,
  kingdomRuntimeId,
  kingdomRuntimeSchema,
  readRuntimeIdentity,
  selectKingdomRuntime,
} from './kingdom-runtime-connection';

export const credentialReferenceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('managed'), id: z.uuid() }),
  z.strictObject({ type: z.literal('kingdom-runtime'), owner: ownerKeySchema }),
]);
const scopeSchema = z.strictObject({
  service: z.string().min(1),
  url: z.string(),
  projectId: z.string().min(1),
});
const recordSchema = z.strictObject({
  scope: scopeSchema,
  secret: z.string().min(1).max(16384).regex(/^\S+$/),
});
const normalize = (scope: CredentialScope) => ({ ...scope, url: destinationUrl(scope.url).href });

/** Shares native authentication's private-file custody and reads rotation on every use. */
export class FoundryCredentials implements CredentialResolver {
  private directory: string;
  constructor(
    configDir = process.env.FOUNDRY_CONFIG_DIR ?? '.foundry',
    private runtimes?: () =>
      | KingdomRuntimeSettings[]
      | undefined
      | Promise<KingdomRuntimeSettings[] | undefined>,
  ) {
    this.directory = join(resolve(configDir), 'credentials');
  }
  async save(scope: CredentialScope, secret: string): Promise<CredentialReference> {
    const record = recordSchema.parse({ scope: normalize(scope), secret });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = crypto.randomUUID();
    await writePrivateJson(join(this.directory, `${id}.json`), record);
    return { type: 'managed', id };
  }
  async remove(reference: CredentialReference): Promise<void> {
    const parsed = credentialReferenceSchema.parse(reference);
    if (parsed.type === 'managed') await unlink(join(this.directory, `${parsed.id}.json`));
  }
  /** The paired Kingdom a selector names (id or API origin; the only one when omitted), checked with one heartbeat. */
  async kingdomIdentity(selector?: string, transport: typeof fetch = fetch, sessionCount = 0) {
    const runtime = kingdomRuntimeSchema.parse(
      selectKingdomRuntime(await this.runtimes?.(), selector),
    );
    const identity = await readRuntimeIdentity(runtime, { transport, sessionCount }).catch(() => {
      throw Error('Kingdom enrollment unavailable');
    });
    if (ownerKey(identity.owner) !== runtime.owner) throw Error('Kingdom identity mismatch');
    return { id: kingdomRuntimeId(runtime), url: runtime.url, owner: runtime.owner };
  }
  async resolve(reference: CredentialReference, scope: CredentialScope): Promise<string> {
    const parsed = credentialReferenceSchema.parse(reference),
      requested = normalize(scope);
    if (parsed.type === 'managed') {
      const record = recordSchema.parse(
        await readPrivateJson(join(this.directory, `${parsed.id}.json`)),
      );
      if (
        record.scope.service !== requested.service ||
        record.scope.url !== requested.url ||
        record.scope.projectId !== requested.projectId
      )
        throw Error('Credential is outside the requested scope');
      return record.secret;
    }
    const settings = (await this.runtimes?.())?.find(
      (runtime) =>
        runtime.owner === parsed.owner && destinationUrl(runtime.url).href === requested.url,
    );
    if (requested.service !== 'archive' || !settings)
      throw Error('Kingdom credential is outside the requested scope');
    // Kingdom checks current installation expiry, revocation and owner authority on every request.
    return installationCredentialSchema.parse(await readPrivateJson(settings.credentialFile))
      .secret;
  }
}
