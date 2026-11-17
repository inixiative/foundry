/**
 * @atlas
 * @kind helper
 * @partOf feature:composition
 */

/**
 * The namespaces a role id may carry, and the only place they are written (as template's
 * `redisNamespace` is for Redis keys). A role id is `<namespace>:<name>`, built by `roleIdIn`, so a
 * role of one kind can never take the id of another (a region named `feedback` took the Feedback
 * scope role's id while both were bare names, and no Foundry with that project could boot).
 */
export const roleNamespace = Object.freeze({
  /** A region Warden, generated from a project's region (`<name>` is the region id). */
  region: 'region',
} as const);
export type RoleNamespace = (typeof roleNamespace)[keyof typeof roleNamespace];

const NAMESPACE_SEPARATOR = ':';

/** The role id of `name` in `namespace`. */
export const roleIdIn = (namespace: RoleNamespace, name: string): string =>
  `${namespace}${NAMESPACE_SEPARATOR}${name}`;

/** The name a role id carries in `namespace`, or undefined when it is not of that namespace. */
export const roleNameIn = (namespace: RoleNamespace, roleId: string): string | undefined =>
  roleId.startsWith(`${namespace}${NAMESPACE_SEPARATOR}`)
    ? roleId.slice(namespace.length + NAMESPACE_SEPARATOR.length)
    : undefined;

const ROLE_ID_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** Whether `value` is a legal role id: a name, or `<namespace>:<name>`, each part one safe folder name. */
export const isRoleId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.split(NAMESPACE_SEPARATOR).every((part) => ROLE_ID_PART.test(part) && !part.includes('..'));
