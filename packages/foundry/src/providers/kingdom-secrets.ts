export const RUNTIME_SECRET_PREFIX = 'kingdom_runtime_';

const secret = (kind: '' | 'runtime_' | 'run_' | 'refresh_') =>
  new RegExp(`^kingdom_${kind}[a-zA-Z0-9_-]{43}$`);
export const runtimeSecretPattern = secret('runtime_');
export const runSecretPattern = secret('run_');
export const refreshSecretPattern = secret('refresh_');
/** Signet access tokens. */
export const accessSecretPattern = secret('');

/** Any Kingdom secret in free text. */
export const secretInText = /\bkingdom_(?:runtime_|run_|refresh_)?[A-Za-z0-9_-]{20,}/g;
export const unredactedSecretInText =
  /\bkingdom_(?!REDACTED)(?:runtime_|run_|refresh_)?[A-Za-z0-9_-]{20,}/;
