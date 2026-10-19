/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, integration:kingdom
 */
/** Names from a paired Kingdom's holder description (GET /api/kingdom/status → integrations[].holder). */

/** The person a paired Kingdom says holds this Foundry: the owner when a person, else who approved it. */
export const operatorOf = (holder) => holder?.owner?.user ?? holder?.issuedBy ?? null;

/** The owner's display name: its organization, space, own name, or person. */
export const ownerName = (holder) =>
  holder?.owner?.organization?.name ??
  holder?.owner?.space?.name ??
  holder?.owner?.name ??
  holder?.owner?.user?.name ??
  null;
