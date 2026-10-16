/**
 * The experiment gate (`.claude/skills/experiment/SKILL.md`), shared by Foundry's eval scripts and
 * Oracle's replay runner: a wide run (more than TINY_MOMENTS moments, or whatever else the caller
 * counts as wide) needs `--experiment <design.md>` whose pre-registration sections are filled and
 * whose `<design>.review.md` says `verdict: go` for this exact design (`design-sha256:` of its
 * bytes). A tiny test runs without one. When a `<design>.decisions.md` companion sits beside the
 * design (run pins and answers that are filled after review, so the design's hash stays fixed), the
 * run is refused while it still says `TBD`, and its path and hash are recorded too.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TINY_MOMENTS = 3;

/** The `## ` headings of `.claude/skills/experiment/design.md`, every one required. */
export const DESIGN_SECTIONS = [
  'Question',
  'Variable',
  'Arms',
  'Fixtures and power',
  'Baseline',
  'Gates',
  'Cost ceiling and stop rules',
  'Provenance',
  'What would make the result wrong',
] as const;

export type ExperimentRecord = {
  design: string;
  designSha256: string;
  review: string;
  decisions?: string;
  decisionsSha256?: string;
};

export const reviewPathOf = (design: string) => design.replace(/\.md$/, '.review.md');
export const decisionsPathOf = (design: string) => design.replace(/\.md$/, '.decisions.md');

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Why the design may not run wide; empty when it may. */
export const experimentProblems = (designPath: string): string[] => {
  const design = resolve(designPath);
  if (!design.endsWith('.md')) return [`${design}: the design is a .md file`];
  if (!existsSync(design)) return [`${design}: no such design`];
  const problems: string[] = [];
  const text = readFileSync(design, 'utf8');
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1]?.toLowerCase();
      if (current) sections.set(current, sections.get(current) ?? '');
    } else if (/^#\s/.test(line)) current = undefined;
    else if (current) sections.set(current, `${sections.get(current) ?? ''}${line}\n`);
  }
  for (const name of DESIGN_SECTIONS) {
    const body = sections.get(name.toLowerCase());
    if (body === undefined) problems.push(`missing section "## ${name}"`);
    else if (!body.replace(/<!--[\s\S]*?-->/g, '').trim())
      problems.push(`section "## ${name}" is empty`);
  }
  if (text.includes('<fill')) problems.push('unfilled <fill: …> placeholders remain');
  const decisions = decisionsPathOf(design);
  if (existsSync(decisions)) {
    const open = readFileSync(decisions, 'utf8')
      .split('\n')
      .flatMap((line, i) => (/\bTBD\b/.test(line) ? [i + 1] : []));
    if (open.length)
      problems.push(
        `${decisions} still says TBD (line${open.length > 1 ? 's' : ''} ${open.join(', ')})`,
      );
  }
  const review = reviewPathOf(design);
  if (!existsSync(review)) return [...problems, `no adversarial review at ${review}`];
  const reviewText = readFileSync(review, 'utf8');
  if (!/^verdict:\s*go\s*$/im.test(reviewText))
    problems.push(`${review} has no "verdict: go" line`);
  const reviewed = /^design-sha256:\s*([0-9a-f]{64})\s*$/im.exec(reviewText)?.[1];
  if (!reviewed) problems.push(`${review} has no "design-sha256: <hex>" line`);
  else if (reviewed !== sha256(design))
    problems.push('the design changed after its review (design-sha256 differs): review it again');
  return problems;
};

/** Throws unless the run may go ahead; returns the provenance to record when a design was named. */
export const requireExperiment = (
  experiment: string | undefined,
  wide: boolean,
): ExperimentRecord | undefined => {
  if (!experiment) {
    if (!wide) return undefined;
    throw Error(
      `a wide run (more than ${TINY_MOMENTS} moments) needs --experiment <design.md> ` +
        'with a reviewed pre-registration: see .claude/skills/experiment/SKILL.md',
    );
  }
  const problems = experimentProblems(experiment);
  if (problems.length)
    throw Error(
      `--experiment ${experiment} may not run:\n  - ${problems.join('\n  - ')}\n` +
        'see .claude/skills/experiment/SKILL.md',
    );
  const design = resolve(experiment);
  const record: ExperimentRecord = {
    design,
    designSha256: sha256(design),
    review: reviewPathOf(design),
  };
  const decisions = decisionsPathOf(design);
  if (existsSync(decisions)) {
    record.decisions = decisions;
    record.decisionsSha256 = sha256(decisions);
  }
  return record;
};
