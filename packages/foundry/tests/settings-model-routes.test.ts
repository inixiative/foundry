import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { SignetHttpError } from '@inixiative/signet';
import { KingdomHolders } from '../src/providers/kingdom-holder';
import { ConfigStore, defaultConfig } from '../src/viewer/config';
import { createViewer } from '../src/viewer/server';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

async function viewer() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-settings-model-routes-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const configStore = new ConfigStore(dir);
  await configStore.save(defaultConfig());
  const app = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    configStore,
    localStore: null,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { call, configStore };
}

test('the default and decision models are single validated choices', async () => {
  const { call, configStore } = await viewer();
  expect((await call('GET', '/api/models/selection')).body).toMatchObject({
    apiTokens: false,
    default: { provider: 'claude-code', model: 'fable' },
    decision: { provider: 'claude-code', model: 'claude-haiku-5-5' },
    decisionRoles: [],
  });

  // A subscription model runs decisions on its runtime's login.
  const codex = await call('POST', '/api/models/decision', {
    provider: 'codex',
    model: 'gpt-5.6-luna',
  });
  expect(codex.status).toBe(200);
  expect(codex.body.decision).toEqual({ provider: 'codex', model: 'gpt-5.6-luna' });
  expect(configStore.config.subscriptionOnly).toMatchObject({
    decisionRuntime: 'codex',
    model: 'gpt-5.6-luna',
  });

  // An API model runs decisions only with API keys on; refused, nothing changes.
  const api = await call('POST', '/api/models/decision', {
    provider: 'openai',
    model: 'gpt-6-luna',
  });
  expect(api.status).toBe(400);
  expect(api.body.error).toContain('turn on API keys');
  expect(configStore.config.subscriptionOnly?.model).toBe('gpt-5.6-luna');

  // Subscription mode keeps every main thread on its subscription worker.
  const refused = await call('POST', '/api/models/default', {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
  });
  expect(refused.status).toBe(400);
  expect(configStore.config.defaults.provider).toBe('claude-code');
  expect(
    (await call('POST', '/api/models/default', { provider: 'claude-code', model: 'nope' })).status,
  ).toBe(400);
  const opus = await call('POST', '/api/models/default', {
    provider: 'claude-code',
    model: 'opus',
  });
  expect(opus.body.default).toEqual({ provider: 'claude-code', model: 'opus' });
});

test('the profile name, vendors and the automatic tunnel are settings edits', async () => {
  const { call, configStore } = await viewer();
  const profile = await call('GET', '/api/profile');
  expect(profile.body).toMatchObject({ custom: false });
  expect(profile.body.installationName).toBe(profile.body.defaultName);
  expect(
    (await call('PATCH', '/api/settings/profile', { installationName: 'Studio' })).status,
  ).toBe(200);
  expect((await call('GET', '/api/profile')).body).toMatchObject({
    installationName: 'Studio',
    custom: true,
  });
  expect(
    (await call('PATCH', '/api/settings/profile', { installationName: 'x'.repeat(121) })).status,
  ).toBe(400);
  await call('PATCH', '/api/settings/profile', { installationName: null });
  expect(configStore.config.installationName).toBeUndefined();

  // Vendor patches merge mode by mode; a null clears an API root override.
  await call('PATCH', '/api/settings/vendors', {
    openai: { api: { baseUrl: 'https://proxy.test/v1' } },
  });
  expect(configStore.config.vendors.openai).toEqual({
    enabled: true,
    subscription: { enabled: true },
    api: { enabled: true, baseUrl: 'https://proxy.test/v1' },
  });
  await call('PATCH', '/api/settings/vendors', { openai: { api: { baseUrl: null } } });
  expect(configStore.config.vendors.openai!.api).toEqual({ enabled: true });
  const soon = await call('PATCH', '/api/settings/vendors', {
    google: { subscription: { enabled: true } },
  });
  expect(soon.status).toBe(400);
  expect(soon.body.error).toContain('coming soon');

  // The tunnel is automatic until someone chooses; saving its provider keeps it automatic.
  expect((await call('GET', '/api/tunnel')).body).toMatchObject({
    mode: 'auto',
    active: false,
    kingdomConnected: false,
  });
  await call('PATCH', '/api/tunnel', { provider: 'cloudflared' });
  expect((await call('GET', '/api/tunnel')).body).toMatchObject({
    mode: 'auto',
    provider: 'cloudflared',
  });
  const accounts = await call('GET', '/api/providers/accounts?all=1');
  expect(accounts.body.map((a: { provider: string }) => a.provider)).toContain('gemini');
});

test('Kingdom holders are read once, again after the Installation changes, and a 403 is revoked', async () => {
  let calls = 0;
  let refuse = false;
  const integration = {
    url: 'https://api.kingdom.test',
    integrationId: crypto.randomUUID(),
    owner: `Organization::${crypto.randomUUID()}:`,
    signetId: crypto.randomUUID(),
  };
  const holder = {
    integration: { id: integration.integrationId, name: 'Studio', provider: null },
    owner: {
      ownerModel: 'Organization',
      name: 'Acme',
      organization: { id: crypto.randomUUID(), name: 'Acme', slug: 'acme' },
      space: null,
      user: null,
    },
    issuedBy: { id: crypto.randomUUID(), name: null, email: 'grace@acme.test' },
    webUrl: 'https://kingdom.acme.test',
    manageUrl: `https://kingdom.acme.test/dashboard?integration=${integration.integrationId}`,
  };
  const holders = new KingdomHolders('/nowhere', {
    describe: async () => {
      calls++;
      if (refuse) throw new SignetHttpError(403);
      return {
        signetId: integration.signetId,
        integrationId: integration.integrationId,
        provider: null,
        name: 'Studio',
        expiresAt: null,
        lifecycle: 'ongoing',
        taskId: null,
        currentRevision: 1,
        remainingRequests: null,
        operations: [],
        holder,
      };
    },
  });
  expect(await holders.get(integration)).toMatchObject({ status: 'described', holder });
  await holders.get(integration);
  expect(calls).toBe(1);
  holders.stale();
  refuse = true;
  expect(await holders.get(integration)).toMatchObject({ status: 'revoked', holder: null });
  expect(calls).toBe(2);
});
