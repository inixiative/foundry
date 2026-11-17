/**
 * @atlas
 * @kind middleware
 * @partOf feature:viewer
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'foundry_session';
const lifetime = 86400000;
const signature = (token: string, expiry: number) =>
  createHmac('sha256', token).update(`foundry-session:${expiry}`).digest('hex');
export const sessionValue = (token: string, now = Date.now()) => {
  const expiry = now + lifetime;
  return `${expiry}.${signature(token, expiry)}`;
};

export function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The host names this machine answers to itself on. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Headers a proxy adds: a request carrying one came through a tunnel, not from this machine. */
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

export function sameOrigin(request: Request, publicOrigin?: string): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const url = new URL(request.url);
  url.protocol =
    url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return origin === url.origin || (!!publicOrigin && origin === new URL(publicOrigin).origin);
}

export function authenticatedRequest(
  request: Request,
  token: string,
  publicOrigin?: string,
): boolean {
  if (!sameOrigin(request, publicOrigin)) return false;
  const authorization = request.headers.get('authorization');
  if (authorization) return sameSecret(authorization, `Bearer ${token}`);
  const cookie = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!cookie) return false;
  const [expiryText, mac, extra] = cookie.split('.');
  const expiry = Number(expiryText),
    now = Date.now();
  return (
    !extra &&
    !!mac &&
    Number.isSafeInteger(expiry) &&
    expiry > now &&
    expiry <= now + lifetime &&
    sameSecret(mac, signature(token, expiry))
  );
}
