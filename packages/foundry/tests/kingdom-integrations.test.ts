import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installationDirectory } from '@inixiative/signet';
import {
  KingdomInstallationConnections,
  type KingdomIntegration,
  kingdomInstallationPaths,
  kingdomInstallationRoot,
  kingdomIntegrationId,
  selectKingdomIntegration,
} from '../src/providers/kingdom-installation-connection';
import { pairKingdomIntegration } from '../src/providers/kingdom-pairing';
import { ConfigStore, defaultConfig, validateConfig } from '../src/viewer/config';
import { mockKingdom, organizationOwner, userOwner } from './helpers/kingdom-installation';

const organization = 'Organization::11111111-1111-4111-8111-111111111111:';
const user = 'User:22222222-2222-4222-8222-222222222222::';
const integration = (url: string, owner: string): KingdomIntegration => ({
  url,
  owner,
  integrationId: crypto.randomUUID(),
  signetId: crypto.randomUUID(),
});

test('settings hold one integration per Kingdom + owner; duplicates and malformed entries are invalid', () => {
  const valid = defaultConfig();
  valid.kingdomIntegrations = [
    integration('https://a.example', organization),
    integration('https://a.example', user),
    integration('https://b.example', organization),
  ];
  expect(() => validateConfig(valid)).not.toThrow();
  expect(new Set(valid.kingdomIntegrations.map(kingdomIntegrationId)).size).toBe(3);
  expect(kingdomIntegrationId({ url: 'https://a.example/', owner: organization })).toBe(
    kingdomIntegrationId(valid.kingdomIntegrations[0]!),
  );

  const duplicate = defaultConfig();
  duplicate.kingdomIntegrations = [
    integration('https://a.example', organization),
    integration('https://a.example/', organization),
  ];
  expect(() => validateConfig(duplicate)).toThrow('--replace');
  const first = integration('https://a.example', organization);
  for (const shared of [
    { ...integration('https://b.example', organization), integrationId: first.integrationId },
    { ...integration('https://b.example', organization), signetId: first.signetId },
  ]) {
    const config = defaultConfig();
    config.kingdomIntegrations = [first, shared];
    expect(() => validateConfig(config)).toThrow('paired once');
  }
  for (const malformed of [
    { ...first, owner: 'Organization:not-a-uuid::' },
    { ...first, signetId: 'not-a-uuid' },
    { ...first, url: 'http://remote.example' },
  ]) {
    const config = defaultConfig();
    config.kingdomIntegrations = [malformed];
    expect(() => validateConfig(config)).toThrow();
  }
});

test('a selector names a paired Kingdom by id or API origin and never guesses between several', () => {
  const a = integration('https://a.example', organization),
    a2 = integration('https://a.example', user),
    b = integration('https://b.example', organization);
  expect(selectKingdomIntegration([a], undefined)).toBe(a);
  expect(selectKingdomIntegration([a, b], 'https://b.example/')).toBe(b);
  expect(selectKingdomIntegration([a, a2, b], kingdomIntegrationId(a2))).toBe(a2);
  expect(() => selectKingdomIntegration([a, b])).toThrow('Several Kingdoms');
  expect(() => selectKingdomIntegration([a, a2], 'https://a.example')).toThrow('--kingdom ID');
  expect(() => selectKingdomIntegration([a], 'https://c.example')).toThrow('No paired Kingdom');
  expect(() => selectKingdomIntegration([], undefined)).toThrow('bun run kingdom pair');
});

test('the Installation layout agrees with the Signet package', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kingdom-layout-'));
  try {
    const url = 'https://api.kingdom.example';
    expect(kingdomInstallationPaths(dir, url)).toEqual(
      await installationDirectory(kingdomInstallationRoot(dir), url),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('each paired Kingdom connects on its own; Signet files follow what Kingdom lists', async () => {
  const a = mockKingdom(),
    b = mockKingdom(),
    dir = await mkdtemp(join(tmpdir(), 'kingdom-integrations-'));
  const store = new ConfigStore(dir);
  let changes = 0;
  try {
    const pair = (kingdom: typeof a, owner: string) =>
      pairKingdomIntegration(store, dir, {
        url: kingdom.url,
        name: 'Two Kingdoms',
        viewerToken: 't'.repeat(48),
        onReview: () => kingdom.approve(owner),
      });
    const first = await pair(a, organizationOwner());
    const second = await pair(b, userOwner());
    const connections = new KingdomInstallationConnections(
      (await store.load()).kingdomIntegrations!,
      {
        configDir: dir,
        sessionCount: () => 3,
        socket: { pingMs: 30 },
        onChange: () => {
          changes++;
        },
      },
    );
    try {
      expect(await connections.start()).toEqual([]);
      expect(connections.size).toBe(2);
      expect(connections.authorized).toBe(true);
      expect(connections.connected(first.id)).toBe(true);
      expect(connections.connected(second.id)).toBe(true);
      expect(changes).toBeGreaterThan(0);

      // Kingdom hears how busy this Foundry is and where its viewer is, and nothing once it stops.
      const tunnel = 'https://studio.trycloudflare.com';
      connections.advertise(tunnel);
      const heard = () =>
        a.frames.some((frame) => frame.action === 'advertise' && frame.viewerUrl === tunnel) &&
        a.frames.some((frame) => frame.action === 'ping' && frame.sessionCount === 3);
      for (let tries = 0; !heard() && tries < 200; tries++) await Bun.sleep(10);
      expect(heard()).toBe(true);
      connections.advertise(null);
      const lastAdvertised = () =>
        a.frames.filter((frame) => frame.action === 'advertise').at(-1)?.viewerUrl;
      for (let tries = 0; lastAdvertised() !== null && tries < 200; tries++) await Bun.sleep(10);
      expect(lastAdvertised()).toBeNull();
      // Every pairing hands each paired integration the viewer credential.
      expect(a.credentials).toEqual([
        { integrationId: first.settings.integrationId, token: 't'.repeat(48) },
        { integrationId: first.settings.integrationId, token: 't'.repeat(48) },
      ]);
      expect(b.credentials.map((item) => item.integrationId)).toEqual([
        second.settings.integrationId,
      ]);

      // A later grant on the integration is enrolled; a revoked one stops being held (its file stays).
      const directory = kingdomInstallationPaths(dir, a.url).directory;
      const later = a.grant(first.settings.integrationId);
      const enrolled = () => existsSync(join(directory, `signet-${later}.json`));
      for (let tries = 0; !enrolled() && tries < 200; tries++) await Bun.sleep(10);
      expect(enrolled()).toBe(true);
      const holds = (signetId: string) =>
        connections.get(first.id)?.signets.some((signet) => signet.signetId === signetId) ?? false;
      for (let tries = 0; !holds(later) && tries < 200; tries++) await Bun.sleep(10);
      expect(holds(later)).toBe(true);
      a.list(later, false);
      for (let tries = 0; holds(later) && tries < 200; tries++) await Bun.sleep(10);
      expect(holds(later)).toBe(false);
      expect(enrolled()).toBe(true);
      expect(connections.connected(first.id)).toBe(true);

      // One Kingdom revoking its Signet leaves the other authorizing this Foundry.
      a.list(first.settings.signetId, false);
      for (let tries = 0; connections.connected(first.id) && tries < 200; tries++)
        await Bun.sleep(10);
      expect(connections.connected(first.id)).toBe(false);
      expect(connections.authorized).toBe(true);
      expect(holds(first.settings.signetId)).toBe(false);
      b.revokeInstallations();
      for (let tries = 0; connections.authorized && tries < 200; tries++) await Bun.sleep(10);
      expect(connections.authorized).toBe(false);
      await expect(connections.check()).rejects.toThrow('No paired Kingdom');
      expect(connections.get(second.id)?.isRevoked).toBe(true);

      connections.remove(first.id);
      connections.remove(second.id);
      expect(connections.size).toBe(0);
      expect(connections.authorized).toBe(true);
    } finally {
      connections.stop();
    }
  } finally {
    a.stop();
    b.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Kingdom polled while its socket is refused still authorizes until the snapshot goes stale', async () => {
  const kingdom = mockKingdom({ websocket: false }),
    dir = await mkdtemp(join(tmpdir(), 'kingdom-polled-'));
  const store = new ConfigStore(dir);
  try {
    const owner = userOwner();
    const paired = await pairKingdomIntegration(store, dir, {
      url: kingdom.url,
      name: 'Polled',
      viewerToken: 't'.repeat(48),
      socketOptions: { pollMs: 20, retryBaseMs: 10_000 },
      onReview: () => kingdom.approve(owner),
    });
    const connections = new KingdomInstallationConnections(
      (await store.load()).kingdomIntegrations!,
      {
        configDir: dir,
        sessionCount: () => 0,
        socket: { pollMs: 60_000, retryBaseMs: 60_000 },
        staleAfterMs: 50,
      },
    );
    try {
      await connections.start();
      expect(connections.connected(paired.id)).toBe(true);
      await Bun.sleep(80);
      expect(connections.connected(paired.id)).toBe(false);
    } finally {
      connections.stop();
    }
  } finally {
    kingdom.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
