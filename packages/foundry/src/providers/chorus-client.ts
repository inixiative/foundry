/**
 * @atlas
 * @kind client
 * @partOf feature:wardens
 */
import {
  type ChorusOperation,
  type ChorusRefusal,
  chorusOperationTimeoutMs,
  type RelayedOperationInput,
  type RelayedOperationResult,
  relayedOperationInputSchemas,
} from '@inixiative/signet';

/**
 * A call that never brought back a Chorus outcome: no token to send it with, no answer in time, the
 * host could not be reached, it turned the request away (`401`, `404`), or what it answered was not
 * the contract's outcome.
 */
export interface ChorusFailure {
  readonly ok: false;
  readonly failure: 'no-token' | 'timeout' | 'unreachable' | 'rejected' | 'invalid-response';
  readonly message: string;
}

/** What one Chorus call ended with: the host's result or refusal, or why it brought back neither. */
export type ChorusCallOutcome<O extends ChorusOperation> =
  | { readonly ok: true; readonly result: RelayedOperationResult<O> }
  | { readonly ok: false; readonly refusal: ChorusRefusal; readonly message?: string }
  | ChorusFailure;

/**
 * How a call reaches a Chorus host: over Kingdom's relay, or straight to its URL in dev mode
 * (`directChorusTransport`). Either way the call is the signet `chorus.*` operation and its outcome.
 */
export type ChorusTransport = <O extends ChorusOperation>(
  operation: O,
  call: { readonly projectId: string; readonly input: RelayedOperationInput<O> },
  timeoutMs: number,
) => Promise<ChorusCallOutcome<O>>;

/** One project's Chorus, served elsewhere: the Wardens' every call is a `chorus.*` operation on it. */
export interface ChorusRemote {
  /** The project id the host knows this project by (its `config.projects` key). */
  readonly projectId: string;
  /** Where it is served from, as the viewer shows it. */
  readonly endpoint: string;
  call<O extends ChorusOperation>(
    operation: O,
    input: RelayedOperationInput<O>,
  ): Promise<ChorusCallOutcome<O>>;
}

/** The time past a call's own `deadlineMs` the host gets to answer: its fan-out settles, then it replies. */
const ANSWER_SLACK_MS = 5_000;

/**
 * A project's remote Chorus over `transport`. Every input is checked against its signet schema before
 * it leaves (a bad one is `invalid_request`, never sent); a call waits its `deadlineMs` and a few seconds
 * more, or the operation's own timeout when it has none.
 */
export function createChorusRemote(options: {
  readonly projectId: string;
  readonly endpoint: string;
  readonly transport: ChorusTransport;
}): ChorusRemote {
  return {
    projectId: options.projectId,
    endpoint: options.endpoint,
    async call(operation, input) {
      const parsed = relayedOperationInputSchemas[operation].safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          refusal: 'invalid_request',
          message: parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
            .join('; ')
            .slice(0, 500),
        };
      const deadlineMs = (input as { deadlineMs?: number }).deadlineMs;
      const timeoutMs =
        deadlineMs === undefined
          ? chorusOperationTimeoutMs[operation]
          : deadlineMs + ANSWER_SLACK_MS;
      return options.transport(operation, { projectId: options.projectId, input }, timeoutMs);
    },
  };
}
