import { kingdomUrl } from '@inixiative/signet';
import { z } from 'zod';
import { refreshSecretPattern, runSecretPattern } from './kingdom-secrets';

export const runCredentialSchema = z
  .object({
    url: z.string().transform(kingdomUrl),
    bindingId: z.string().uuid(),
    refreshCredential: z.string().regex(refreshSecretPattern),
    expiresAt: z.string().datetime(),
    cachedToken: z
      .object({ secret: z.string().regex(runSecretPattern), expiresAt: z.string().datetime() })
      .optional(),
  })
  .strict();
