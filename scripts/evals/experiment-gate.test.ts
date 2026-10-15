import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESIGN_SECTIONS, experimentProblems, requireExperiment } from './experiment-gate';

const dir = mkdtempSync(join(tmpdir(), 'experiment-gate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TEMPLATE = join(import.meta.dir, '..', '..', '.claude', 'skills', 'experiment', 'design.md');
const filled = `# An experiment\n\n${DESIGN_SECTIONS.map((s) => `## ${s}\n\nfilled in\n`).join('\n')}`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const write = (name: string, design: string, review?: string) => {
  const path = join(dir, `${name}.md`);
  writeFileSync(path, design);
  if (review !== undefined) writeFileSync(join(dir, `${name}.review.md`), review);
  return path;
};

describe('experiment gate', () => {
  test('a tiny run needs no design', () => {
    expect(requireExperiment(undefined, false)).toBeUndefined();
  });

  test('a wide run without a design is refused', () => {
    expect(() => requireExperiment(undefined, true)).toThrow(/needs --experiment/);
  });

  test('the unfilled template is refused', () => {
    const path = write('template', readFileSync(TEMPLATE, 'utf8'), '');
    expect(experimentProblems(path)).toContain('unfilled <fill: …> placeholders remain');
  });

  test('every template heading is a required section', () => {
    const headings = readFileSync(TEMPLATE, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((l) => l.slice(3).trim());
    expect(headings).toEqual([...DESIGN_SECTIONS]);
  });

  test('a missing or empty section is refused', () => {
    const path = write(
      'missing',
      filled
        .replace('## Baseline\n\nfilled in\n', '')
        .replace('## Gates\n\nfilled in', '## Gates\n'),
      `verdict: go\ndesign-sha256: ${'0'.repeat(64)}\n`,
    );
    const problems = experimentProblems(path);
    expect(problems).toContain('missing section "## Baseline"');
    expect(problems).toContain('section "## Gates" is empty');
  });

  test('no review, or a review that says revise, is refused', () => {
    expect(experimentProblems(write('unreviewed', filled)).join()).toMatch(/no adversarial review/);
    const path = write('revise', filled, `verdict: revise\ndesign-sha256: ${sha(filled)}\n`);
    expect(experimentProblems(path)).toEqual([
      `${join(dir, 'revise.review.md')} has no "verdict: go" line`,
    ]);
  });

  test('a design edited after its go is refused', () => {
    const path = write(
      'edited',
      `${filled}\nedited\n`,
      `verdict: go\ndesign-sha256: ${sha(filled)}\n`,
    );
    expect(experimentProblems(path).join()).toMatch(/changed after its review/);
  });

  test('a filled, reviewed design runs and returns its provenance', () => {
    const path = write('go', filled, `# Review\n\nverdict: go\ndesign-sha256: ${sha(filled)}\n`);
    expect(requireExperiment(path, true)).toEqual({
      design: path,
      designSha256: sha(filled),
      review: join(dir, 'go.review.md'),
    });
  });
});
