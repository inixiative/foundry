import { computeHash } from '@inixiative/foundry-core';
import type { PointerSettings, StageConfig, StageTask } from '../stages';
import { pointCharter } from './point.warden';
import { RECOGNISE_CHARTER } from './recognise.warden';
import { assemblePrompt, modeSections, stageModes } from './sections';

/** Who a charter is for. Heralds have a socket (their own stages and docs) and no charter until built. */
export type ClassifyRole = 'warden' | 'herald';

/** A charter as a stage sends it: its text and the version every call journals. */
export interface Charter {
  readonly text: string;
  readonly version: string;
}

/** A charter's version: a hash of its text. */
export const charterVersion = (text: string): string => `charter-${computeHash(text).slice(0, 12)}`;

/**
 * The charter a stage runs under, chosen by (task, role) and, for a point stage, assembled from its
 * pointer set, with the sections its modes add (`modes`: three outcomes, a why inline or asked
 * after). Fixed and owned by Foundry: no setting edits it; an eval run's `sections` may set its parts.
 */
export function charterFor(
  task: StageTask,
  role: ClassifyRole,
  pointer?: PointerSettings,
  modes?: Pick<StageConfig, 'outcomes' | 'reason'>,
): Charter {
  if (role === 'herald') throw Error('Heralds are not built: they have no charter yet');
  const added = modes
    ? modeSections(task === 'recognise' ? 'recognise' : 'point', stageModes(modes))
    : [];
  const text = !added.length
    ? task === 'recognise'
      ? RECOGNISE_CHARTER
      : pointCharter(pointer ?? { any: true })
    : assemblePrompt(task === 'recognise' ? 'recognise' : 'point', undefined, {
        where: task,
        added,
        ...(task === 'point' && pointer?.any === false ? { omit: ['choose-one'] } : {}),
      }).text;
  return { text, version: charterVersion(text) };
}
