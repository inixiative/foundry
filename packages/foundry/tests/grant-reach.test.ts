import { describe, expect, it } from 'bun:test';
import { createLens, type StoredLens } from '@inixiative/json-rules';
import type { HostedSignet, SignetGrant } from '@inixiative/signet';
import { grantReaches, type ThreadsGrant } from '../src/conversations/grantReach';
import { reaching, threadsBaseLenses, threadsGrant } from './helpers/kingdom-installation';

const member = (
  resources: SignetGrant[],
  baseLenses: HostedSignet['baseLenses'] = threadsBaseLenses(),
): HostedSignet => ({
  signetId: Bun.randomUUIDv7(),
  name: 'JobCo',
  revision: 1,
  lifecycle: 'ongoing',
  expiresAt: null,
  maxRequests: null,
  recipient: { recipientModel: 'User', id: Bun.randomUUIDv7(), displayName: 'JobCo' },
  resources,
  baseLenses,
});

const withLayers = (lens: NonNullable<ThreadsGrant['lens']>): SignetGrant => {
  const grant = threadsGrant({ threadIds: ['main'] });
  if (grant.resourceModel !== 'IntegrationResource') throw new Error('not a threads row');
  return { ...grant, lens };
};

const quiet = () => {
  const warnings: string[] = [];
  return { warnings, warn: (message: string) => warnings.push(message) };
};

describe('grantReaches reads a thread at its operation’s branch of the operations lens', () => {
  it('a pinned grant reaches only its threads, and an approver’s layer only narrows', () => {
    const { warn, warnings } = quiet();
    const pinned = member([threadsGrant({ threadIds: ['main', 'side'] })]);
    expect(grantReaches(pinned, 'main', undefined, warn)).toBeDefined();
    expect(grantReaches(pinned, 'side', ['thread.read'], warn)).toBeDefined();
    expect(grantReaches(pinned, 'elsewhere', undefined, warn)).toBeUndefined();

    const approved = member([threadsGrant({ threadIds: ['main', 'side'], approved: ['side'] })]);
    expect(grantReaches(approved, 'side', undefined, warn)).toBeDefined();
    expect(grantReaches(approved, 'main', undefined, warn)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('a grant reaches a thread only for the operations it permits', () => {
    const { warn } = quiet();
    const posting = member([threadsGrant({ threadIds: ['main'], operations: ['thread.prompt'] })]);
    expect(grantReaches(posting, 'main', ['thread.prompt'], warn)).toBeDefined();
    expect(grantReaches(posting, 'main', ['thread.read', 'thread.floor'], warn)).toBeUndefined();
  });

  it('a grant with no layers reaches every thread, full or not', () => {
    const { warn, warnings } = quiet();
    const unpinned = member([threadsGrant({ everyThread: true, operations: ['thread.read'] })]);
    expect(grantReaches(unpinned, 'main', ['thread.read'], warn)).toBeDefined();
    expect(grantReaches(unpinned, 'any-thread', ['thread.read'], warn)).toBeDefined();
    expect(grantReaches(unpinned, 'any-thread', ['thread.prompt'], warn)).toBeUndefined();
    const full = member([threadsGrant({ full: true })], {});
    expect(grantReaches(full, 'any-thread', undefined, warn)).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it('a full grant with layers reaches only the threads its lens pins, as Kingdom admits', () => {
    const { warn } = quiet();
    const fullPinned = member([threadsGrant({ full: true, threadIds: ['main'] })]);
    expect(grantReaches(fullPinned, 'main', undefined, warn)).toBeDefined();
    expect(grantReaches(fullPinned, 'elsewhere', undefined, warn)).toBeUndefined();
  });

  it('a pinned grant whose base lens the snapshot lacks reaches nothing, warned once', () => {
    const { warn, warnings } = quiet();
    const orphan = member([threadsGrant({ threadIds: ['main'] })], {});
    expect(grantReaches(orphan, 'main', undefined, warn)).toBeUndefined();
    expect(grantReaches(orphan, 'main', undefined, warn)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no base lens foundry:threads');
  });

  it('a grant reaches only the threads its incoming where admits, before its lens', () => {
    const { warn, warnings } = quiet();
    const whereMain = { field: 'threadId', operator: 'in', value: ['main'] };
    const unpinned = threadsGrant({ everyThread: true });
    const whereOnly = member([{ ...unpinned, where: whereMain } as SignetGrant]);
    expect(grantReaches(whereOnly, 'main', undefined, warn)).toBeDefined();
    expect(grantReaches(whereOnly, 'elsewhere', undefined, warn)).toBeUndefined();

    const pinnedWider = threadsGrant({ threadIds: ['main', 'elsewhere'] });
    const both = member([{ ...pinnedWider, where: whereMain } as SignetGrant]);
    expect(grantReaches(both, 'main', undefined, warn)).toBeDefined();
    expect(grantReaches(both, 'elsewhere', undefined, warn)).toBeUndefined();

    const onOtherField = { field: 'text', operator: 'equals', value: 'hi' };
    const undecidable = member([{ ...unpinned, where: onOtherField } as SignetGrant]);
    expect(grantReaches(undecidable, 'main', undefined, warn)).toBeUndefined();
    const malformed = member([{ ...unpinned, where: { any: 'nope' } } as unknown as SignetGrant]);
    expect(grantReaches(malformed, 'main', undefined, warn)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('a layer not chained under the threads base and every earlier layer reaches nothing', () => {
    const { warn, warnings } = quiet();
    const grant = threadsGrant({ threadIds: ['main'] }) as ThreadsGrant;
    const request = grant.lens?.[0];
    if (!request) throw new Error('no request layer');
    const unchained = withLayers([
      request,
      { id: 'approval', parents: ['foundry:threads'], ...reaching(['main', 'elsewhere']) },
    ]);
    expect(grantReaches(member([unchained]), 'elsewhere', undefined, warn)).toBeUndefined();
    expect(grantReaches(member([unchained]), 'main', undefined, warn)).toBeUndefined();
    expect(warnings.at(-1)).toContain('approval is not chained under foundry:threads');

    const otherBase = withLayers([{ ...request, parents: ['other:base'] }]);
    const bases = {
      ...threadsBaseLenses(),
      'other:base': { ...threadsBaseLenses()['foundry:threads'], id: 'other:base' },
    } as HostedSignet['baseLenses'];
    expect(grantReaches(member([otherBase], bases), 'main', undefined, warn)).toBeUndefined();
    expect(warnings.at(-1)).toContain('request is not chained under foundry:threads');
  });

  it('the old shape, a lens rooted at Thread with a where on its root, reaches nothing', () => {
    const { warn } = quiet();
    const oldLayer = {
      id: 'request',
      parents: ['foundry:threads'],
      root: { where: { field: 'id', operator: 'in', value: ['main'] } },
    };
    const oldGrant = withLayers([oldLayer]);
    expect(grantReaches(member([oldGrant]), 'main', undefined, warn)).toBeUndefined();

    const threadRootedBase: StoredLens = {
      ...createLens({
        maps: {
          foundry: {
            models: {
              Thread: { fields: { id: { kind: 'scalar', type: 'String', isRequired: true } } },
            },
          },
        },
        mapName: 'foundry',
        model: 'Thread',
      }),
      id: 'foundry:threads',
      parents: [],
    };
    const oldBase = { 'foundry:threads': threadRootedBase } as HostedSignet['baseLenses'];
    expect(grantReaches(member([oldGrant], oldBase), 'main', undefined, warn)).toBeUndefined();
    const newLayerOverOldBase = withLayers([
      { id: 'request', parents: ['foundry:threads'], ...reaching(['main']) },
    ]);
    expect(
      grantReaches(member([newLayerOverOldBase], oldBase), 'main', undefined, warn),
    ).toBeUndefined();
  });
});
