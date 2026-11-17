/**
 * @atlas
 * @kind helper
 * @partOf feature:composition
 */
import { ROLE_NAMESPACE_SEPARATOR } from '@inixiative/foundry-core';

/**
 * The namespaces a role id carries, and the only place they are written (as template's
 * `redisNamespace` is for Redis keys). Every role id is `<namespace>:<name>`, built by `roleIdIn`;
 * none is bare, so a role of one kind can never take the id of another (Aron, 2026-11-16, after a
 * region named `feedback` took the Feedback scope role's bare id and no Foundry with that project
 * could boot: "we should really be using prefixes… such that we can't have this on pure names").
 * A role's files nest by namespace: `.foundry/roles/<namespace>/<name>/`.
 */
export const roleNamespace = Object.freeze({
  /** A main thread's role: the built-in `coder` and `assistant`, the shared base `main`, and the user's own. */
  thread: 'thread',
  /** The role that holds one of Foundry's own scopes (Forge Master, Feedback). */
  scope: 'scope',
  /**
   * A project's region: its Warden's agent and role id, and the source ids of its docs (two id
   * spaces, agents and sources, that never meet). `<name>` is the region id.
   */
  region: 'region',
  /** An agent written in settings (the Cartographer and the like): `<name>` is its key in `agents`. */
  agent: 'agent',
} as const);
export type RoleNamespace = (typeof roleNamespace)[keyof typeof roleNamespace];

const NAMESPACES: readonly string[] = Object.values(roleNamespace);

/** The role id of `name` in `namespace`. */
export const roleIdIn = (namespace: RoleNamespace, name: string): string =>
  `${namespace}${ROLE_NAMESPACE_SEPARATOR}${name}`;

/** The name a role id carries in `namespace`, or undefined when it is not of that namespace. */
export const roleNameIn = (namespace: RoleNamespace, roleId: string): string | undefined =>
  roleId.startsWith(`${namespace}${ROLE_NAMESPACE_SEPARATOR}`)
    ? roleId.slice(namespace.length + ROLE_NAMESPACE_SEPARATOR.length)
    : undefined;

/** The namespace a role id carries, or undefined for a bare name or an unknown prefix. */
export const namespaceOfRoleId = (roleId: string): RoleNamespace | undefined => {
  const at = roleId.indexOf(ROLE_NAMESPACE_SEPARATOR);
  const namespace = at > 0 ? roleId.slice(0, at) : undefined;
  return namespace && NAMESPACES.includes(namespace) ? (namespace as RoleNamespace) : undefined;
};

/**
 * An agent's role id: a written agent (a bare key in `agents`, which may carry no namespace) is
 * `agent:<key>`; a generated agent already carries its namespaced id (a region Warden's
 * `region:<id>`), which is its role.
 */
export const roleIdOfAgent = (agentId: string): string =>
  namespaceOfRoleId(agentId) ? agentId : roleIdIn(roleNamespace.agent, agentId);

/** The agent whose role `roleId` is: `agent:<key>`'s key, a generated agent's own id, else none. */
export const agentIdOfRole = (roleId: string): string | undefined => {
  const namespace = namespaceOfRoleId(roleId);
  if (namespace === roleNamespace.agent) return roleNameIn(roleNamespace.agent, roleId);
  return namespace === roleNamespace.region ? roleId : undefined;
};

const ID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** Whether `value` is a legal name for an id: a region's, a domain's, one part of a role id. Safe as a folder name. */
export const isIdName = (value: unknown): value is string =>
  typeof value === 'string' && ID_NAME.test(value) && !value.includes('..');

/** Whether `value` is a legal role id: `<namespace>:<name>`, the namespace one of `roleNamespace`'s. */
export const isRoleId = (value: unknown): value is string => {
  if (typeof value !== 'string' || !namespaceOfRoleId(value)) return false;
  const name = value.slice(value.indexOf(ROLE_NAMESPACE_SEPARATOR) + 1);
  return isIdName(name);
};

/**
 * Why `role` is not a role id, with the fix. A bare name that is the name of a role in `known` (the
 * built-ins, say) is pointed at that role; another says which namespaces it may take.
 */
export const roleIdProblem = (role: string, known: readonly string[] = []): string | undefined => {
  const valid: boolean = isRoleId(role);
  if (valid) return undefined;
  const named = known.filter((id) => id.slice(id.indexOf(ROLE_NAMESPACE_SEPARATOR) + 1) === role);
  if (named.length)
    return `"${role}" is a bare name; a role id carries its namespace: write ${named.map((id) => `"${id}"`).join(' or ')}`;
  if (!role.includes(ROLE_NAMESPACE_SEPARATOR) && isIdName(role))
    return `"${role}" is a bare name; a role id carries its namespace: write "${roleIdIn(roleNamespace.thread, role)}" for a thread role, "${roleIdIn(roleNamespace.agent, role)}" for the agent "${role}"`;
  return `"${role}" is not a role id: <namespace>:<name>, the namespace one of ${NAMESPACES.join(', ')}`;
};
