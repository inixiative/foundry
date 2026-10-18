// The prompt language a classify stage sends, as named sections in order: the point charter, the
// recognise charter and the region Warden's opening instruction line. Each section's default text is a
// committed markdown file beside this module (`<prompt>/<section>.md`), so the language under test is
// reviewable as prose, and an eval run can set any section by name: off, its default, raw text in its
// place (or before/after it), or a file. Aron (2026-10-18): "Any run should be able to take a flag, and
// each of those flags should also have a place for raw language injection." Settings never carry
// sections: a live project's charters stay Foundry's (Oracle `docs/foundry/CLASSIFY.md`, "charters fixed for now").

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_OF_CAVEAT, CHOOSE_ONE_CAVEAT } from '../pointer';
import type { StageConfig } from '../stages';

/** A prompt made of sections: the two charters, and the region Warden's instruction line. */
export type SectionedPrompt = 'point' | 'recognise' | 'region';

/** What follows a section when another comes after it: a paragraph break, or a list's next line. */
type Join = '\n\n' | '\n';

/** Every section of each prompt, in order, with what joins it to the next. */
export const PROMPT_SECTIONS = {
  point: [
    ['opening', '\n\n'],
    ['build-is-reason', '\n\n'],
    ['job', '\n\n'],
    ['pointing', '\n'],
    ['all-of', '\n'],
    ['choose-one', '\n'],
    ['class', '\n'],
    ['sourcing-bar', '\n\n'],
    ['no-comment-default', '\n\n'],
    ['moment', '\n\n'],
    ['data-not-instructions', '\n\n'],
  ],
  recognise: [
    ['opening', '\n\n'],
    ['build-is-reason', '\n\n'],
    ['job', '\n\n'],
    ['near-is-not-in', '\n\n'],
    ['no-comment-default', '\n\n'],
    ['moment', '\n\n'],
    ['data-not-instructions', '\n\n'],
  ],
  region: [['region-instructions', '\n\n']],
} as const satisfies Record<SectionedPrompt, readonly (readonly [string, Join])[]>;

/** A section's default file, relative to this module. */
export const sectionFile = (prompt: SectionedPrompt, name: string) =>
  fileURLToPath(new URL(`./${prompt}/${name}.md`, import.meta.url));

/**
 * Default files name the pointer caveats by placeholder, so the parser's constant stays the one
 * source. Only defaults are substituted: text a run supplies is sent as written.
 */
const fill = (text: string) =>
  text
    .replaceAll('{{ALL_OF_CAVEAT}}', ALL_OF_CAVEAT)
    .replaceAll('{{CHOOSE_ONE_CAVEAT}}', CHOOSE_ONE_CAVEAT);

/** Read once at module load: a missing default is a broken install, not a runtime choice. */
const DEFAULTS: Record<SectionedPrompt, ReadonlyMap<string, string>> = {
  point: load('point'),
  recognise: load('recognise'),
  region: load('region'),
};

function load(prompt: SectionedPrompt): ReadonlyMap<string, string> {
  return new Map(
    PROMPT_SECTIONS[prompt].map(([name]) => [
      name,
      fill(readFileSync(sectionFile(prompt, name), 'utf8').trimEnd()),
    ]),
  );
}

/** A section's default text. */
export const defaultSection = (prompt: SectionedPrompt, name: string): string => {
  const text = DEFAULTS[prompt].get(name);
  if (text === undefined) throw Error(`${prompt} has no section ${name}`);
  return text;
};

/** Where a run's text goes relative to the section's default: in its place (default), or beside it. */
export type SectionPlace = 'replace' | 'before' | 'after';

/** One section as a run sets it: what it sends, where that text came from, and its hash. */
export interface SectionSource {
  readonly name: string;
  readonly source: 'default' | 'off' | 'text' | 'file';
  readonly place?: Exclude<SectionPlace, 'replace'>;
  /** A `file` source: the path as resolved. */
  readonly path?: string;
  /** sha256 of what the section sends (empty when off), so a report names the exact language. */
  readonly sha256: string;
}

export interface AssembledPrompt {
  readonly text: string;
  readonly sections: readonly SectionSource[];
  /** Whether any section differs from its default: an unchanged prompt runs as the shipped one. */
  readonly changed: boolean;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const PLACES: readonly SectionPlace[] = ['replace', 'before', 'after'];

/**
 * Assemble a prompt from its sections, each as `settings` sets it (`where` names the field in errors):
 * `true` or absent, the default; `false`, left out with its join; `{ text }` or `{ file }` (a path
 * resolved against `baseDir`), sent in its place, or `{ ..., place: "before" | "after" }` beside the
 * default, joined as the section joins. `omit` drops sections the stage does not offer (choose-one
 * when `pointer.any` is off); setting one of them is refused. An unknown name is refused by name.
 */
export function assemblePrompt(
  prompt: SectionedPrompt,
  settings: unknown,
  options: {
    readonly where: string;
    readonly baseDir?: string;
    readonly omit?: readonly string[];
  } = {
    where: prompt,
  },
): AssembledPrompt {
  const { where } = options;
  const order = PROMPT_SECTIONS[prompt] as readonly (readonly [string, Join])[];
  const names = order.map(([name]) => name);
  if (
    settings !== undefined &&
    (!settings || typeof settings !== 'object' || Array.isArray(settings))
  )
    throw Error(`${where} must be an object of section names (${names.join(', ')})`);
  const set = (settings ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(set)) {
    if (!names.includes(key))
      throw Error(`${where}.${key} is not a section of the ${prompt} prompt (${names.join(', ')})`);
    if (options.omit?.includes(key)) throw Error(`${where}.${key} is not offered at this stage`);
  }
  // A section left out leaves its join behind: a paragraph break it carried still separates what
  // stands either side of it (class, then the NO_COMMENT heading, when the sourcing bar is off).
  const parts: ({ text: string; join: Join } | { gap: Join })[] = [];
  const sections: SectionSource[] = [];
  let changed = false;
  for (const [name, join] of order) {
    if (options.omit?.includes(name)) {
      parts.push({ gap: join });
      continue;
    }
    const fallback = defaultSection(prompt, name);
    const value = set[name];
    if (value === undefined || value === true) {
      parts.push({ text: fallback, join });
      sections.push({ name, source: 'default', sha256: sha256(fallback) });
      continue;
    }
    changed = true;
    if (value === false) {
      parts.push({ gap: join });
      sections.push({ name, source: 'off', sha256: sha256('') });
      continue;
    }
    const at = `${where}.${name}`;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error(`${at} must be true, false, { "text": … } or { "file": … }`);
    const v = value as Record<string, unknown>;
    for (const key of Object.keys(v))
      if (!['text', 'file', 'place'].includes(key))
        throw Error(`${at}.${key} is not a section field (text, file, place)`);
    if ((v.text === undefined) === (v.file === undefined))
      throw Error(`${at} names exactly one of text and file`);
    const place = (v.place ?? 'replace') as SectionPlace;
    if (!PLACES.includes(place)) throw Error(`${at}.place must be one of ${PLACES.join(', ')}`);
    let text: string;
    let path: string | undefined;
    if (v.file !== undefined) {
      if (typeof v.file !== 'string' || !v.file) throw Error(`${at}.file must be a path`);
      path = resolve(options.baseDir ?? '.', v.file);
      text = readFileSync(path, 'utf8').trimEnd();
    } else {
      if (typeof v.text !== 'string' || !v.text.trim())
        throw Error(`${at}.text must be the section's text`);
      text = v.text.trimEnd();
    }
    const sent =
      place === 'replace' ? [text] : place === 'before' ? [text, fallback] : [fallback, text];
    for (const piece of sent) parts.push({ text: piece, join });
    sections.push({
      name,
      source: path ? 'file' : 'text',
      ...(place !== 'replace' ? { place } : {}),
      ...(path ? { path } : {}),
      sha256: sha256(sent.join(join)),
    });
  }
  let text = '';
  let pending: Join | undefined;
  for (const part of parts) {
    if ('gap' in part) {
      if (pending !== undefined && part.gap.length > pending.length) pending = part.gap;
      continue;
    }
    text += (pending ?? '') + part.text;
    pending = part.join;
  }
  return { text, sections, changed };
}

/** A stage's prompt language as a run's `sections` set it: its charter and its instruction line. */
export interface StageSections {
  readonly charter: AssembledPrompt;
  readonly regionInstructions: AssembledPrompt;
}

/**
 * A stage's sections as a run config sets them: `region-instructions` sets the region Warden's opening
 * instruction line for this stage's calls, every other name a section of the stage's charter (the
 * recognise or point prompt, by its task), choose-one offered only while `pointer.any` is on.
 * Choose-one is switched off by `pointer.any: false`, which also makes the parser refuse that shape,
 * never by `false` here, so the charter and the parser cannot disagree. All-of may be switched off:
 * the parser still reads it.
 */
export function stageSections(
  stage: StageConfig,
  settings: unknown,
  where: string,
  baseDir?: string,
): StageSections {
  const prompt = stage.task === 'recognise' ? 'recognise' : 'point';
  if (
    settings !== undefined &&
    (!settings || typeof settings !== 'object' || Array.isArray(settings))
  )
    throw Error(`${where} must be an object of section names`);
  const { 'region-instructions': line, ...charterSettings } = (settings ?? {}) as Record<
    string,
    unknown
  >;
  const anyOff = prompt === 'point' && stage.pointer?.any === false;
  if (anyOff && 'choose-one' in charterSettings)
    throw Error(`${where}.choose-one is not offered at this stage: its pointer.any is off`);
  if (prompt === 'point' && charterSettings['choose-one'] === false)
    throw Error(
      `${where}.choose-one: switch choose-one off with "pointer": { "any": false }, which also makes the parser refuse it`,
    );
  const names = [...PROMPT_SECTIONS[prompt].map(([name]) => name), 'region-instructions'].filter(
    (name) => !(anyOff && name === 'choose-one'),
  );
  for (const key of Object.keys(charterSettings))
    if (!names.includes(key))
      throw Error(`${where}.${key} is not a section of a ${prompt} stage (${names.join(', ')})`);
  const at = { where, ...(baseDir !== undefined ? { baseDir } : {}) };
  return {
    charter: assemblePrompt(prompt, charterSettings, {
      ...at,
      ...(anyOff ? { omit: ['choose-one'] } : {}),
    }),
    regionInstructions: assemblePrompt(
      'region',
      line === undefined ? undefined : { 'region-instructions': line },
      at,
    ),
  };
}

/**
 * Composed region Warden instructions with their opening line replaced by `opening` (empty: left out).
 * The composed slot is the generated prompt, then the ladder's files, so the line heads it; a slot
 * that does not open with the default line is refused rather than guessed at.
 */
export function withRegionInstructions(instructions: string, opening: string): string {
  const line = defaultSection('region', 'region-instructions');
  if (!instructions.startsWith(line))
    throw Error('these instructions do not open with the region Warden line, so it cannot be set');
  const rest = instructions.slice(line.length).replace(/^\n\n/, '');
  return opening ? `${opening}\n\n${rest}` : rest;
}
