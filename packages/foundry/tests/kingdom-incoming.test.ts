import { expect, test } from 'bun:test';
import type { HostedSignetRequest } from '@inixiative/signet';
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
    reviewUrl: 'https://kingdom.example/dashboard?integration=x&signetRequest=y',
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
