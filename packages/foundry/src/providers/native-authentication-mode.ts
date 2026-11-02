/**
 * @atlas
 * @kind config
 * @partOf feature:nativeAuth
 */
import type { FoundryConfig } from '../viewer/config';

type AuthenticationConfig = Pick<
  FoundryConfig,
  | 'defaults'
  | 'kingdomInferenceAssignments'
  | 'nativeAuthenticationSelections'
  | 'projects'
  | 'subscriptionOnly'
  | 'apiTokens'
>;

/**
 * Which login a main thread's native session runs on, by the one rule start.ts builds it with:
 * the subscription policy when it holds (decided by the caller, which resolves it), else Kingdom
 * bindings when an owner or a per-thread assignment is set, else this machine's selected native
 * profiles, else the user's own login. A project with `capacity: "kingdom"` runs on a Kingdom pool
 * whatever the rest says (`projectRunsOnKingdom`).
 */
export type NativeAuthenticationMode = 'kingdom' | 'native-profile' | 'user';

export function nativeAuthenticationMode(config: AuthenticationConfig): NativeAuthenticationMode {
  if (
    config.defaults.kingdomOwnerKey ||
    Object.keys(config.kingdomInferenceAssignments ?? {}).length
  )
    return 'kingdom';
  if (
    config.defaults.nativeAuthenticationId ||
    Object.keys(config.nativeAuthenticationSelections ?? {}).length
  )
    return 'native-profile';
  return 'user';
}

/** A project whose threads take a Kingdom capacity pool's login, not this machine's. */
export const projectRunsOnKingdom = (config: AuthenticationConfig, projectId?: string) =>
  !!projectId && config.projects?.[projectId]?.capacity === 'kingdom';
