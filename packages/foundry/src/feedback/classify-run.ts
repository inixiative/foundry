// A classify run config (`scripts/evals/warden-charter.ts --classify <run.json>`), read into what the
// eval runs: the stages a project's `chorus.wardens.stages` takes, each stage's charter as its
// `sections` set it (its charter's sections and the region Warden's instruction line), a grouped
// chorus's members, and which calls also take their debug readings. Every key and section name
// is checked here, so a typo stops the run before any call.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { computeHash } from '@inixiative/foundry-core';
import {
  charterVersion,
  EVAL_STAGE_KEYS,
  type SectionSource,
  type StageConfig,
  stageSections,
  validateStages,
} from '../classify';

const RUN_KEYS = ['stages', 'members', 'debug', '$comment'] as const;

/** One stage's charter as the run sends it, and where each of its sections came from. */
export interface RunCharter {
  /** The version every call journals: the hash of the assembled text. */
  readonly version: string;
  /** Whether any section differs from its default; an unchanged charter runs as the shipped one. */
  readonly changed: boolean;
  readonly sections: readonly SectionSource[];
}

export interface ClassifyRun {
  readonly path: string;
  /** The config's own hash: the run's label. */
  readonly hash: string;
  readonly stages: readonly StageConfig[];
  /** The stages as a project's settings write them (no `sections`): the chorus the run builds. */
  readonly settingsStages: Record<string, unknown>[];
  /** Per stage, the charter text to send when its sections change it (else the fixed charter runs). */
  readonly charters: readonly (string | undefined)[];
  readonly charterSources: readonly RunCharter[];
  /** Per stage, the region Warden's instruction line when its sections change it (empty: left out). */
  readonly regionInstructions: readonly (string | undefined)[];
  readonly regionInstructionSources: readonly SectionSource[];
  readonly members?: string;
  /**
   * Which calls take their debug readings: none (`false`), every one (`true`), or only the cells a
   * `{ "cells": "<file>" }` names (`{ "<probe id>": ["<domain>", …] }`, the --cells shape).
   */
  readonly debug:
    | false
    | true
    | { readonly cells: Readonly<Record<string, readonly string[]>>; readonly file: string };
}

/** Read and check a run config; relative files (sections, members) resolve against its folder. */
export function readClassifyRun(file: string): ClassifyRun {
  const path = resolve(file);
  const text = readFileSync(path, 'utf8');
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('--classify: the run config must be an object');
  for (const key of Object.keys(raw))
    if (!(RUN_KEYS as readonly string[]).includes(key))
      throw Error(`--classify: ${key} is not a run setting (${RUN_KEYS.slice(0, -1).join(', ')})`);
  const base = dirname(path);
  const stages = validateStages('--classify stages', raw.stages, EVAL_STAGE_KEYS);
  const rawStages = raw.stages as Record<string, unknown>[];
  const assembled = stages.map((stage, i) =>
    stageSections(stage, rawStages[i]!.sections, `--classify stages[${i}].sections`, base),
  );
  let debug: ClassifyRun['debug'] = false;
  if (typeof raw.debug === 'boolean') debug = raw.debug;
  else if (raw.debug !== undefined) {
    const d = raw.debug as Record<string, unknown> | null;
    if (
      !d ||
      typeof d !== 'object' ||
      Array.isArray(d) ||
      Object.keys(d).some((k) => k !== 'cells') ||
      typeof d.cells !== 'string'
    )
      throw Error('--classify debug must be true, false or { "cells": "<cells file>" }');
    const file = resolve(base, d.cells);
    const cells = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (
      !cells ||
      typeof cells !== 'object' ||
      Array.isArray(cells) ||
      !Object.values(cells).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))
    )
      throw Error('--classify debug.cells must name { "<probe id>": ["<domain>", …] }');
    debug = { cells: cells as Record<string, string[]>, file };
  }
  if (raw.members !== undefined && (typeof raw.members !== 'string' || !raw.members))
    throw Error('--classify members must be a regions directory');
  return {
    path,
    hash: computeHash(text).slice(0, 12),
    stages,
    settingsStages: rawStages.map(({ sections: _s, ...stage }) => stage),
    charters: assembled.map(({ charter }) => (charter.changed ? charter.text : undefined)),
    charterSources: assembled.map(({ charter }) => ({
      version: charterVersion(charter.text),
      changed: charter.changed,
      sections: charter.sections,
    })),
    regionInstructions: assembled.map(({ regionInstructions: r }) =>
      r.changed ? r.text : undefined,
    ),
    regionInstructionSources: assembled.map(({ regionInstructions: r }) => r.sections[0]!),
    ...(typeof raw.members === 'string' ? { members: resolve(base, raw.members) } : {}),
    debug,
  };
}
