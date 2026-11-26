/**
 * @atlas
 * @kind helper
 * @partOf integration:kingdom, primitive:secrets
 */
const secret = (kind: '' | 'run_' | 'refresh_') => new RegExp(`^kingdom_${kind}[a-zA-Z0-9_-]{43}$`);
export const runSecretPattern = secret('run_');
export const refreshSecretPattern = secret('refresh_');
