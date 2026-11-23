/**
 * @atlas
 * @kind middleware
 * @partOf feature:viewer
 */
/** The host names this machine answers to itself on. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Headers a proxy adds: a request carrying one came through a proxy, not from this machine. */
const PROXY_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
  'true-client-ip',
  'via',
];

/** A request made on this machine itself: a loopback host, through no proxy. */
export function directLoopback(request: Request): boolean {
  return (
    LOOPBACK_HOSTS.includes(new URL(request.url).hostname) &&
    !PROXY_HEADERS.some((header) => request.headers.has(header))
  );
}

/** A request with no Origin, or one from the address it was made to. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const url = new URL(request.url);
  url.protocol =
    url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return origin === url.origin;
}
