// A `fetch` seam backed by queued cassettes, in the template's captureResponse shape:
// status, headers and body, plus the request that produced them for review.
import { VCR, type Fixture } from "./vcr";
import { scrubText, scrubValue } from "./scrub";

export type RecordedRequest = { method: string; path: string; headers: Record<string, string>; body?: unknown };
export type HttpFixture = Fixture & { request?: RecordedRequest };

const KEPT_RESPONSE_HEADERS = ["content-type"];
const parseBody = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };

function describe(input: string | URL | Request, init?: RequestInit): RecordedRequest {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input));
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? request?.headers).forEach((value, key) => { headers[key] = value; });
  const body = typeof init?.body === "string" ? parseBody(init.body) : undefined;
  return scrubValue({ method: (init?.method ?? request?.method ?? "GET").toUpperCase(), path: `${url.pathname}${url.search}`,
    headers, ...(body === undefined ? {} : { body }) });
}

export function httpCassettes(vcr: VCR, method: string): typeof fetch {
  const recordedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = vcr.popFixturePath(method);
    if (vcr.mode === "replay") {
      const saved = vcr.load(path) as HttpFixture;
      const now = describe(input, init);
      if (saved.request && (saved.request.method !== now.method || saved.request.path !== now.path))
        throw Error(`VCR replay: ${now.method} ${now.path} was recorded as ${saved.request.method} ${saved.request.path}; re-record with \`bun run test:live\``);
      const body = saved.body === undefined || saved.body === null ? null
        : typeof saved.body === "string" ? saved.body : JSON.stringify(saved.body);
      return new Response(body, { status: saved.status, headers: saved.headers });
    }
    VCR.spendLive(`${vcr.service} ${method}`);
    const request = describe(input, init);
    const started = Date.now();
    const response = await fetch(input, init);
    const text = await response.text();
    const headers: Record<string, string> = {};
    for (const key of KEPT_RESPONSE_HEADERS) { const value = response.headers.get(key); if (value) headers[key] = value; }
    await vcr.store(path, { status: response.status, headers, body: scrubValue(parseBody(text)), request } as HttpFixture,
      { durationMs: Date.now() - started });
    return new Response(response.status === 204 || response.status === 304 ? null : text, { status: response.status, headers: response.headers });
  };
  return Object.assign(recordedFetch, { preconnect: fetch.preconnect }) as typeof fetch;
}

/** For callers that only need the origin out of a recording. */
export const scrubOrigin = (url: string) => scrubText(new URL(url).origin);
