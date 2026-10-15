import { expect, test } from 'bun:test';
import {
  authorshipOf,
  evidenceSnippet,
  parseReviewFindings,
  REUSE_HINT,
  reviewFindingMessages,
  styleOf,
} from '../src/feedback/review-findings';

test('parseReviewFindings reads findings, voice and empty items; malformed items are undefined', () => {
  const content = `Here you go:
{"results": {
  "a": {"voice": "human", "findings": [{"name": "Skeleton component", "kind": "primitive", "concept": "Frontend UI", "where": "packages/ui", "builtInstead": "static bg-muted bars", "miss": "unaware", "excerpt": "Use Skeleton."}]},
  "b": {"voice": "agent", "findings": []},
  "c": {"findings": [{"name": "", "concept": "x"}, {"name": "lodash omit", "kind": "weird", "concept": "shared-helpers-utils", "miss": "nope"}]},
  "d": {"voice": "human"}
}}`;
  const [a, b, c, d, e] = parseReviewFindings(content, ['a', 'b', 'c', 'd', 'e']);
  expect(a).toEqual({
    voice: 'human',
    findings: [
      {
        target: {
          name: 'Skeleton component',
          kind: 'primitive',
          concept: 'frontend-ui',
          where: 'packages/ui',
          builtInstead: 'static bg-muted bars',
          miss: 'unaware',
        },
        excerpt: 'Use Skeleton.',
      },
    ],
  });
  expect(b).toEqual({ voice: 'agent', findings: [] });
  expect(c?.findings).toEqual([
    {
      target: {
        name: 'lodash omit',
        kind: 'pattern',
        concept: 'shared-helpers-utils',
        miss: 'unclear',
      },
      excerpt: '',
    },
  ]);
  expect(d).toBeUndefined();
  expect(e).toBeUndefined();
  expect(parseReviewFindings('not json', ['a'])).toEqual([undefined]);
});

test('reviewFindingMessages carries the work, the code and the reply', () => {
  const [system, user] = reviewFindingMessages([
    {
      id: 'x1',
      where: 'repo PR #1 (inline)',
      work: 'Add a list',
      code: 'a.ts:3\n@@ hunk',
      replyTo: 'why not paginate?',
      text: 'use paginate()',
    },
  ]);
  expect(system!.content).toContain('ALREADY EXISTS');
  expect(user!.content).toContain('## x1');
  expect(user!.content).toContain('@@ hunk');
  expect(user!.content).toContain('### Replying to\nwhy not paginate?');
  expect(user!.content).toContain('concurrency-locking');
});

test('REUSE_HINT catches reuse language and skips plain bug reports', () => {
  expect(REUSE_HINT.test('we should use lodash here (omit)')).toBe(true);
  expect(REUSE_HINT.test('This duplicates fetchCappedValues')).toBe(true);
  expect(REUSE_HINT.test("there's already a helper for this")).toBe(true);
  expect(REUSE_HINT.test('This returns 500 when the body is empty.')).toBe(false);
});

test('authorshipOf: strong markers decide, typed beats posted, drafts and voice are weak', () => {
  expect(authorshipOf('Looks good\n\n🤖 Generated with [Claude Code](x)')).toMatchObject({
    by: 'agent',
    confidence: 'strong',
  });
  expect(authorshipOf('⏺ Yeah, that is pointless.')).toMatchObject({
    by: 'agent',
    confidence: 'strong',
  });
  expect(authorshipOf('we should use lodash here\r\nomit it')).toMatchObject({
    by: 'human',
    confidence: 'strong',
  });
  expect(authorshipOf('anything', { posted: true })).toMatchObject({
    by: 'agent',
    confidence: 'strong',
  });
  expect(authorshipOf('anything', { posted: true, typed: true })).toMatchObject({
    by: 'human',
    confidence: 'strong',
  });
  expect(authorshipOf('im not sure this is needed', { drafted: true }, 'human')).toMatchObject({
    by: 'agent',
    confidence: 'weak',
  });
  const voiced = authorshipOf('Use the Skeleton.', {}, 'agent');
  expect(voiced).toMatchObject({ by: 'agent', confidence: 'weak' });
  expect(voiced.signals).toContain('voice:agent');
});

test('styleOf separates terse typing from structured agent prose', () => {
  expect(styleOf('im not sure this is needed, the templates wrap the schema with array')).toBe(
    'human',
  );
  expect(
    styleOf(
      '## Code review\n\n1. **Lock** — `a` uses `b` and `c` instead of `d` — see `e`.\n2. **Fixed in** 1234567',
    ),
  ).toBe('agent');
});

test('evidenceSnippet takes a quoting-safe run from the middle of the longest one', () => {
  const text =
    'The loading state hand-rolls static bars inside the same package that owns the Skeleton primitive and more words here';
  const snippet = evidenceSnippet(text)!;
  expect(snippet.length).toBeLessThanOrEqual(48);
  expect(text).toContain(snippet);
  expect(snippet).not.toMatch(/["'`\\]/);
  expect(evidenceSnippet('`a` "b" — c')).toBeUndefined();
});
