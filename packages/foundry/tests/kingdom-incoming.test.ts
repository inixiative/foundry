import { expect, test } from 'bun:test';
import type { HostedSignetRequest } from '@inixiative/signet';
import { joiningDefault, validateFoundryConversationSettings } from '../src/conversations/types';
import { kingdomIntegrationId } from '../src/providers/kingdom-installation-connection';
import { kingdomProjectOn } from '../src/viewer/config';
import { inviteUrl } from '../src/viewer/routes/conversations';
import { incomingRequests } from '../src/viewer/routes/kingdom';

const request = (over: Partial<HostedSignetRequest>): HostedSignetRequest => ({
  id: '00000000-0000-4000-8000-000000000001',
  status: 'sent',
  createdAt: '2026-11-01T10:00:00.000Z',
  expiresAt: null,
  requester: {
    sourceModel: 'User',
    id: '00000000-0000-4000-8000-0000000000bb',
    displayName: 'Sam',
    audience: 'inOrg',
  },
  terms: {
    name: 'Review the checkout thread',
    lifecycle: 'task',
    expiresAt: '2026-11-07T00:00:00.000Z',
    maxRequests: 50,
    resources: [
      {
        resourceModel: 'IntegrationResource',
        integrationResourceId: '00000000-0000-4000-8000-0000000000cc',
        operations: { picks: ['thread.read', 'thread.prompt'] },
      },
      {
        resourceModel: 'IntegrationResource',
        integrationResourceId: '00000000-0000-4000-8000-0000000000dd',
        operations: { picks: ['thread.read'] },
      },
      { resourceModel: 'Project', projectId: '00000000-0000-4000-8000-0000000000ff' },
    ],
  },
  resourceHandles: {},
  reviewUrl: 'https://kingdom.example/dashboard?integration=x&signetRequest=y',
  ...over,
});

// Incoming lists only requests still waiting on the owner: sent and not expired, across every
// paired Kingdom, newest first, with what they ask for in plain fields.
test('incomingRequests keeps pending, unexpired requests from every Kingdom, newest first', () => {
  const now = Date.parse('2026-11-01T12:00:00.000Z');
  const a = {
    url: 'https://kingdom-a.example',
    signetRequests: [
      request({}),
      request({ id: '00000000-0000-4000-8000-000000000002', status: 'approved' }),
      request({
        id: '00000000-0000-4000-8000-000000000003',
        expiresAt: '2026-11-01T11:00:00.000Z',
      }),
    ],
  };
  const b = {
    url: 'https://kingdom-b.example',
    signetRequests: [
      request({
        id: '00000000-0000-4000-8000-000000000004',
        createdAt: '2026-11-01T11:30:00.000Z',
        requester: {
          sourceModel: 'Integration',
          id: '00000000-0000-4000-8000-0000000000ee',
          displayName: "Priya's agent",
          audience: 'outside',
        },
      }),
    ],
  };
  const listed = incomingRequests([a, b], now);
  expect(listed.map((r) => [r.id, r.kingdomUrl, r.requester])).toEqual([
    ['00000000-0000-4000-8000-000000000004', 'https://kingdom-b.example', "Priya's agent"],
    ['00000000-0000-4000-8000-000000000001', 'https://kingdom-a.example', 'Sam'],
  ]);
  expect(listed[1]).toMatchObject({
    name: 'Review the checkout thread',
    lifecycle: 'task',
    maxRequests: 50,
    until: '2026-11-07T00:00:00.000Z',
    full: false,
    operations: ['thread.read', 'thread.prompt'],
    audience: 'inOrg',
  });
  expect(listed[0]?.audience).toBe('outside');
});

const permissionsParam = (reviewUrl: string) => {
  const url = new URL(reviewUrl);
  return {
    rest: [...url.searchParams].filter(([key]) => key !== 'permissions'),
    permissions: url.searchParams.get('permissions'),
  };
};

// The review link carries this Foundry's default conversation permissions for the requester's
// audience, comma-separated under `permissions`: the review opens at what was asked with only the
// agent's latitude capped, as the old terms did (Aron 2026-11-14: in-org and outside, something naive).
test('the review link carries the default permissions for the requester audience', () => {
  const [outside, inOrg] = incomingRequests(
    [
      {
        url: 'https://kingdom-a.example',
        signetRequests: [
          request({}),
          request({
            id: '00000000-0000-4000-8000-000000000002',
            createdAt: '2026-11-01T11:00:00.000Z',
            requester: { ...request({}).requester, audience: 'outside' },
          }),
        ],
      },
    ],
    Date.parse('2026-11-01T12:00:00.000Z'),
  );
  expect(permissionsParam(inOrg!.reviewUrl)).toEqual({
    rest: [
      ['integration', 'x'],
      ['signetRequest', 'y'],
    ],
    permissions: 'member.log,member.wake,member.take,member.agent,agent.instruct,agent.read',
  });
  // Outside: everything about taking part, nothing that has the agent take its word.
  expect(permissionsParam(outside!.reviewUrl).permissions).toBe(
    'member.log,member.wake,member.take,member.agent',
  );
  expect(joiningDefault(undefined, 'outside')).toEqual({
    permissions: ['member.log', 'member.wake', 'member.take', 'member.agent'],
    outbound: 'review',
  });
  expect(joiningDefault(undefined, 'inOrg').permissions).not.toContain('agent.act');
});

// The person's own settings replace the built-in default field by field, per audience.
test('the review link follows this Foundry conversations.joining setting', () => {
  const [listed] = incomingRequests(
    [{ url: 'https://kingdom-a.example', signetRequests: [request({})] }],
    Date.parse('2026-11-01T12:00:00.000Z'),
    { joining: { inOrg: { permissions: ['member.log', 'agent.act'], outbound: 'auto' } } },
  );
  expect(permissionsParam(listed!.reviewUrl).permissions).toBe('member.log,agent.act');
  expect(joiningDefault({ joining: { inOrg: { outbound: 'auto' } } }, 'inOrg')).toEqual({
    permissions: joiningDefault(undefined, 'inOrg').permissions,
    outbound: 'auto',
  });
});

// A resource asked for whole is everything it offers, now and as it grows (signet 0.12 `full`).
test('incomingRequests says when a request asks for a resource whole', () => {
  const whole = request({
    terms: {
      ...request({}).terms,
      resources: [
        {
          resourceModel: 'IntegrationResource',
          integrationResourceId: '00000000-0000-4000-8000-0000000000cc',
          operations: { full: true },
        },
      ],
    },
  });
  expect(
    incomingRequests([{ url: 'https://kingdom-a.example', signetRequests: [whole] }])[0],
  ).toMatchObject({ full: true, operations: [] });
});

// The top-level `conversations` is this Foundry's joining defaults only; a project's floor settings
// are refused there by name, pointing at where they go.
test('this Foundry conversations takes joining only, and names where project keys go', () => {
  expect(() =>
    validateFoundryConversationSettings({ joining: { outside: { permissions: ['agent.read'] } } }),
  ).not.toThrow();
  expect(() => validateFoundryConversationSettings({ floor: 'conch' })).toThrow(
    'conversations.floor is a project setting',
  );
  expect(() =>
    validateFoundryConversationSettings({
      joining: { outside: { permissions: ['agent.everything'] } },
    }),
  ).toThrow();
});

// The invite link (CONVERSATIONS.md, F1 as built) names the Kingdom Project a thread's project links
// to on that Kingdom, so Kingdom creates the conversation resource in it; a global thread, or a
// project linked elsewhere or not at all, carries none.
test('the invite link carries the linked Kingdom Project on that Kingdom, and only then', () => {
  const owner = 'User:00000000-0000-4000-8000-0000000000aa::';
  const here = {
    url: 'https://kingdom-a.example',
    integrationId: '00000000-0000-4000-8000-0000000000a1',
    owner,
    signetId: '00000000-0000-4000-8000-0000000000a2',
  };
  const there = { ...here, url: 'https://kingdom-b.example' };
  const config = { kingdomIntegrations: [here, there] };
  const projectId = '00000000-0000-4000-8000-0000000000f1';
  const linked = { kingdomProject: { kingdom: kingdomIntegrationId(here), projectId } };
  expect(kingdomProjectOn(config, linked, kingdomIntegrationId(here))).toBe(projectId);
  expect(kingdomProjectOn(config, linked, kingdomIntegrationId(there))).toBeUndefined();
  expect(kingdomProjectOn(config, {}, kingdomIntegrationId(here))).toBeUndefined();
  const thread = { threadId: 'thread_1', threadName: 'Hiring' };
  const withProject = new URL(
    inviteUrl('https://kingdom-web.example', here.integrationId, { ...thread, projectId }),
  );
  expect(Object.fromEntries(withProject.searchParams)).toEqual({
    grantThreads: here.integrationId,
    threadId: 'thread_1',
    threadName: 'Hiring',
    projectId,
  });
  const global = new URL(inviteUrl('https://kingdom-web.example', here.integrationId, thread));
  expect(global.searchParams.has('projectId')).toBe(false);
});

// A join request names its thread (`resourceHandles`): the card and Kingdom's review say which one;
// a thread this Foundry doesn't have is shown by its id, marked unknown, never dropped.
test('incoming requests name the thread they ask for, and keep one this Foundry does not have', () => {
  const names = (threadId: string) =>
    threadId === 'thread_known' ? 'Checkout redesign' : undefined;
  const known = request({
    resourceHandles: { '00000000-0000-4000-8000-0000000000cc': 'thread_known' },
  });
  const stranger = request({
    id: '00000000-0000-4000-8000-000000000003',
    createdAt: '2026-11-01T09:00:00.000Z',
    resourceHandles: { '00000000-0000-4000-8000-0000000000dd': 'thread_gone' },
  });
  const [first, second] = incomingRequests(
    [{ url: 'https://kingdom-a.example', signetRequests: [known, stranger] }],
    Date.parse('2026-11-01T12:00:00.000Z'),
    undefined,
    names,
  );
  expect(first!.threads).toEqual([{ threadId: 'thread_known', name: 'Checkout redesign' }]);
  expect(new URL(first!.reviewUrl).searchParams.get('threadName')).toBe('Checkout redesign');
  expect(second!.threads).toEqual([{ threadId: 'thread_gone', unknown: true }]);
  expect(new URL(second!.reviewUrl).searchParams.has('threadName')).toBe(false);
});
