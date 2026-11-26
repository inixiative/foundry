/**
 * @atlas
 * @kind client
 * @partOf feature:wardens
 */
import { operationResponseFrameSchema } from '@inixiative/signet';
import type { ChorusCallOutcome, ChorusTransport } from './chorus-client';

const errorOf = (body: unknown): string | undefined =>
  body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : undefined;

/**
 * Dev mode's transport (R-2026-11-25-05): `POST {url}/operations/<op>` with `{ projectId, input }` and
 * the dev token as a bearer, straight to a Chorus host, no Kingdom. The host answers the outcome
 * (`200`, or `500` for a handler's invalid one); a `400` is its `invalid_request`; any other status, a
 * network error, a timeout or a body off the contract is a failure with its reason.
 */
export function directChorusTransport(
  base: string,
  token: () => Promise<string | undefined>,
): ChorusTransport {
  return async (operation, call, timeoutMs) => {
    const bearer = await token();
    if (!bearer)
      return {
        ok: false,
        failure: 'no-token',
        message: 'no Chorus dev token in the keychain or environment',
      };
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(`${base}/operations/${operation}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify(call),
      });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      const timedOut = (error as Error)?.name === 'TimeoutError';
      return timedOut
        ? { ok: false, failure: 'timeout', message: `Chorus did not answer within ${timeoutMs}ms` }
        : {
            ok: false,
            failure: 'unreachable',
            message: `Chorus at ${base} unreachable: ${String((error as Error)?.message ?? error).slice(0, 300)}`,
          };
    }
    if (response.status === 400)
      return {
        ok: false,
        refusal: 'invalid_request',
        message: 'Chorus refused the request as invalid',
      };
    if (response.status !== 200 && response.status !== 500)
      return {
        ok: false,
        failure: 'rejected',
        message: `Chorus answered ${response.status}${errorOf(body) ? ` (${errorOf(body)})` : ''}`,
      };
    const frame = operationResponseFrameSchema(operation).safeParse({
      action: 'operation.response',
      requestId: crypto.randomUUID(),
      outcome: body,
    });
    if (!frame.success)
      return {
        ok: false,
        failure: 'invalid-response',
        message: `Chorus's ${operation} answer is not the contract's outcome`,
      };
    // why: the frame's refusal codes are the operation's own, all of them Chorus refusals.
    return frame.data.outcome as ChorusCallOutcome<typeof operation>;
  };
}
