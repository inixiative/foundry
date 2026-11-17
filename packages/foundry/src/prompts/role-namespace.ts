/**
 * @atlas
 * @kind helper
 * @partOf feature:composition
 */
import { ROLE_NAMESPACE_SEPARATOR } from '@inixiative/foundry-core';

/**
 * The namespaces a role id may carry, and the only place they are written (as template's
 * `redisNamespace` is for Redis keys). A role id is `<namespace>:<name>`, built by `roleIdIn`, so a
 * role of one kind can never take the id of another (a region named `feedback` took the Feedback
 * scope role's id while both were bare names, and no Foundry with that project could boot).
 */
export const roleNamespace = Object.freeze({
  /**
   * A project's region: its Warden's agent and role id, and the source ids of its docs (two id
   * spaces, agents and sources, that never meet). `<name>` is the region id.
   */
  region: 'region',
} as const);
export type RoleNamespace = (typeof roleNamespace)[keyof typeof roleNamespace];

/** The role id of `name` in `namespace`. */
export const roleIdIn = (namespace: RoleNamespace, name: string): string =>
  `${namespace}${ROLE_NAMESPACE_SEPARATOR}${name}`;

/** The name a role id carries in `namespace`, or undefined when it is not of that namespace. */
export const roleNameIn = (namespace: RoleNamespace, roleId: string): string | undefined =>
  roleId.startsWith(`${namespace}${ROLE_NAMESPACE_SEPARATOR}`)
    ? roleId.slice(namespace.length + ROLE_NAMESPACE_SEPARATOR.length)
    : undefined;

const ID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** Whether `value` is a legal name for an id: a region's, a domain's, one part of a role id. Safe as a folder name. */
export const isIdName = (value: unknown): value is string =>
  typeof value === 'string' && ID_NAME.test(value) && !value.includes('..');

/** Whether `value` is a legal role id: a name, or `<namespace>:<name>`. */
export const isRoleId = (value: unknown): value is string =>
  typeof value === 'string' && value.split(ROLE_NAMESPACE_SEPARATOR).every(isIdName);
