import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { CredentialReference, CredentialResolver, CredentialScope } from '@inixiative/foundry-core';
import { destinationUrl } from '@inixiative/session-archive/config';
import { installationCredentialSchema, readPrivateJson, writePrivateJson } from './kastle-credential-file';
import { kingdomRuntimeSchema, type KingdomRuntimeSettings } from './kingdom-runtime-connection';

export const credentialReferenceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('managed'), id: z.uuid() }),
  z.strictObject({ type: z.literal('kingdom-runtime') }),
]);
const scopeSchema = z.strictObject({
  service: z.string().min(1),
  url: z.string(),
  projectId: z.string().min(1),
  kastleId: z.uuid().optional(),
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
    private runtime?: () => KingdomRuntimeSettings | undefined | Promise<KingdomRuntimeSettings | undefined>,
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
  async kingdomIdentity(transport: typeof fetch = fetch, sessionCount = 0) {
    const settings = kingdomRuntimeSchema.parse(await this.runtime?.());
    const { secret } = installationCredentialSchema.parse(await readPrivateJson(settings.credentialFile));
    const response = await transport(`${settings.url}/api/v1/access/runtimeHeartbeat`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionCount }),
    });
    if (!response.ok) throw Error('Kingdom enrollment unavailable');
    const { data } = z
      .object({
        data: z.object({ installationId: z.uuid(), kastleId: z.uuid(), expiresAt: z.iso.datetime() }),
      })
      .parse(await response.json());
    if (data.installationId !== settings.installationId || Date.parse(data.expiresAt) <= Date.now())
      throw Error('Kingdom identity mismatch');
    return { url: settings.url, kastleId: data.kastleId };
  }
  async resolve(reference: CredentialReference, scope: CredentialScope): Promise<string> {
    const parsed = credentialReferenceSchema.parse(reference),
      requested = normalize(scope);
    if (parsed.type === 'managed') {
      const record = recordSchema.parse(await readPrivateJson(join(this.directory, `${parsed.id}.json`)));
      if (
        record.scope.service !== requested.service ||
        record.scope.url !== requested.url ||
        record.scope.projectId !== requested.projectId ||
        record.scope.kastleId !== requested.kastleId
      )
        throw Error('Credential is outside the requested scope');
      return record.secret;
    }
    const settings = kingdomRuntimeSchema.parse(await this.runtime?.());
    if (
      requested.service !== 'archive' ||
      !requested.kastleId ||
      destinationUrl(settings.url).href !== requested.url
    )
      throw Error('Kingdom credential is outside the requested scope');
    // Kingdom checks current installation expiry, revocation and Kastle membership on every request.
    return installationCredentialSchema.parse(await readPrivateJson(settings.credentialFile)).secret;
  }
}
