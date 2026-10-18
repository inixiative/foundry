import { computeHash } from '@inixiative/foundry-core';
import type { PointerSettings, StageTask } from '../stages';
import { pointCharter } from './point.warden';
import { RECOGNISE_CHARTER } from './recognise.warden';

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
 * pointer set. Fixed and owned by Foundry: no setting edits it; an eval may pass candidate text
 * instead (`charter` on a run config's stage).
 */
export function charterFor(
  task: StageTask,
  role: ClassifyRole,
  pointer?: PointerSettings,
): Charter {
  if (role === 'herald') throw Error('Heralds are not built: they have no charter yet');
  const text = task === 'recognise' ? RECOGNISE_CHARTER : pointCharter(pointer ?? { any: true });
  return { text, version: charterVersion(text) };
}
