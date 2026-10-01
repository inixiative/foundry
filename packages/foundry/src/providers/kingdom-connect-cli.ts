import { lstat, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigStore } from '../viewer/config';
import { ownerKey } from './kingdom-client';
import {
  installationCredentialSchema,
  readPrivateJson,
  writePrivateJson,
} from './kingdom-credential-file';
import { saveKingdomRuntime } from './kingdom-pairing';
import {
  kingdomInstallationSchema,
  kingdomRuntimeId,
  readRuntimeIdentity,
} from './kingdom-runtime-connection';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: 'string' },
    'installation-id': { type: 'string' },
    'credential-file': { type: 'string' },
    'config-dir': { type: 'string', default: '.foundry' },
  },
  strict: true,
});
if (!values.url || !values['installation-id'] || !values['credential-file'])
  throw Error(
    'Usage: bun scripts/connect-kingdom.ts --url KINGDOM_API_ORIGIN --installation-id UUID --credential-file PRIVATE_FILE [--config-dir DIR]',
  );
const directory = resolve(values['config-dir']!);
const installation = kingdomInstallationSchema.parse({
  url: values.url,
  installationId: values['installation-id'],
  credentialFile: resolve(values['credential-file']),
});
const identity = await readRuntimeIdentity(installation);
await mkdir(directory, { recursive: true, mode: 0o700 });
const stat = await lstat(directory);
if (
  !stat.isDirectory() ||
  stat.isSymbolicLink() ||
  (stat.mode & 0o077) !== 0 ||
  (process.getuid && stat.uid !== process.getuid())
)
  throw Error('Foundry configuration directory must be owned and private (0700)');
const secret = installationCredentialSchema.parse(
  await readPrivateJson(installation.credentialFile),
);
const privatePath = join(directory, `kingdom-runtime-${installation.installationId}.json`);
await writePrivateJson(privatePath, secret);
const store = new ConfigStore(directory),
  runtime = { ...installation, credentialFile: privatePath, owner: ownerKey(identity.owner) };
// Re-running for the same installation refreshes it; any other runtime for this Kingdom + owner needs --replace pairing.
const current = (await store.load()).kingdomRuntimes?.find(
  (item) => item.installationId === installation.installationId,
);
const refresh = !!current && kingdomRuntimeId(current) === kingdomRuntimeId(runtime);
try {
  const { id } = await saveKingdomRuntime(store, runtime, refresh);
  console.log(
    JSON.stringify({
      connected: true,
      id,
      installationId: installation.installationId,
      configDirectory: directory,
      restartViewer: true,
    }),
  );
} catch (error) {
  if (current?.credentialFile !== privatePath) await unlink(privatePath).catch(() => {});
  throw error;
}
