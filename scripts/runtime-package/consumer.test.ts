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
    [
      'KingdomInstallationConnection',
      'SignetClient',
      'SignetHttpError',
      'kingdomIntegrationSchema',
    ].sort(),
  );
});

test('importing it reaches no network and resolves to the installed package', async () => {
  expect(importTimeNetwork).toBe(0);
  const resolved = import.meta.resolve('@inixiative/foundry/runtime');
  expect(resolved).toContain('/node_modules/@inixiative/foundry/');
});

test('internals stay unreachable', async () => {
  await expect(
    import('@inixiative/foundry/src/providers/kingdom-installation-connection'),
  ).rejects.toThrow();
});

test('settings parse through the published schema, and a bad one is refused', () => {
  const settings = {
    url: 'https://kingdom.invalid',
    integrationId: crypto.randomUUID(),
    owner: `User:${crypto.randomUUID()}::`,
    signetId: crypto.randomUUID(),
  };
  expect(() => runtime.kingdomIntegrationSchema.parse(settings)).not.toThrow();
  // The owner is Kingdom's owner key and the Signet a uuid; anything else is refused.
  expect(() =>
    runtime.kingdomIntegrationSchema.parse({ ...settings, owner: { ownerModel: 'User' } }),
  ).toThrow();
  expect(() =>
    runtime.kingdomIntegrationSchema.parse({ ...settings, signetId: 'signet.json' }),
  ).toThrow();
});

test('constructing the client opens no connection', () => {
  expect(importTimeNetwork).toBe(0);
  expect(typeof runtime.SignetClient).toBe('function');
  expect(runtime.SignetHttpError.prototype).toBeInstanceOf(Error);
});
