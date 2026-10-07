import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type KingdomRuntimeSettings,
  kingdomRuntimeId,
  selectKingdomRuntime,
} from '../src/providers/kingdom-runtime-connection';
import { KingdomRuntimeConnections } from '../src/providers/kingdom-runtime-connections';
import { ConfigStore, defaultConfig, validateConfig } from '../src/viewer/config';

const organization = 'Organization::11111111-1111-4111-8111-111111111111:';
const user = 'User:22222222-2222-4222-8222-222222222222::';
const runtime = (
  url: string,
  owner: string,
  credentialFile = '/private/runtime.json',
): KingdomRuntimeSettings => ({ url, owner, installationId: crypto.randomUUID(), credentialFile });

test('settings hold one runtime per Kingdom + owner; duplicates, owner-less runtimes and the single-Kingdom key are invalid', async () => {
  const valid = defaultConfig();
  valid.kingdomRuntimes = [
    runtime('https://a.example', organization),
    runtime('https://a.example', user),
    runtime('https://b.example', organization),
  ];
  expect(() => validateConfig(valid)).not.toThrow();
  expect(new Set(valid.kingdomRuntimes.map(kingdomRuntimeId)).size).toBe(3);
  expect(kingdomRuntimeId({ url: 'https://a.example/', owner: organization })).toBe(
    kingdomRuntimeId(valid.kingdomRuntimes[0]!),
  );

  const duplicate = defaultConfig();
  duplicate.kingdomRuntimes = [
    runtime('https://a.example', organization),
    runtime('https://a.example/', organization),
  ];
  expect(() => validateConfig(duplicate)).toThrow('--replace');
  const sharedInstallation = defaultConfig(),
    first = runtime('https://a.example', organization);
  sharedInstallation.kingdomRuntimes = [
    first,
    { ...runtime('https://b.example', organization), installationId: first.installationId },
  ];
  expect(() => validateConfig(sharedInstallation)).toThrow('installation');
  const ownerless = defaultConfig();
  ownerless.kingdomRuntimes = [
    {
      url: 'https://a.example',
      installationId: crypto.randomUUID(),
      credentialFile: '/private/runtime.json',
    } as KingdomRuntimeSettings,
  ];
  expect(() => validateConfig(ownerless)).toThrow();

  const dir = await mkdtemp(join(tmpdir(), 'kingdom-runtimes-config-'));
  try {
    const legacy = {
      url: 'https://a.example',
      installationId: crypto.randomUUID(),
      credentialFile: join(dir, 'runtime.json'),
    };
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ ...defaultConfig(), kingdomRuntime: legacy }),
    );
    await expect(new ConfigStore(dir).load()).rejects.toThrow(
      'pair again with bun run kingdom pair',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a selector names a paired Kingdom by id or API origin and never guesses between several', () => {
  const a = runtime('https://a.example', organization),
    a2 = runtime('https://a.example', user),
    b = runtime('https://b.example', organization);
  expect(selectKingdomRuntime([a], undefined)).toBe(a);
  expect(selectKingdomRuntime([a, b], 'https://b.example/')).toBe(b);
  expect(selectKingdomRuntime([a, a2, b], kingdomRuntimeId(a2))).toBe(a2);
  expect(() => selectKingdomRuntime([a, b])).toThrow('Several Kingdoms');
  expect(() => selectKingdomRuntime([a, a2], 'https://a.example')).toThrow('--kingdom ID');
  expect(() => selectKingdomRuntime([a], 'https://c.example')).toThrow('No paired Kingdom');
  expect(() => selectKingdomRuntime([], undefined)).toThrow('bun run kingdom pair');
});

test('each paired Kingdom connects on its own: one refusing never stops the other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kingdom-runtimes-'));
  const kingdoms = new Map<
    string,
    {
      runtime: KingdomRuntimeSettings;
      owner: object;
      allowed: boolean;
    }
  >();
  for (const [index, [url, owner, ownerRef]] of (
    [
      [
        'https://a.example',
        organization,
        { ownerModel: 'Organization', organizationId: '11111111-1111-4111-8111-111111111111' },
      ],
      [
        'https://b.example',
        user,
        { ownerModel: 'User', userId: '22222222-2222-4222-8222-222222222222' },
      ],
    ] as const
  ).entries()) {
    const credentialFile = join(dir, `kingdom-runtime-${index}.json`);
    await writeFile(
      credentialFile,
      JSON.stringify({ secret: `kingdom_runtime_${String(index).repeat(43)}` }),
      { mode: 0o600 },
    );
    kingdoms.set(url, {
      runtime: runtime(url, owner, credentialFile),
      owner: ownerRef,
      allowed: true,
    });
  }
  const [a, b] = [...kingdoms.values()];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)),
      kingdom = kingdoms.get(url.origin)!,
      action = url.pathname.split('/').at(-1);
    const secret = (init?.headers as Record<string, string>).authorization;
    if (
      !kingdom.allowed ||
      secret !==
        `Bearer kingdom_runtime_${String([...kingdoms.values()].indexOf(kingdom)).repeat(43)}`
    )
      return new Response('revoked', { status: 401 });
    const { installationId } = kingdom.runtime;
    if (action === 'runtimeHeartbeat')
      return Response.json({
        data: {
          installationId,
          userId: null,
          owner: kingdom.owner,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      });
    return new Response('unknown', { status: 404 });
  }) as typeof fetch;
  a!.allowed = false;
  const connections = new KingdomRuntimeConnections([a!.runtime, b!.runtime], () => 0, transport);
  try {
    expect(await connections.start()).toEqual([kingdomRuntimeId(a!.runtime)]);
    expect(connections.get(kingdomRuntimeId(b!.runtime))?.connected).toBe(true);
    expect(connections.authorized).toBe(true);
    await connections.check();
    expect(connections.get(kingdomRuntimeId(a!.runtime))?.connected).toBe(false);

    a!.allowed = true;
    await connections.get(kingdomRuntimeId(a!.runtime))!.check();
    expect(connections.get(kingdomRuntimeId(a!.runtime))?.connected).toBe(true);

    b!.allowed = false;
    await expect(connections.get(kingdomRuntimeId(b!.runtime))!.check()).rejects.toThrow();
    await connections.check();
    a!.allowed = false;
    await expect(connections.check()).rejects.toThrow('No paired Kingdom');
    expect(connections.authorized).toBe(false);
  } finally {
    connections.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
