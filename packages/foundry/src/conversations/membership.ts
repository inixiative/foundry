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
 * Which of a Signet's rows reach thread T (Aron, 2026-11-14: a conversation is an integration
 * resource, one per shared thread, its `externalId` the thread's id; per-conversation is the usual
 * grant, "but if you want to, you can do project-scoped, the whole Foundry, or the whole integration
 * level"). The snapshot lists only rows on this Foundry's own integrations (signet
 * `hostedSignetSchema`). `rows` reach T on their face: a `conversation` resource row for T, or a
 * `conversation` scope row over the integration. `conditional` are scope rows over this Foundry's
 * conversations the host cannot evaluate, narrowed to a Kingdom project or by a `where`:
 * Kingdom decides them at admission and a holder never gates on them, so they reach T only once
 * Kingdom has relayed a frame from the Signet for T.
 */
export function conversationRows(
  signet: HostedSignet,
  threadId: string,
): { rows: ConversationRow[]; conditional: ConversationRow[] } {
  const rows: ConversationRow[] = [];
  const conditional: ConversationRow[] = [];
  for (const grant of signet.resources) {
    if (grant.resourceModel === 'Project' || grant.kind !== conversationResourceKind) continue;
    if (grant.resourceModel === 'IntegrationResource') {
      if (grant.externalId === threadId) rows.push(grant);
    } else if (grant.projectId === undefined && grant.where === undefined) rows.push(grant);
    else conditional.push(grant);
  }
  return { rows, conditional };
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
