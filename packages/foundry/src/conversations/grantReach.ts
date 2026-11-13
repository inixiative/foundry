/**
 * @atlas
 * @kind utils
 * @partOf feature:conversations
 */
import {
  composeLens,
  type Lens,
  type LensNarrowing,
  projectRows,
  type StoredLens,
} from '@inixiative/json-rules';
import {
  type HostedSignet,
  operationRecord,
  operationRows,
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

/**
 * The grantor's lens for one row: its layers composed over the kind's operations lens; `every` when
 * it has no layers (it reads every branch), null when it can't be read.
 */
function composedLens(
  signet: HostedSignet,
  grant: ThreadsGrant,
  warn: (message: string) => void,
): Lens | LensNarrowing | 'every' | null {
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
  const last = layers.data.at(-1);
  if (!last) return 'every';
  const baseId = layers.data[0]!.parents[0]!;
  const base = signet.baseLenses[baseId];
  if (!base) return refuse(`the snapshot carries no base lens ${baseId}`);
  const records: Record<string, StoredLens> = {
    [baseId]: { ...base, id: baseId, parents: [] } as StoredLens,
  };
  for (const layer of layers.data) records[layer.id] = layer as StoredLens;
  try {
    return composeLens(last.id, records);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'its lens layers do not compose');
  }
}

/** Whether the thread's row survives the lens at the operation's branch of the operations lens. */
const reachesAt = (
  lens: Lens | LensNarrowing,
  operation: ThreadOperation,
  row: Record<string, unknown>,
) => {
  const [projected] = projectRows(lens, [operationRecord(operation, [row])]);
  return operationRows(projected, operation).length > 0;
};

/**
 * The Signet's `threads` row that reaches `threadId` for one of `operations`, or undefined. It is
 * the grantor's lens evaluated here, the same lens Kingdom enforces at admission: the row must
 * permit the operation, and the thread's row (`threadRow`) must survive the lens at that
 * operation's branch (`operationRecord`). A row with no layers reaches every thread; a row with a
 * missing base or unreadable layers reaches nothing. The grant's incoming `where` is Kingdom's to
 * check: a hosted Signet's rows don't carry it, and the lens pins the same threads.
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
    const permitted = operations.filter((operation) => permitsOperation(scope, operation));
    if (!permitted.length) continue;
    const lens = composedLens(signet, grant, warn);
    if (lens === 'every') return grant;
    if (lens && permitted.some((operation) => reachesAt(lens, operation, row))) return grant;
  }
  return undefined;
}
