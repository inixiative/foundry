import { describe, expect, test } from 'bun:test';
import { dispatch, parseRecognition } from './pipeline-dispatch';

describe('parseRecognition', () => {
  test('reads one region per line, with or without the "region" prefix', () => {
    const r = parseRecognition('region test-harness: VCR\napi-client: query hooks');
    expect(r.regions).toEqual([
      { regionId: 'test-harness', why: 'VCR' },
      { regionId: 'api-client', why: 'query hooks' },
    ]);
    expect(r.errors).toEqual([]);
  });
  test('keeps every finding in a multi-line reply and counts a shared line as a collapse', () => {
    const r = parseRecognition('a-one, b-two: shared why\nc-three: own why');
    expect(r.regions.map((x) => x.regionId)).toEqual(['a-one', 'b-two', 'c-three']);
    expect(r.regions[0]!.why).toBe('shared why');
    expect(r.collapses).toBe(1);
  });
  test('a line in no shape is an error', () => {
    const r = parseRecognition('Yes, this is about testing');
    expect(r.regions).toEqual([]);
    expect(r.errors).toEqual(['Yes, this is about testing']);
  });
});

describe('dispatch', () => {
  const groups: Record<string, string[]> = {
    'g01-api-client': ['api-client', 'test-harness'],
    'test-factories-rules': ['test-factories-rules'],
  };
  const membersOf = (g: string) => groups[g] ?? [g];
  const pickers = new Set(['api-client', 'test-harness', 'test-factories-rules']);

  test('a group recogniser dispatches each named member to its own picker', () => {
    const { fired, counts } = dispatch(
      [
        {
          probeId: 'p1',
          trigger: 'user-message',
          domain: 'g01-api-client',
          noComment: false,
          text: 'test-harness: VCR cassette\napi-client: query hook',
        },
      ],
      membersOf,
      (id) => pickers.has(id),
    );
    expect(fired.get('p1|user-message')).toEqual([
      { domain: 'test-harness', why: 'VCR cassette' },
      { domain: 'api-client', why: 'query hook' },
    ]);
    expect(counts).toMatchObject({ remarks: 1, regionsNamed: 2, dispatched: 2, unknownRegions: 0 });
  });

  test('an id outside the group is unknown; a member with no picker is counted apart', () => {
    const { fired, counts } = dispatch(
      [
        {
          probeId: 'p2',
          domain: 'g01-api-client',
          noComment: false,
          text: 'inquiries: wrong group\ntest-harness: ok',
        },
        { probeId: 'p3', domain: 'orphan', noComment: false, text: 'orphan: held, no picker' },
        { probeId: 'p4', domain: 'g01-api-client', noComment: true },
      ],
      membersOf,
      (id) => pickers.has(id),
    );
    expect(fired.get('p2|agent-action')).toEqual([{ domain: 'test-harness', why: 'ok' }]);
    expect(fired.has('p3|agent-action')).toBe(false);
    expect(fired.has('p4|agent-action')).toBe(false);
    expect(counts).toMatchObject({
      remarks: 2,
      unknownRegions: 1,
      missingPickers: 1,
      dispatched: 1,
    });
  });

  test('a one-region recogniser holds itself; a repeated id dispatches once', () => {
    const { fired, counts } = dispatch(
      [
        {
          probeId: 'p5',
          domain: 'test-factories-rules',
          noComment: false,
          text: 'test-factories-rules: factory\nregion test-factories-rules: again',
        },
      ],
      membersOf,
      (id) => pickers.has(id),
    );
    expect(fired.get('p5|agent-action')).toEqual([
      { domain: 'test-factories-rules', why: 'factory' },
    ]);
    expect(counts.dispatched).toBe(1);
  });
});
