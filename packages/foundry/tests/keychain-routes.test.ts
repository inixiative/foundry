import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Keychain, memoryKeychainBackend } from '../src/secrets/keychain';
import { registerKeychainRoutes } from '../src/viewer/routes/keychain';

const VALUE = 'correct horse battery staple';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('the owner stores, re-holds and removes entries; no response carries a value', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'foundry-keychain-routes-'));
  dirs.push(configDir);
  const keychain = new Keychain({ configDir, backend: memoryKeychainBackend() });
  const app = new Hono();
  registerKeychainRoutes(app, keychain);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const text = await response.text();
    expect(text).not.toContain(VALUE);
    return { status: response.status, json: JSON.parse(text) };
  };
  expect((await call('PUT', '/api/keychain/site', { value: VALUE })).status).toBe(200);
  expect((await call('PUT', '/api/keychain/site', { value: VALUE })).status).toBe(400);
  expect((await call('PUT', '/api/keychain/site', { value: '' })).status).toBe(400);
  expect((await call('PUT', '/api/keychain/-bad', { value: VALUE })).status).toBe(400);
  const held = await call('POST', '/api/keychain/site/holder', { holder: 'mcp:linear' });
  expect(held.json.entry.holder).toBe('mcp:linear');
  expect((await call('POST', '/api/keychain/site/holder', { holder: 'nobody' })).status).toBe(400);
  const listed = await call('GET', '/api/keychain');
  expect(listed.json.entries.map((entry: { name: string }) => entry.name)).toEqual(['site']);
  expect((await call('DELETE', '/api/keychain/site')).status).toBe(200);
  expect((await call('DELETE', '/api/keychain/site')).status).toBe(404);
  expect(await keychain.read('site', 'mcp:linear').catch((error) => error.message)).toContain(
    'not in the keychain',
  );
});
