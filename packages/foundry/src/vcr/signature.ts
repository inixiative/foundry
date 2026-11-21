/**
 * @atlas
 * @kind transformer
 * @partOf primitive:vcr
 */
// Foundry's volatile event/path classification over @inixiative/vcr/freshness signatures.
import {
  type CassetteSignature,
  compareVolatileSignatures,
  eventKindOf,
  type SignatureOptions,
  signatureOfCassette,
  compareSignatures as vcrCompareSignatures,
} from '@inixiative/vcr/freshness';

export type Signature = CassetteSignature;

/** Event kinds whose presence and shape follow model behavior or transient service state (thinking,
 * rate-limit notices, reconnect errors, CLI logging and UI chatter), not the protocol. Their changes are notices. */
export const VOLATILE_KINDS: readonly RegExp[] = [
  /^stdout:system:thinking_tokens$/,
  /^stdout:system:commands_changed$/,
  /^stdout:system:ui_invalidate$/,
  /^stdout:assistant:thinking$/,
  /^stdout:rate_limit_event$/,
  /^stdout:error$/,
  /^stderr$/,
  /:reasoning$/,
  /^stdout:item\.completed:error$/,
  /^stdout:account\/rateLimits\/updated$/,
  /^stdout:mcpServer\/startupStatus\/updated$/,
];

/** Fields inside protocol events that follow transient service state: Claude's prompt-cache
 * diagnostics (`cache_miss_reason` on a miss, `null` on a hit). Their changes are notices too. */
export const VOLATILE_PATHS: readonly RegExp[] = [/^message\.diagnostics\b/];

export const FOUNDRY_SIGNATURE_OPTIONS: SignatureOptions = {
  volatileKinds: VOLATILE_KINDS,
  volatilePaths: VOLATILE_PATHS,
};

export const eventKind = eventKindOf;

export const signatureOf = (status: number, body: unknown): Signature =>
  signatureOfCassette(status, body, FOUNDRY_SIGNATURE_OPTIONS);

/** Protocol drift: human-readable structural differences; empty when the recordings agree. */
export const compareSignatures = (before: Signature, after: Signature): string[] =>
  vcrCompareSignatures(before, after, FOUNDRY_SIGNATURE_OPTIONS);

/** Changes in volatile kinds: reported, never a reason to hold a recording back. */
export const volatileDifferences = (before: Signature, after: Signature): string[] =>
  compareVolatileSignatures(before, after, FOUNDRY_SIGNATURE_OPTIONS);
