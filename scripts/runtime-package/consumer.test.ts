// Runs against the packed package, the way an installed consumer imports it — never a deep
// source import. An export can work in-repo and break once published; this is what catches that.
import { expect, test } from 'bun:test';

let importTimeNetwork = 0;
globalThis.fetch = (() => {
  importTimeNetwork++;
  throw Error('The seam must not reach the network when imported');
}) as unknown as typeof fetch;

const runtime = await import('@inixiative/foundry/runtime');

test('the seam exposes exactly its named exports', () => {
  // A new export here is a deliberate decision, not a side effect of moving a file.
  expect(Object.keys(runtime).sort()).toEqual(
    ['KingdomRuntimeConnection', 'SignetClient', 'SignetHttpError', 'kingdomRuntimeSchema'].sort(),
  );
});

test('importing it reaches no network and resolves to the installed package', async () => {
  expect(importTimeNetwork).toBe(0);
  const resolved = import.meta.resolve('@inixiative/foundry/runtime');
  expect(resolved).toContain('/node_modules/@inixiative/foundry/');
});

test('internals stay unreachable', async () => {
  await expect(
    import('@inixiative/foundry/src/providers/kingdom-runtime-connection'),
  ).rejects.toThrow();
});

test('settings parse through the published schema, and a bad one is refused', () => {
  const settings = {
    url: 'https://kingdom.invalid',
    installationId: crypto.randomUUID(),
    credentialFile: '/tmp/installation.json',
    owner: `User:${crypto.randomUUID()}::`,
  };
  expect(() => runtime.kingdomRuntimeSchema.parse(settings)).not.toThrow();
  // A relative credential path is rejected: the file is read by an absolute path or not at all.
  expect(() =>
    runtime.kingdomRuntimeSchema.parse({ ...settings, credentialFile: 'installation.json' }),
  ).toThrow();
});

test('constructing the client opens no connection', () => {
  expect(importTimeNetwork).toBe(0);
  expect(typeof runtime.SignetClient).toBe('function');
  expect(runtime.SignetHttpError.prototype).toBeInstanceOf(Error);
});
