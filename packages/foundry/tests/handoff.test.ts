import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  HANDOFF_WINDOW_MS,
  handoffCookie,
  mintHandoffCode,
  redeemHandoffCode,
} from '../src/viewer/handoff';
import { tunnelAuth } from '../src/viewer/tunnel';

const token = 'f'.repeat(48);

describe('kingdom handoff codes', () => {
  it('redeems a freshly minted code', () => {
    expect(redeemHandoffCode(mintHandoffCode(token), token)).toBe(true);
  });

  it('refuses a code a second time', () => {
    const code = mintHandoffCode(token);
    expect(redeemHandoffCode(code, token)).toBe(true);
    expect(redeemHandoffCode(code, token)).toBe(false);
  });

  it('refuses a code minted from another token', () => {
    expect(redeemHandoffCode(mintHandoffCode('a'.repeat(48)), token)).toBe(false);
  });

  it('refuses a code past its window', () => {
    const issued = Date.now();
    const code = mintHandoffCode(token, issued);
    expect(redeemHandoffCode(code, token, issued + HANDOFF_WINDOW_MS + 1)).toBe(false);
  });

  it('refuses a code whose expiry was pushed into the future', () => {
    const [, nonce, signature] = mintHandoffCode(token).split('.');
    const forged = `${Date.now() + HANDOFF_WINDOW_MS * 10}.${nonce}.${signature}`;
    expect(redeemHandoffCode(forged, token)).toBe(false);
  });

  it('refuses a malformed code without throwing', () => {
    for (const code of ['', 'x', '1.2', '1.2.3.4', `${Date.now() + 1000}..`])
      expect(redeemHandoffCode(code, token)).toBe(false);
  });

  it('forgets spent nonces once they could no longer be valid', () => {
    const issued = Date.now();
    const code = mintHandoffCode(token, issued);
    expect(redeemHandoffCode(code, token, issued)).toBe(true);
    // A later redemption sweeps the expired nonce; a fresh code still works.
    const later = issued + HANDOFF_WINDOW_MS + 1;
    expect(redeemHandoffCode(mintHandoffCode(token, later), token, later)).toBe(true);
  });

  it('sets a cookie that survives being opened inside Kingdom', () => {
    const cookie = handoffCookie(token);
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain(token);
  });
});

const origin = 'https://foundry.example.com';
const app = () => {
  const instance = new Hono();
  instance.use('*', tunnelAuth(token, origin));
  instance.get('/', (c) => c.text('viewer'));
  return instance;
};
const ask = (headers: Record<string, string> = {}) =>
  app().request(`${origin}/api/handoff`, { method: 'POST', headers: { origin, ...headers } });

describe('the handoff endpoint Kingdom calls', () => {
  it('refuses a caller without the credential', async () => {
    expect((await ask()).status).toBe(401);
  });

  it('returns a link that redeems once, to a caller holding the credential', async () => {
    const response = await ask({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    const { url, expiresInMs } = (await response.json()) as { url: string; expiresInMs: number };
    expect(expiresInMs).toBe(HANDOFF_WINDOW_MS);
    expect(url.startsWith(`${origin}/auth/handoff?code=`)).toBe(true);
    expect(url).not.toContain(token);

    const code = new URL(url).searchParams.get('code') ?? '';
    const landing = await app().request(url, { headers: { accept: 'text/html' } });
    expect(landing.status).toBe(302);
    expect(landing.headers.get('location')).toBe('/');
    expect(landing.headers.get('set-cookie')).toContain('SameSite=None');

    // The same link a second time is refused rather than reused.
    expect(redeemHandoffCode(code, token)).toBe(false);
  });

  it('sends an unauthenticated browser to the login page, not the viewer', async () => {
    const response = await app().request(`${origin}/`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/auth');
  });
});
