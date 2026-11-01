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

/**
 * The Kingdom owner a project's threads belong to, when the project runs on a Kingdom pool
 * (`capacity: 'kingdom'`): the paired Kingdom it names, by id or by origin when only one pairing has
 * that origin. Null when the project runs on this machine's login or the pairing isn't listed.
 */
export function kingdomOwnerOf(config, status, projectId) {
  const project = config?.projects?.[projectId];
  const key = project?.capacity === 'kingdom' ? project.kingdomCapacity?.kingdom : null;
  if (!key) return null;
  const integrations = status?.integrations ?? [];
  const byId = integrations.find((i) => i.id === key);
  const byUrl = integrations.filter((i) => i.url === key || i.url === key.replace(/\/+$/, ''));
  const match = byId ?? (byUrl.length === 1 ? byUrl[0] : null);
  return match ? ownerName(match.holder) : null;
}
