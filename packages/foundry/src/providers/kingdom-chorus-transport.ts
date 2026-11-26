/**
 * @atlas
 * @kind client
 * @partOf feature:wardens, integration:kingdom
 */
import { existsSync } from 'node:fs';
import {
  type AccessRequestInput,
  type ChorusOperation,
  type ChorusRefusal,
  chorusRefusalSchema,
  chorusResourceKind,
  kingdomUrl,
  type ParsedSignetDescription,
  type RelayedOperationResult,
  relayedOperationResultSchemas,
  SignetClient,
  SignetHttpError,
  type SignetRequestOptions,
  signetCredentialFile,
} from '@inixiative/signet';
import { ZodError } from 'zod';
import type { ChorusCallOutcome, ChorusTransport } from './chorus-client';
import {
  heldSignetFile,
  type KingdomInstallationConnections,
  type KingdomIntegration,
  kingdomInstallationPaths,
  kingdomIntegrationId,
} from './kingdom-installation-connection';

/** Minimal Signet client surface needed to discover and invoke Chorus operations via Kingdom. */
export interface SignetAccessHandle {
  readonly signetId: string;
  describe(options?: SignetRequestOptions): Promise<ParsedSignetDescription>;
  execute(
    request: Omit<AccessRequestInput, 'requestId' | 'signetId'>,
    options?: SignetRequestOptions,
  ): Promise<{ executionId: string; result: unknown }>;
}

export interface KingdomChorusTransportOptions {
  readonly endpoint: string;
  readonly signets: () => Promise<readonly SignetAccessHandle[]>;
}

export interface KingdomChorusTransportHandle {
  readonly transport: ChorusTransport;
  /** Drop cached `access/describe` results (call when Kingdom pushes a snapshot or grants change). */
  invalidate(): void;
}

type ResolvedChorusGrant = {
  readonly handle: SignetAccessHandle;
  readonly integrationId: string;
  readonly resourceId: string;
};

const isTimeoutError = (error: unknown): boolean =>
  (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';

const mapSignetHttpError = <O extends ChorusOperation>(
  error: SignetHttpError,
  timeoutMs: number,
): ChorusCallOutcome<O> => {
  if (error.refusal === 'host_timeout' || error.status === 504) {
    return {
      ok: false,
      failure: 'timeout',
      message:
        error.refusalMessage ?? error.detail ?? `Chorus did not answer within ${timeoutMs}ms`,
    };
  }
  if (error.refusal === 'host_offline' || error.refusal === 'host_unavailable') {
    return {
      ok: false,
      refusal: 'chorus_unavailable',
      message: error.refusalMessage ?? error.detail ?? error.refusal,
    };
  }
  if (error.refusal) {
    const parsedRefusal = chorusRefusalSchema.safeParse(error.refusal);
    if (parsedRefusal.success) {
      const message = error.refusalMessage ?? error.detail;
      return {
        ok: false,
        refusal: parsedRefusal.data as ChorusRefusal,
        ...(message ? { message } : {}),
      };
    }
  }
  return {
    ok: false,
    failure: 'rejected',
    message: error.detail ?? `Kingdom refused Chorus request (${error.status})`,
  };
};

const mapTransportError = <O extends ChorusOperation>(
  error: unknown,
  endpoint: string,
  timeoutMs: number,
): ChorusCallOutcome<O> => {
  if (error instanceof SignetHttpError) return mapSignetHttpError(error, timeoutMs);
  if (error instanceof ZodError) {
    return {
      ok: false,
      failure: 'invalid-response',
      message: `Kingdom response off contract: ${error.issues[0]?.message ?? error.message}`.slice(
        0,
        300,
      ),
    };
  }
  if (isTimeoutError(error)) {
    return {
      ok: false,
      failure: 'timeout',
      message: `Chorus via Kingdom did not answer within ${timeoutMs}ms`,
    };
  }
  return {
    ok: false,
    failure: 'unreachable',
    message: `Kingdom at ${endpoint} unreachable: ${String((error as Error)?.message ?? error).slice(0, 300)}`,
  };
};

/**
 * Hosted transport: executes `chorus.*` operations through Kingdom's `access/execute` relay using
 * a held Signet granted the project's Chorus resource (`kind: 'chorus'`, `externalId: projectId`).
 *
 * Caches `access/describe` per Signet with generation-guarded single-flight deduplication until
 * `invalidate()` is called or an unstructured `401`/`403` triggers one fresh re-discovery.
 */
export function createKingdomChorusTransport(
  options: KingdomChorusTransportOptions,
): KingdomChorusTransportHandle {
  let generation = 0;
  const descriptions = new Map<string, ParsedSignetDescription>();
  const inFlightDescribes = new Map<string, Promise<ParsedSignetDescription>>();

  const invalidate = () => {
    generation += 1;
    descriptions.clear();
    inFlightDescribes.clear();
  };

  const describeHandle = async (
    handle: SignetAccessHandle,
    signal: AbortSignal,
    timeoutMs: number,
    forceRefresh: boolean,
  ): Promise<ParsedSignetDescription> => {
    if (!forceRefresh) {
      const cached = descriptions.get(handle.signetId);
      if (cached) return cached;
    }
    const gen = generation;
    const key = `${gen}\u0000${handle.signetId}`;
    const pending = forceRefresh ? undefined : inFlightDescribes.get(key);
    if (pending) return pending;

    const load = (async () => {
      const description = await handle.describe({ signal, timeoutMs });
      if (gen === generation) descriptions.set(handle.signetId, description);
      return description;
    })();
    inFlightDescribes.set(key, load);
    try {
      return await load;
    } finally {
      if (inFlightDescribes.get(key) === load) inFlightDescribes.delete(key);
    }
  };

  const matchGrant = (
    handle: SignetAccessHandle,
    description: ParsedSignetDescription,
    operation: ChorusOperation,
    projectId: string,
  ): ResolvedChorusGrant | undefined => {
    const op = description.operations.find((entry) => entry.key === operation);
    const resource = op?.resources.find(
      (candidate) => candidate.kind === chorusResourceKind && candidate.externalId === projectId,
    );
    return resource
      ? { handle, integrationId: resource.integrationId, resourceId: resource.id }
      : undefined;
  };

  const resolveGrant = async <O extends ChorusOperation>(
    operation: O,
    projectId: string,
    signal: AbortSignal,
    timeoutMs: number,
    forceRefresh: boolean,
    deprioritizeSignetId?: string,
  ): Promise<
    | { readonly ok: true; readonly grant: ResolvedChorusGrant }
    | { readonly ok: false; readonly outcome: ChorusCallOutcome<O> }
  > => {
    let handles: readonly SignetAccessHandle[];
    try {
      handles = await options.signets();
    } catch (error) {
      return {
        ok: false,
        outcome: {
          ok: false,
          failure: 'unreachable',
          message: `Could not load Kingdom Signets for ${options.endpoint}: ${String((error as Error)?.message ?? error).slice(0, 300)}`,
        },
      };
    }

    if (!handles.length) {
      return {
        ok: false,
        outcome: {
          ok: false,
          failure: 'no-token',
          message: `No Kingdom Signet available for ${options.endpoint}`,
        },
      };
    }

    // On a 403 retry with multiple held Signets, try other Signets before retrying the failing one.
    const ordered = deprioritizeSignetId
      ? [
          ...handles.filter((h) => h.signetId !== deprioritizeSignetId),
          ...handles.filter((h) => h.signetId === deprioritizeSignetId),
        ]
      : handles;

    let firstFailure: ChorusCallOutcome<O> | undefined;

    for (const handle of ordered) {
      if (signal.aborted) {
        return {
          ok: false,
          outcome: {
            ok: false,
            failure: 'timeout',
            message: `Chorus via Kingdom did not answer within ${timeoutMs}ms`,
          },
        };
      }
      let description: ParsedSignetDescription;
      try {
        description = await describeHandle(handle, signal, timeoutMs, forceRefresh);
      } catch (error) {
        descriptions.delete(handle.signetId);
        if (!firstFailure) firstFailure = mapTransportError<O>(error, options.endpoint, timeoutMs);
        continue;
      }

      const grant = matchGrant(handle, description, operation, projectId);
      if (grant) return { ok: true, grant };
    }

    if (firstFailure) return { ok: false, outcome: firstFailure };
    return {
      ok: false,
      outcome: {
        ok: false,
        refusal: 'unknown_project',
        message: `No Kingdom Chorus grant for ${operation} on project ${projectId}`,
      },
    };
  };

  const executeWithGrant = async <O extends ChorusOperation>(
    grant: ResolvedChorusGrant,
    operation: O,
    input: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<ChorusCallOutcome<O>> => {
    const executed = await grant.handle.execute(
      {
        integrationId: grant.integrationId,
        operation,
        input: { ...input, resourceId: grant.resourceId },
      },
      { signal, timeoutMs },
    );
    const parsed = relayedOperationResultSchemas[operation].safeParse(executed.result);
    if (!parsed.success) {
      return {
        ok: false,
        failure: 'invalid-response',
        message: `Chorus's ${operation} answer via Kingdom is not the contract's result`,
      };
    }
    return { ok: true, result: parsed.data as RelayedOperationResult<O> };
  };

  const transport: ChorusTransport = async (operation, call, timeoutMs) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const resolved = await resolveGrant(operation, call.projectId, signal, timeoutMs, false);
    if (!resolved.ok) return resolved.outcome;

    try {
      return await executeWithGrant(
        resolved.grant,
        operation,
        call.input as Record<string, unknown>,
        signal,
        timeoutMs,
      );
    } catch (error) {
      // Only re-describe on unstructured 401/403 (stale grant/rotation), never on a structured host
      // refusal such as `403 host_unavailable`.
      if (
        error instanceof SignetHttpError &&
        (error.status === 401 || error.status === 403) &&
        !error.refusal
      ) {
        descriptions.delete(resolved.grant.handle.signetId);
        const refreshed = await resolveGrant(
          operation,
          call.projectId,
          signal,
          timeoutMs,
          true,
          resolved.grant.handle.signetId,
        );
        if (!refreshed.ok) return refreshed.outcome;
        try {
          return await executeWithGrant(
            refreshed.grant,
            operation,
            call.input as Record<string, unknown>,
            signal,
            timeoutMs,
          );
        } catch (retryError) {
          if (
            retryError instanceof SignetHttpError &&
            (retryError.status === 401 || retryError.status === 403) &&
            !retryError.refusal
          ) {
            descriptions.delete(refreshed.grant.handle.signetId);
          }
          return mapTransportError(retryError, options.endpoint, timeoutMs);
        }
      }
      return mapTransportError(error, options.endpoint, timeoutMs);
    }
  };

  return { transport, invalidate };
}

/**
 * Resolves enrolled `SignetClient` handles held by this Foundry for one paired Kingdom.
 * `SignetClient` is stateless and shares token-renewal locking per credential file internally.
 * Avoids network enrollment on the hot Warden path when a live installation connection already
 * maintains the local Signet files.
 */
export function makeKingdomSignetHandleResolver(options: {
  readonly configDir: string;
  readonly connections?: () => KingdomInstallationConnections | undefined;
}) {
  return async (integration: KingdomIntegration): Promise<readonly SignetAccessHandle[]> => {
    const origin = kingdomUrl(integration.url);
    const connection = options.connections?.()?.get(kingdomIntegrationId(integration));
    const handles: SignetAccessHandle[] = [];
    const seen = new Set<string>();

    for (const held of connection?.signets ?? []) {
      if (seen.has(held.signetId) || !existsSync(held.credentialFile)) continue;
      seen.add(held.signetId);
      handles.push(new SignetClient(origin, held.credentialFile, held.signetId));
    }

    if (!seen.has(integration.signetId)) {
      const { directory } = kingdomInstallationPaths(options.configDir, origin);
      const localFile = signetCredentialFile(directory, integration.signetId);
      if (existsSync(localFile)) {
        handles.push(new SignetClient(origin, localFile, integration.signetId));
      } else if (!connection) {
        try {
          const enrolled = await heldSignetFile(options.configDir, origin, integration.signetId);
          handles.push(new SignetClient(origin, enrolled, integration.signetId));
        } catch {
          // Pair Signet not enrolled locally yet; any other held Signets above still apply.
        }
      }
    }

    return handles;
  };
}
