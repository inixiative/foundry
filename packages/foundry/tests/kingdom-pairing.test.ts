import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { signetCredentialFile } from '@inixiative/signet';
import { kingdomInstallationPaths } from '../src/providers/kingdom-installation-connection';
import { ConfigStore } from '../src/viewer/config';
import { startViewer } from '../src/viewer/server';
import {
  type MockKingdom,
  mockKingdom,
  organizationOwner,
  userOwner,
} from './helpers/kingdom-installation';

type KingdomState = {
  status: string;
  error?: string;
  pending?: { url: string; reviewCode: string; review: string; replace?: string };
  integrations: {
    id: string;
    url: string;
    owner: string;
    integrationId: string;
    signetId: string;
    status: string;
  }[];
  installations: { url: string; connected: boolean; revoked: boolean }[];
};
const kingdomState = async (response: Response) => (await response.json()) as KingdomState;

async function viewerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'foundry-pairing-'));
  const thread = new Thread('pairing', new ContextStack());
  const viewer = await startViewer({
    port: 0,
    configDir: root,
    localStore: null,
    harness: new Harness(thread),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
  });
  const base = `http://127.0.0.1:${viewer.server.port}`;
  const post = (action: string, body: unknown = {}) =>
    fetch(`${base}/api/kingdom/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const status = async () => kingdomState(await fetch(`${base}/api/kingdom/status`));
  /** Polls status, as the settings page does, until `done` holds. */
  const until = async (done: (state: KingdomState) => boolean) => {
    for (let tries = 0; tries < 300; tries++) {
      const state = await status();
      if (done(state)) return state;
      await Bun.sleep(10);
    }
    throw Error('Kingdom status never settled');
  };
  const settings = async () => JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
  const tunnel = async () => (await fetch(`${base}/api/tunnel`)).status;
  const signetFile = (kingdom: MockKingdom, signetId: string) =>
    signetCredentialFile(kingdomInstallationPaths(root, kingdom.url).directory, signetId);
  return { root, viewer, base, post, status, until, settings, tunnel, signetFile };
}

test('the viewer pairs as an Installation, shows the review code, connects on approval and follows revocation', async () => {
  const kingdom = mockKingdom(),
    f = await viewerFixture(),
    owner = organizationOwner();
  try {
    const staleSettings = await (await fetch(`${f.base}/api/settings`)).json();
    const start = await f.post('pair', { url: kingdom.url, name: 'Test Foundry' });
    expect(start.status).toBe(200);
    const pairing = await kingdomState(start);
    expect(pairing.pending).toMatchObject({ url: kingdom.url });
    expect(pairing.pending!.review).toBe(
      `${kingdom.url}/dashboard?reviewSignet=${pairing.pending!.reviewCode}`,
    );
    expect((await f.post('pair', { url: kingdom.url, name: 'Duplicate' })).status).toBe(409);
    expect(await f.tunnel()).toBe(200);

    const { integrationId, signetId } = kingdom.approve(owner);
    const connected = await f.until((state) => state.status === 'connected');
    expect(connected.pending).toBeUndefined();
    expect(connected.integrations).toEqual([
      {
        id: expect.any(String),
        url: kingdom.url,
        owner,
        integrationId,
        signetId,
        status: 'connected',
      },
    ]);
    expect(connected.installations).toEqual([
      { url: kingdom.url, connected: true, revoked: false },
    ]);
    const { id } = connected.integrations[0]!;
    expect(f.viewer.kingdom.connected(id)).toBe(true);
    expect(await f.tunnel()).toBe(200);

    const file = f.signetFile(kingdom, signetId);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(f.root)).mode & 0o777).toBe(0o700);
    const { accessToken } = JSON.parse(await readFile(file, 'utf8'));
    expect(await readFile(join(f.root, 'settings.json'), 'utf8')).not.toContain(accessToken);
    expect(JSON.stringify(connected)).not.toContain(accessToken);
    expect(kingdom.credentials.map((item) => item.integrationId)).toEqual([integrationId]);

    // A settings save from a page loaded before pairing keeps the pairing.
    expect(
      (
        await fetch(`${f.base}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(staleSettings),
        })
      ).status,
    ).toBe(200);
    expect((await f.settings()).kingdomIntegrations).toEqual([
      { url: kingdom.url, integrationId, owner, signetId },
    ]);

    // Pairing again approved by another owner replaces nothing.
    expect(
      (await f.post('pair', { url: kingdom.url, name: 'Replacement', replace: id })).status,
    ).toBe(200);
    kingdom.approve(userOwner());
    const refused = await f.until((state) => !state.pending);
    expect(refused.error).toContain('nothing was replaced');
    expect((await f.settings()).kingdomIntegrations).toEqual([
      { url: kingdom.url, integrationId, owner, signetId },
    ]);
    expect(existsSync(file)).toBe(true);
    expect(await f.tunnel()).toBe(200);

    // A pairing can be canceled while it waits.
    expect((await f.post('pair', { url: kingdom.url, name: 'Canceled' })).status).toBe(200);
    const canceled = await kingdomState(await f.post('cancel'));
    expect(canceled.pending).toBeUndefined();
    expect(canceled.status).toBe('connected');

    // Kingdom revoking the Signet locks the viewer at once; the pairing page stays reachable.
    kingdom.list(signetId, false);
    await f.until((state) => state.status === 'unavailable');
    expect(await f.tunnel()).toBe(503);
    expect((await fetch(`${f.base}/kingdom`)).status).toBe(200);
    expect(
      (await fetch(`${f.base}/api/kingdom/status`, { headers: { origin: 'https://evil.test' } }))
        .status,
    ).toBe(403);
    kingdom.list(signetId, true);
    await f.until((state) => state.status === 'connected');
    expect(await f.tunnel()).toBe(200);

    expect((await f.post('disconnect')).status).toBe(400);
    expect((await f.post('disconnect', { id: '000000000000' })).status).toBe(404);
    expect((await kingdomState(await f.post('disconnect', { id }))).status).toBe('disconnected');
    expect(f.viewer.kingdom.size).toBe(0);
    expect(await f.tunnel()).toBe(200);
    expect(await f.settings()).not.toHaveProperty('kingdomIntegrations');
    expect(existsSync(file)).toBe(false);
  } finally {
    f.viewer.server.stop(true);
    kingdom.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a declined registration leaves nothing paired and says so', async () => {
  const kingdom = mockKingdom(),
    f = await viewerFixture();
  try {
    expect((await f.post('pair', { url: kingdom.url, name: 'Declined' })).status).toBe(200);
    kingdom.decline();
    const declined = await f.until((state) => !state.pending);
    expect(declined.error).toContain('declined');
    expect(declined.status).toBe('disconnected');
    expect((await new ConfigStore(f.root).load()).kingdomIntegrations).toBeUndefined();
    expect((await f.post('pair', { url: 'http://remote.example', name: 'x' })).status).toBe(400);
  } finally {
    f.viewer.server.stop(true);
    kingdom.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the viewer pairs a second Kingdom beside the first, keeps working while either authorizes, and disconnects one without touching the other', async () => {
  const a = mockKingdom({ autoApprove: organizationOwner() }),
    b = mockKingdom({ autoApprove: userOwner() }),
    f = await viewerFixture();
  try {
    const pair = async (kingdom: MockKingdom) => {
      expect((await f.post('pair', { url: kingdom.url, name: 'Two Kingdoms' })).status).toBe(200);
      return f.until(
        (state) => !state.pending && state.integrations.some((item) => item.url === kingdom.url),
      );
    };
    await pair(a);
    const state = await pair(b);
    expect(state.status).toBe('connected');
    expect(state.integrations.map((integration) => integration.url)).toEqual([a.url, b.url]);
    const [first, second] = state.integrations;
    expect(f.viewer.kingdom.size).toBe(2);

    a.list(first!.signetId, false);
    const degraded = await f.until((current) => current.status === 'unavailable');
    expect(degraded.integrations.map((integration) => integration.status)).toEqual([
      'unavailable',
      'connected',
    ]);
    expect(await f.tunnel()).toBe(200);
    b.list(second!.signetId, false);
    await f.until((current) => current.integrations.every((item) => item.status !== 'connected'));
    expect(await f.tunnel()).toBe(503);
    b.list(second!.signetId, true);
    await f.until((current) => current.integrations[1]?.status === 'connected');
    expect(await f.tunnel()).toBe(200);

    expect((await f.post('disconnect', { id: first!.id })).status).toBe(200);
    const remaining = await f.status();
    expect(remaining.integrations.map((integration) => integration.id)).toEqual([second!.id]);
    expect(f.viewer.kingdom.get(first!.id)).toBeUndefined();
    expect(f.viewer.kingdom.connected(second!.id)).toBe(true);
    expect(
      (await f.settings()).kingdomIntegrations.map(
        (integration: { url: string }) => integration.url,
      ),
    ).toEqual([b.url]);
    expect(existsSync(f.signetFile(b, second!.signetId))).toBe(true);
  } finally {
    f.viewer.server.stop(true);
    a.stop();
    b.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});
