import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, sessionValue } from './request-auth';

// Kingdom holds this Foundry's tunnel token as a Credential and never hands it out.
// To send someone here it mints a short-lived, single-use code over that token; the
// token itself never reaches a URL, a browser history or a proxy log.
export const HANDOFF_WINDOW_MS = 120_000;

const mac = (token: string, expiry: number, nonce: string) =>
  createHmac('sha256', token).update(`foundry-handoff:${expiry}:${nonce}`).digest('hex');

export const mintHandoffCode = (token: string, now = Date.now()): string => {
  const expiry = now + HANDOFF_WINDOW_MS;
  const nonce = randomBytes(16).toString('hex');
  return `${expiry}.${nonce}.${mac(token, expiry, nonce)}`;
};

const equal = (actual: string, expected: string) => {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// A code is single use. Spent nonces are held only as long as a code could still be
// valid, so the set cannot grow without bound.
const spent = new Map<string, number>();
const forget = (now: number) => {
  for (const [nonce, expiry] of spent) if (expiry <= now) spent.delete(nonce);
};

export const redeemHandoffCode = (code: string, token: string, now = Date.now()): boolean => {
  const [expiryText, nonce, signature, extra] = code.split('.');
  if (extra !== undefined || !expiryText || !nonce || !signature) return false;
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + HANDOFF_WINDOW_MS)
    return false;
  if (!equal(signature, mac(token, expiry, nonce))) return false;
  forget(now);
  if (spent.has(nonce)) return false;
  spent.set(nonce, expiry);
  return true;
};

// A handoff exists to be opened inside Kingdom, so its cookie must survive a
// cross-site navigation: SameSite=None. Mutating routes stay protected by the
// Origin check in request-auth, which browsers send on every cross-site write.
export const handoffCookie = (token: string, now = Date.now()): string =>
  `${SESSION_COOKIE}=${sessionValue(token, now)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`;
