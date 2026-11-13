/**
 * @atlas
 * @kind utils
 * @partOf feature:conversations
 */
import {
  type Condition,
  check,
  composeLens,
  type Lens,
  type LensNarrowing,
  projectRows,
  type StoredLens,
} from '@inixiative/json-rules';
import {
  baseLensId,
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

/** The id of the operations lens every `threads` grant's layers are chained under. */
const threadsBaseId = baseLensId('foundry', threadsResourceKind);

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
  const unchained = layers.data.find((layer, index) => {
    const chain = [threadsBaseId, ...layers.data.slice(0, index).map((earlier) => earlier.id)];
    return (
      layer.parents.length !== chain.length || layer.parents.some((id, at) => id !== chain[at])
    );
  });
  if (unchained) return refuse(`lens layer ${unchained.id} is not chained under ${threadsBaseId}`);
  const base = signet.baseLenses[threadsBaseId];
  if (!base) return refuse(`the snapshot carries no base lens ${threadsBaseId}`);
  const records: Record<string, StoredLens> = {
    [threadsBaseId]: { ...base, id: threadsBaseId, parents: [] } as StoredLens,
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

/** Whether the grant's incoming `where` admits a call on `threadId`; a where that throws admits none. */
const whereAdmits = (grant: ThreadsGrant, threadId: string) => {
  if (grant.where === undefined) return true;
  try {
    return check(grant.where as Condition, { threadId }, { absent: 'unknown' }) === true;
  } catch {
    return false;
  }
};

/**
 * The Signet's `threads` row that reaches `threadId` for one of `operations`, or undefined. It is
 * the grantor's terms evaluated here, as Kingdom enforces them at admission: the row must permit
 * the operation, its incoming `where` must hold on the call's `threadId` (a field it reads beyond
 * that is unknown, so it does not hold), and the thread's row (`threadRow`) must survive the lens
 * at that operation's branch (`operationRecord`). A row with no layers reaches every thread its
 * `where` admits; a row whose layers are not chained under the threads base and each earlier layer
 * in order, whose base is missing, or whose layers are unreadable reaches nothing.
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
    if (!permitted.length || !whereAdmits(grant, threadId)) continue;
    const lens = composedLens(signet, grant, warn);
    if (lens === 'every') return grant;
    if (lens && permitted.some((operation) => reachesAt(lens, operation, row))) return grant;
  }
  return undefined;
}
