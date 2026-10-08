import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readPrivateJson, SignetClient, signetCredentialSchema } from '@inixiative/signet';
import { z } from 'zod';

// Signets are requested and approved by a person in Kingdom; Kingdom grants them to this
// Foundry's integration and the Installation connection enrolls them. This CLI only acts on one held.
const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    credential: { type: 'string' },
    task: { type: 'string' },
    reason: { type: 'string', default: 'completed' },
  },
});
try {
  if (positionals[0] !== 'close') throw Error('Usage: signet close');
  if (!values.credential || !values.task)
    throw Error('Usage: signet close --credential FILE --task UUID [--reason completed|cancelled]');
  const path = resolve(values.credential),
    credential = signetCredentialSchema.parse(await readPrivateJson(path));
  const result = await new SignetClient(credential.url, path, credential.signetId).post(
    'closeTask',
    {
      signetId: credential.signetId,
      taskId: z.string().uuid().parse(values.task),
      reason: z.enum(['completed', 'cancelled']).parse(values.reason),
    },
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    error instanceof Error &&
      (error.message.startsWith('Usage:') || error.message.startsWith('Signet request refused'))
      ? error.message
      : 'Signet unavailable. Check the credential file and the task. No credentials were printed.',
  );
  process.exitCode = 1;
}
