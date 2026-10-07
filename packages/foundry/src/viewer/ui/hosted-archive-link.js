/** Kingdom's API redirects /dashboard to its web dashboard; only https or a loopback Kingdom is linked. */
export const hostedSetupUrl = (kingdomUrl) => {
  try {
    const origin = new URL(kingdomUrl);
    const local =
      origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
    if (origin.protocol !== 'https:' && !local) return null;
    return new URL('/dashboard?setupArchive=1', origin).toString();
  } catch {
    return null;
  }
};
