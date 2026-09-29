import { destinationUrl } from '@inixiative/session-archive/config';
export { destinationUrl } from '@inixiative/session-archive/config';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { credentialReferenceSchema } from '../providers/credentials';

const common = {
  projectId: z.string().min(1).max(256),
  url: z.url(),
  tokenEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]+$/)
    .optional(),
  credential: credentialReferenceSchema.optional(),
};
/** Kingdom derives the owner from the runtime credential; these narrow it to a space or organization it manages. */
export const kingdomOwnerFields = {
  ownerModel: z.enum(['User', 'OrganizationUser', 'Organization', 'Space', 'SpaceUser']).optional(),
  organizationId: z.uuid().optional(),
  spaceId: z.uuid().optional(),
};
export const archiveDestinationSchema = z
  .union([
    z.strictObject({
      ...common,
      kind: z.literal('archive'),
      keepIds: z.array(z.string()).max(0).optional(),
    }),
    z.strictObject({
      ...common,
      kind: z.literal('kingdom'),
      /** A hosted Archive that Kingdom forwards to; omitted, Kingdom stores the archive itself. */
      connectionId: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .max(120)
        .optional(),
      ...kingdomOwnerFields,
    }),
  ])
  .superRefine((value, ctx) => {
    if (Boolean(value.tokenEnv) === Boolean(value.credential))
      ctx.addIssue({ code: 'custom', message: 'Choose exactly one credential source' });
    if (value.kind === 'archive' && value.credential?.type === 'kingdom-runtime')
      ctx.addIssue({ code: 'custom', message: 'Runtime credentials require a Kingdom destination' });
  });
export type ArchiveDestination = z.infer<typeof archiveDestinationSchema>;

export function readDestinations(file: string): ArchiveDestination[] {
  return existsSync(file)
    ? z
        .array(archiveDestinationSchema)
        .max(100)
        .parse(JSON.parse(readFileSync(file, 'utf8')))
    : [];
}
export function destinationIdentity(destination: ArchiveDestination) {
  const url = destinationUrl(destination.url);
  // Standalone receipts keep their earlier identity.
  return JSON.stringify([
    url.origin,
    new URL(destination.url).pathname,
    destination.kind === 'archive'
      ? 'standalone'
      : [
          destination.connectionId ?? 'kingdom',
          destination.ownerModel ?? null,
          destination.organizationId ?? null,
          destination.spaceId ?? null,
        ],
  ]);
}
export function connectDestination(file: string, input: unknown) {
  const destination = archiveDestinationSchema.parse(input);
  destination.url = destinationUrl(destination.url).href;
  const destinations = readDestinations(file);
  const identity = destinationIdentity(destination);
  const index = destinations.findIndex(
    (item) => item.projectId === destination.projectId && destinationIdentity(item) === identity,
  );
  if (index < 0) destinations.push(destination);
  else destinations[index] = destination;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(destinations, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  chmodSync(file, 0o600);
  return {
    configured: true,
    kind: destination.kind,
    projectId: destination.projectId,
    url: destination.url,
    tokenEnv: destination.tokenEnv,
    credential: destination.credential,
  };
}
