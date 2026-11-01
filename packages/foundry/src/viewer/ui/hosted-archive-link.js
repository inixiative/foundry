/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, integration:archive
 */
/** Kingdom's API redirects /dashboard to its web dashboard; only https or a loopback Kingdom is linked. */
const dashboardUrl = (kingdomUrl, query) => {
  try {
    const origin = new URL(kingdomUrl);
    const local =
      origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
    if (origin.protocol !== 'https:' && !local) return null;
    return new URL(query ? `/dashboard?${query}` : '/dashboard', origin).toString();
  } catch {
    return null;
  }
};

export const hostedSetupUrl = (kingdomUrl) => dashboardUrl(kingdomUrl, 'setupArchive=1');

/** Kingdom's dashboard, whose Integrations tab is where GitHub, Linear and other accounts are added (no deep link to the tab exists). */
export const kingdomIntegrationsUrl = (kingdomUrl) => dashboardUrl(kingdomUrl, '');
