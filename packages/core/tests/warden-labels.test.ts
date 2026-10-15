import { expect, test } from 'bun:test';
import {
  fixtureProbe,
  labelAgreement,
  parseWardenLabels,
  type WardenFixture,
  type WardenLabel,
  type WardenRosterEntry,
  wardenLabelMessages,
  wardenLabelPrefix,
} from '../src/feedback/warden-labels';

const roster: WardenRosterEntry[] = [
  { id: 'librarian-reuse', domain: 'reuse', prompt: 'Reuse.', enabled: true },
  { id: 'librarian-schema', domain: 'schema', prompt: 'Schema.', enabled: true },
  { id: 'librarian-ship', domain: 'ship', prompt: 'Ship.', enabled: true },
];

test('parseWardenLabels labels every Warden, drops unknown domains and keeps order', () => {
  const content = `Here you go: {"results": {"b": {"context": "c2", "relevant": {}, "feedbackRules": []}, "a": {"context": "c1", "relevant": {"reuse": "use debounce()", "made-up": "x"}, "feedbackRules": [4, "x"]}}}`;
  const [a, b, missing] = parseWardenLabels(content, roster, ['a', 'b', 'z']);
  expect(a?.labels).toEqual({
    'librarian-reuse': { relevant: true, shouldKnow: 'use debounce()' },
    'librarian-schema': { relevant: false },
    'librarian-ship': { relevant: false },
  });
  expect(a?.feedbackRules).toEqual([4]);
  expect(a?.context).toBe('c1');
  expect(Object.values(b?.labels ?? {}).every((l) => !l.relevant)).toBe(true);
  expect(missing).toBeUndefined();
  expect(parseWardenLabels('not json', roster, ['a'])).toEqual([undefined]);
});

test('wardenLabelMessages puts the roster in a stable prefix and every fixture in the body', () => {
  const prefix = wardenLabelPrefix(roster, [{ n: 4, rule: 'Use what exists', count: '17' }]);
  const [system, user] = wardenLabelMessages(prefix, [
    {
      id: 'f1',
      ctx: 'inixiative',
      source: 'git',
      trigger: { kind: 'agent-action', text: 'adds a timer' },
      context: '',
      hidden: 'use debounce',
      provenance: {},
    },
  ]);
  expect(system?.role).toBe('system');
  expect(user?.content.startsWith(prefix)).toBe(true);
  expect(user?.content).toContain('## f1 (inixiative, git, trigger: agent-action)');
  expect(user?.content).toContain('use debounce');
});

test('labelAgreement gives per-Warden kappa and exact-fixture counts', () => {
  const l = (reuse: boolean, schema: boolean): Record<string, WardenLabel> => ({
    'librarian-reuse': { relevant: reuse },
    'librarian-schema': { relevant: schema },
  });
  const a = new Map([
    ['1', l(true, false)],
    ['2', l(false, false)],
    ['3', l(true, true)],
    ['4', l(false, false)],
  ]);
  const b = new Map([
    ['1', l(true, false)],
    ['2', l(false, false)],
    ['3', l(false, true)],
    ['4', l(false, false)],
  ]);
  const result = labelAgreement(a, b, ['librarian-reuse', 'librarian-schema']);
  expect(result.fixtures).toBe(4);
  expect(result.exactFixtures).toBe(3);
  const [reuse, schema] = result.perWarden;
  expect(reuse?.agree).toBe(3);
  expect(reuse?.kappa).toBe(0.5);
  expect(schema?.kappa).toBe(1);
  expect(result.pooled.n).toBe(8);
});

test('fixtureProbe turns a fixture into a charter probe', () => {
  const fixture: WardenFixture = {
    id: 'f',
    ctx: 'inixiative',
    source: 'session',
    trigger: { kind: 'agent-plan', text: 'plan' },
    context: 'ctx',
    labels: {
      'librarian-reuse': { relevant: true, shouldKnow: 'x' },
      'librarian-schema': { relevant: false },
    },
    provenance: {},
  };
  const probe = fixtureProbe(fixture, (id) => id.replace('librarian-', ''));
  expect(probe.kind).toBe('positive');
  expect(probe.gold).toEqual({ domains: ['reuse'], statements: ['x'] });
  expect(fixtureProbe({ ...fixture, labels: {} }, (id) => id).kind).toBe('negative');
  expect(probe).toMatchObject({ moment: 'plan' });
  // A user's message is asked at the user-message trigger, not passed off as an agent turn.
  const ask = fixtureProbe(
    { ...fixture, trigger: { kind: 'user-message', text: 'add a retry flag' } },
    (id) => id,
  );
  expect(ask).toMatchObject({ moment: '', ask: 'add a retry flag' });
});
