import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESIGN_SECTIONS,
  experimentProblems,
  openDecisionLines,
  requireExperiment,
} from '../src/feedback/experiment-gate';

const dir = mkdtempSync(join(tmpdir(), 'experiment-gate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TEMPLATE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '.claude',
  'skills',
  'experiment',
  'design.md',
);
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

  describe('decisions companion', () => {
    const reviewed = (name: string, decisions?: string) => {
      const path = write(name, filled, `verdict: go\ndesign-sha256: ${sha(filled)}\n`);
      if (decisions !== undefined) writeFileSync(join(dir, `${name}.decisions.md`), decisions);
      return path;
    };

    test('no companion: the record carries no decisions', () => {
      const record = requireExperiment(reviewed('no-decisions'), true);
      expect(record?.decisions).toBeUndefined();
      expect(record?.decisionsSha256).toBeUndefined();
    });

    test('a companion that still says TBD is refused, naming the lines', () => {
      const path = reviewed(
        'open',
        '# Decisions\n\n| Pin | TBD |\n| Model | x |\n| Answer | TBD by Aron |\n',
      );
      expect(experimentProblems(path)).toEqual([
        `${join(dir, 'open.decisions.md')} still says TBD (lines 3, 5)`,
      ]);
      expect(() => requireExperiment(path, true)).toThrow(/still says TBD/);
    });

    test('the Log section and a backticked mention of the token are not open values', () => {
      const text = [
        '# Decisions', //                                  1
        'Refused while any `TBD` remains.', //             2  mention
        '| Command | `run --token-file <TBD by Aron>` |', // 3  value inside code: open
        '### Sub', //                                      4
        '| Answer | TBD |', //                              5  still before the Log
        '## Log', //                                       6
        '- all other values are TBD', //                   7  history
        '### Older', //                                    8
        '- TBD', //                                        9  a subheading stays in the Log
        '## After', //                                     10
        '| x | TBD |', //                                  11 open again
      ].join('\n');
      expect(openDecisionLines(text)).toEqual([3, 5, 11]);
    });

    test('TBD is matched as a token, not inside a word', () => {
      expect(experimentProblems(reviewed('word', '| Pin | TBDX and notTBD |\n'))).toEqual([]);
    });

    test('a filled companion runs and its path and hash are recorded', () => {
      const decisions = '# Decisions\n\n| Pin | 2.1.301 |\n';
      const path = reviewed('filled-decisions', decisions);
      expect(requireExperiment(path, true)).toEqual({
        design: path,
        designSha256: sha(filled),
        review: join(dir, 'filled-decisions.review.md'),
        decisions: join(dir, 'filled-decisions.decisions.md'),
        decisionsSha256: sha(decisions),
      });
    });

    test('editing the companion does not invalidate the design review', () => {
      const path = reviewed('edited-decisions', '| Pin | a |\n');
      writeFileSync(join(dir, 'edited-decisions.decisions.md'), '| Pin | b |\n');
      expect(experimentProblems(path)).toEqual([]);
    });
  });
});
