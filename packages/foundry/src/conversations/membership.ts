/**
 * @atlas
 * @kind utils
 * @partOf feature:conversations
 */
import {
  type ConversationPermission,
  conversationPermissionSchema,
  conversationResourceKind,
  type HostedSignet,
  type OperationScope,
  permitsOperation,
  type SignetGrant,
} from '@inixiative/signet';

/** A grant row that can reach a conversation: one resource, or a scope of them. */
export type ConversationRow = Exclude<SignetGrant, { resourceModel: 'Project' }>;

/**
 * A Signet's rows on this Foundry's conversations, for thread T (Aron, 2026-11-14: a conversation is
 * an integration resource, one per shared thread, its `externalId` the thread's id; per-conversation
 * is the usual grant, "but if you want to, you can do project-scoped, the whole Foundry, or the
 * whole integration level"). The snapshot lists only rows on this Foundry's own integrations (signet
 * `hostedSignetSchema`). `face` reach T on their face: `conversation` resource rows for T. `scoped`
 * are `conversation` scope rows: what a scope row reaches is Kingdom's to answer (its project, its
 * `where`, its lens), never the host's, so a scope row reaches T only through a frame Kingdom
 * relayed for T, and the host never reads permissions off it.
 */
export function conversationRows(
  signet: HostedSignet,
  threadId: string,
): { face: ConversationRow[]; scoped: ConversationRow[] } {
  const face: ConversationRow[] = [];
  const scoped: ConversationRow[] = [];
  for (const grant of signet.resources) {
    if (grant.resourceModel === 'Project' || grant.kind !== conversationResourceKind) continue;
    if (grant.resourceModel === 'Integration') scoped.push(grant);
    else if (grant.externalId === threadId) face.push(grant);
  }
  return { face, scoped };
}

/** The threads a Signet's `conversation` resource rows name, and whether it holds a scope row. */
export function conversationHoldings(signet: HostedSignet): { face: Set<string>; scoped: boolean } {
  const face = new Set<string>();
  let scoped = false;
  for (const grant of signet.resources)
    if (grant.resourceModel !== 'Project' && grant.kind === conversationResourceKind) {
      if (grant.resourceModel === 'Integration') scoped = true;
      else face.add(grant.externalId);
    }
  return { face, scoped };
}

export const rowScope = (row: ConversationRow): OperationScope =>
  row.full ? { full: true } : { full: false, operations: row.operations ?? [] };

/** Whether any of the rows permits one of the operations (`full`, or a picked leaf). */
export const rowsPermit = (rows: readonly ConversationRow[], operations: readonly string[]) =>
  rows.some((row) => operations.some((operation) => permitsOperation(rowScope(row), operation)));

/** The conversation permissions the rows hold together: every one on a `full` row, else the picked leaves. */
export const rowPermissions = (rows: readonly ConversationRow[]): ConversationPermission[] =>
  conversationPermissionSchema.options.filter((permission) => rowsPermit(rows, [permission]));

/** `thread`: it reads the whole conversation (`member.log`); `own`: its posts and the sends to it. */
export const memberReads = (permissions: readonly ConversationPermission[]) =>
  permissions.includes('member.log') ? ('thread' as const) : ('own' as const);

/** `turn`: its posts wake the host's agent (`member.wake`); `note`: they ride its next turn. */
export const memberDelivery = (permissions: readonly ConversationPermission[]) =>
  permissions.includes('member.wake') ? ('turn' as const) : ('note' as const);
