/**
 * @atlas
 * @kind utils
 * @partOf feature:conversations
 */
import {
  check,
  composeLens,
  type Lens,
  type LensNarrowing,
  narrowRule,
  type StoredLens,
} from '@inixiative/json-rules';
import {
  type HostedSignet,
  permitsOperation,
  type SignetGrant,
  storedLensLayersSchema,
  type ThreadOperation,
  threadOperationSchema,
  threadRow,
  threadsResourceKind,
} from '@inixiative/signet';

export type ThreadsGrant = Extract<SignetGrant, { resourceModel: 'IntegrationResource' }>;

const warned = new Set<string>();

/** The grantor's composed lens for one row: its base, then its layers in order; null if unreadable. */
function composedLens(
  signet: HostedSignet,
  grant: ThreadsGrant,
  warn: (message: string) => void,
): Lens | LensNarrowing | null {
  const refuse = (reason: string) => {
    const key = `${signet.signetId}:${signet.revision}:${grant.integrationResourceId}`;
    if (!warned.has(key)) {
      warned.add(key);
      warn(
        `[conversations] Signet ${signet.signetId} (revision ${signet.revision}) reaches no thread: ${reason}`,
      );
    }
    return null;
  };
  const layers = storedLensLayersSchema.safeParse(grant.lens ?? []);
  if (!layers.success) return refuse('its lens layers do not parse');
  const baseId = layers.data[0]?.parents[0];
  if (!baseId) return refuse('its lens names no base lens');
  const base = signet.baseLenses[baseId];
  if (!base) return refuse(`the snapshot carries no base lens ${baseId}`);
  const records: Record<string, StoredLens> = {
    [baseId]: { ...base, id: baseId, parents: [] },
  };
  for (const layer of layers.data) records[layer.id] = layer as StoredLens;
  try {
    return composeLens(layers.data.at(-1)!.id, records);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'its lens layers do not compose');
  }
}

/**
 * The Signet's `threads` row that reaches `threadId` for one of `operations`, or undefined. It is
 * the grantor's lens evaluated here, the same lens Kingdom enforces at admission: a `full` row
 * reaches every thread; otherwise the row's layers composed over their base must admit the
 * thread's row (`threadRow`). A row with a missing base or unreadable layers reaches nothing.
 */
export function grantReaches(
  signet: HostedSignet,
  threadId: string,
  operations: readonly ThreadOperation[] = threadOperationSchema.options,
  warn: (message: string) => void = console.warn,
): ThreadsGrant | undefined {
  let row: Record<string, unknown>;
  try {
    row = threadRow(threadId);
  } catch {
    return undefined;
  }
  for (const grant of signet.resources) {
    if (grant.resourceModel !== 'IntegrationResource' || grant.kind !== threadsResourceKind)
      continue;
    const scope = grant.full
      ? { full: true as const }
      : { full: false as const, operations: grant.operations ?? [] };
    if (!operations.some((operation) => permitsOperation(scope, operation))) continue;
    if (grant.full) return grant;
    const lens = composedLens(signet, grant, warn);
    if (lens && check(narrowRule(true, lens), row) === true) return grant;
  }
  return undefined;
}
