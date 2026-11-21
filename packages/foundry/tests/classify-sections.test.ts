// Prompt sections as run parameters (Aron, 2026-10-18: "Any run should be able to take a flag, and
// each of those flags should also have a place for raw language injection"). No model calls.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGION_WARDEN_INSTRUCTIONS, regionInstructions } from '../src/agents/region-roster';
import {
  type AddedSection,
  assemblePrompt,
  charterFor,
  charterVersion,
  defaultSection,
  modeSections,
  NO_COMMENT,
  PROMPT_SECTIONS,
  pointCharter,
  RECOGNISE_CHARTER,
  stageModes,
  stageSections,
  validateStages,
  WARDEN_CHARTER,
  withRegionInstructions,
} from '../src/classify';
import { readClassifyRun } from '../src/feedback/classify-run';

const dir = () => mkdtempSync(join(tmpdir(), 'classify-sections-'));
const runOf = (config: object, files: Record<string, string> = {}) => {
  const d = dir();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  writeFileSync(join(d, 'run.json'), JSON.stringify(config));
  return readClassifyRun(join(d, 'run.json'));
};
const POINT = validateStages('s', [{}])[0]!;

describe('default byte-identity', () => {
  test('the assembled defaults are the texts main shipped before the split, by version', () => {
    // Versions of the pre-split constants on main 8beec5f (the charters hash their text).
    expect(charterVersion(pointCharter({ any: true }))).toBe('charter-e49589e870f6');
    expect(charterVersion(pointCharter({ any: false }))).toBe('charter-cf70d4a673cc');
    expect(charterVersion(RECOGNISE_CHARTER)).toBe('charter-8449efe23eb0');
    expect(charterVersion(REGION_WARDEN_INSTRUCTIONS)).toBe('charter-cd5314acc32f');
    expect(WARDEN_CHARTER).toBe(pointCharter({ any: true }));
  });

  test('every section set to true is the default, unchanged', () => {
    const all = Object.fromEntries(PROMPT_SECTIONS.point.map(([name]) => [name, true]));
    const a = assemblePrompt('point', all, { where: 'x' });
    expect(a.text).toBe(WARDEN_CHARTER);
    expect(a.changed).toBe(false);
    expect(a.sections.every((s) => s.source === 'default')).toBe(true);
    expect(a.sections.map((s) => s.name)).toEqual(PROMPT_SECTIONS.point.map(([name]) => name));
  });

  test('the sourcing bar is its own section, between class and the NO_COMMENT default', () => {
    expect(defaultSection('point', 'sourcing-bar')).toBe(
      'Never point at something your knowledge does not contain. A pointer you cannot source is a guess: answer NO_COMMENT instead.',
    );
    const names = PROMPT_SECTIONS.point.map(([name]) => name as string);
    expect(names.indexOf('sourcing-bar')).toBe(names.indexOf('class') + 1);
    expect(names.indexOf('no-comment-default')).toBe(names.indexOf('sourcing-bar') + 1);
  });
});

describe('setting a section', () => {
  test('off leaves it out, and the paragraph break it carried still separates its neighbours', () => {
    const a = assemblePrompt('point', { 'sourcing-bar': false }, { where: 'x' });
    expect(a.text).not.toContain('Never point at something');
    expect(a.text).toContain(
      `${defaultSection('point', 'class')}\n\n${defaultSection('point', 'no-comment-default')}`,
    );
    expect(a.changed).toBe(true);
    expect(a.sections.find((s) => s.name === 'sourcing-bar')?.source).toBe('off');
    expect(charterVersion(a.text)).not.toBe(charterVersion(WARDEN_CHARTER));
  });

  test('text replaces it in place; before and after inject beside the default', () => {
    const bar = 'Point whenever your knowledge holds something close.';
    const replaced = assemblePrompt('point', { 'sourcing-bar': { text: bar } }, { where: 'x' });
    expect(replaced.text).toBe(
      WARDEN_CHARTER.replace(defaultSection('point', 'sourcing-bar'), bar),
    );
    const after = assemblePrompt(
      'point',
      { 'sourcing-bar': { text: bar, place: 'after' } },
      { where: 'x' },
    );
    expect(after.text).toContain(
      `${defaultSection('point', 'sourcing-bar')}\n\n${bar}\n\n## NO_COMMENT`,
    );
    expect(after.sections.find((s) => s.name === 'sourcing-bar')).toMatchObject({
      source: 'text',
      place: 'after',
    });
    const before = assemblePrompt('point', { job: { text: bar, place: 'before' } }, { where: 'x' });
    expect(before.text).toContain(`${bar}\n\n${defaultSection('point', 'job')}`);
  });

  test('a file is read relative to the run config and recorded with its path and sha256', () => {
    const run = runOf(
      { stages: [{ sections: { job: { file: 'job.md' } } }] },
      { 'job.md': '## Your job\nCandidate wording.\n' },
    );
    expect(run.charters[0]).toContain('## Your job\nCandidate wording.\n\n## Pointing');
    const job = run.charterSources[0]!.sections.find((s) => s.name === 'job')!;
    expect(job.source).toBe('file');
    expect(job.path).toEndWith('/job.md');
    expect(job.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.charterSources[0]!.version).toBe(charterVersion(run.charters[0]!));
  });

  test('an unknown name, a bad value and a stage-less offer are refused by name', () => {
    expect(() => runOf({ stages: [{ sections: { closing: false } }] })).toThrow(
      /stages\[0\]\.sections\.closing is not a section of a point stage/,
    );
    expect(() => runOf({ stages: [{ task: 'recognise', sections: { pointing: false } }] })).toThrow(
      /pointing is not a section of a recognise stage/,
    );
    expect(() => runOf({ stages: [{ sections: { job: 'x' } }] })).toThrow(
      /job must be true, false/,
    );
    expect(() => runOf({ stages: [{ sections: { job: { text: 'a', file: 'b' } } }] })).toThrow(
      /exactly one of text and file/,
    );
    expect(() => runOf({ stages: [{ sections: { job: { text: 'a', place: 'top' } } }] })).toThrow(
      /place must be one of replace, before, after/,
    );
    // Sections belong to a stage: the run itself takes none.
    expect(() => runOf({ stages: [{}], sections: {} })).toThrow(/sections is not a run setting/);
    // The retired whole-charter keys are gone.
    expect(() => runOf({ stages: [{ charterFile: 'c.md' }] })).toThrow(
      /charterFile is not a setting/,
    );
  });

  test('choose-one is switched off by pointer.any, the one way, so charter and parser agree', () => {
    expect(() => runOf({ stages: [{ sections: { 'choose-one': false } }] })).toThrow(
      /switch choose-one off with "pointer": \{ "any": false \}/,
    );
    expect(() =>
      runOf({ stages: [{ pointer: { any: false }, sections: { 'choose-one': { text: 'x' } } }] }),
    ).toThrow(/choose-one is not offered at this stage: its pointer.any is off/);
    const off = runOf({ stages: [{ pointer: { any: false } }] });
    expect(off.charters[0]).toBeUndefined();
    expect(off.charterSources[0]!.version).toBe(charterVersion(pointCharter({ any: false })));
    // All-of may be switched off; the parser still reads an all-of answer (documented).
    expect(runOf({ stages: [{ sections: { 'all-of': false } }] }).charters[0]).not.toContain(
      'All of these',
    );
  });

  test('sections are refused in settings by name', () => {
    expect(() => validateStages('chorus.wardens.stages', [{ sections: { job: false } }])).toThrow(
      /sections is not a setting: charters are fixed per task and role/,
    );
  });
});

describe('region-instructions', () => {
  const region = { id: 'locks', title: 'Locks', routing: 'Exclusion?' };
  test('a stage sets it like a charter section: off, text or file', () => {
    const composed = `${regionInstructions(region)}\n\n# Ladder\nfiles`;
    const off = stageSections(POINT, { 'region-instructions': false }, 'x');
    expect(off.regionInstructions.changed).toBe(true);
    expect(off.charter.changed).toBe(false);
    expect(withRegionInstructions(composed, off.regionInstructions.text)).toBe(
      'Your region: Locks (`locks`).\nRouting: Exclusion?\n\n# Ladder\nfiles',
    );
    const text = stageSections(POINT, { 'region-instructions': { text: 'Be brief.' } }, 'x');
    expect(withRegionInstructions(composed, text.regionInstructions.text)).toStartWith(
      'Be brief.\n\nYour region: Locks',
    );
    const run = runOf(
      { stages: [{ sections: { 'region-instructions': { file: 'line.md' } } }] },
      { 'line.md': 'Old line.\n' },
    );
    expect(run.regionInstructions).toEqual(['Old line.']);
    expect(run.regionInstructionSources[0]).toMatchObject({ source: 'file' });
    expect(run.charters).toEqual([undefined]);
    expect(() => withRegionInstructions('Something else', 'x')).toThrow(/do not open with/);
  });
});

describe('mode sections: composed in, never held by the assembler', () => {
  const TERNARY = validateStages('s', [{ outcomes: 'ternary' }])[0]!;
  const unsure = modeSections('point', ['ternary']).find((s) => s.name === 'ternary/unsure')!;

  test('a stage mode adds its sections; binary with no why adds none and stays the shipped charter', () => {
    expect(stageModes(POINT)).toEqual([]);
    expect(charterFor('point', 'warden', { any: true }, POINT).text).toBe(WARDEN_CHARTER);
    expect(stageModes(TERNARY)).toEqual(['ternary']);
    const ternary = charterFor('point', 'warden', { any: true }, TERNARY).text;
    // Additive: the default charter is all there, with the unsure section after the NO_COMMENT default.
    for (const [name] of PROMPT_SECTIONS.point)
      expect(ternary).toContain(defaultSection('point', name));
    const at = ternary.indexOf(unsure.text);
    expect(at).toBeGreaterThan(ternary.indexOf(defaultSection('point', 'no-comment-default')));
    expect(at).toBeLessThan(ternary.indexOf(defaultSection('point', 'moment')));
  });

  test('a dagger not enabled by default leaves its target until a run turns it on, then takes its place', () => {
    const dagger = modeSections('point', ['ternary']).find((s) => s.overrides === 'sourcing-bar')!;
    expect(dagger).toMatchObject({ name: 'ternary/sourcing-bar', enabled: false });
    const plain = stageSections(TERNARY, undefined, 'x').charter;
    expect(plain.text).toContain(defaultSection('point', 'sourcing-bar'));
    expect(plain.text).not.toContain(dagger.text);
    expect(plain.changed).toBe(false);
    const on = stageSections(TERNARY, { 'ternary/sourcing-bar': true }, 'x').charter;
    expect(on.text).toContain(dagger.text);
    expect(on.text).not.toContain(defaultSection('point', 'sourcing-bar'));
    expect(on.changed).toBe(true);
    // While the dagger is on, its target is set through it, not by its own name.
    expect(() =>
      stageSections(TERNARY, { 'ternary/sourcing-bar': true, 'sourcing-bar': false }, 'x'),
    ).toThrow(/sourcing-bar is overridden at this stage by ternary\/sourcing-bar/);
  });

  test('a mode section is set by name like any other: off, text, or beside its default', () => {
    const off = stageSections(TERNARY, { 'ternary/unsure': false }, 'x').charter;
    expect(off.text).toBe(WARDEN_CHARTER);
    expect(off.changed).toBe(true);
    const text = stageSections(
      TERNARY,
      { 'ternary/unsure': { text: 'Say unsure when torn.' } },
      'x',
    );
    expect(text.charter.text).toContain('Say unsure when torn.');
    expect(text.charter.text).not.toContain(unsure.text);
    expect(() => stageSections(POINT, { 'ternary/unsure': false }, 'x')).toThrow(
      /ternary\/unsure is not a section of a point stage/,
    );
  });

  test('the composer refuses an added section that names no section, or a name it already has', () => {
    const base = { where: 'x', added: [] as AddedSection[] };
    expect(() =>
      assemblePrompt('point', undefined, {
        ...base,
        added: [{ name: 'm/a', text: 'A.', after: 'nowhere', enabled: true }],
      }),
    ).toThrow(/m\/a names nowhere, which is not a section of the point prompt/);
    expect(() =>
      assemblePrompt('point', undefined, {
        ...base,
        added: [{ name: 'job', text: 'A.', enabled: true }],
      }),
    ).toThrow(/point already has a section job/);
    const end = assemblePrompt('point', undefined, {
      ...base,
      added: [{ name: 'm/a', text: 'Appended.', enabled: true }],
    });
    expect(end.text).toBe(`${WARDEN_CHARTER}\n\nAppended.`);
  });
});
