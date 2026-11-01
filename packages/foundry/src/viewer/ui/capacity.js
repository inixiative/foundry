/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Accounts grouped by vendor (`nameOf` maps a provider id to its vendor: Claude Code and the Anthropic
 * API are both Anthropic): how many are ready, and the subscriptions behind them.
 */
export function capacityByProvider(accounts, nameOf = (provider) => provider) {
  const groups = new Map();
  // What this machine can run on: subscriptions that are ready or in use; not every switched-on vendor.
  const usable = (Array.isArray(accounts) ? accounts : []).filter(
    (a) => a.ready || (a.uses?.length ?? 0) > 0,
  );
  for (const account of usable) {
    const name = nameOf(account.provider) ?? account.provider;
    const group = groups.get(name) ?? {
      provider: name,
      ready: 0,
      accounts: [],
    };
    group.accounts.push(account);
    if (account.ready) group.ready += 1;
    groups.set(name, group);
  }
  return [...groups.values()];
}
