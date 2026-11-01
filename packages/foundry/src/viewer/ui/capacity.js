/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/** Accounts grouped by provider: how many are ready, and the subscriptions behind them. */
export function capacityByProvider(accounts) {
  const groups = new Map();
  // What this machine can run on: subscriptions that are ready or in use; not every switched-on vendor.
  const usable = (Array.isArray(accounts) ? accounts : []).filter(
    (a) => a.ready || (a.uses?.length ?? 0) > 0,
  );
  for (const account of usable) {
    const group = groups.get(account.provider) ?? {
      provider: account.provider,
      ready: 0,
      accounts: [],
    };
    group.accounts.push(account);
    if (account.ready) group.ready += 1;
    groups.set(account.provider, group);
  }
  return [...groups.values()];
}
