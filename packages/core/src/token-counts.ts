/** Cache counts, when supplied, are disjoint from input. Thinking and TTL
 * breakdowns are subsets of output/cacheWrite, never additional tokens.
 * Missing optional counters mean unreported, not a measured zero.
 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  thinking?: number;
  providerUsage?: Readonly<Record<string, unknown>>;
}

export function totalTokenCount(tokens: TokenCounts): number {
  return tokens.input + tokens.output + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
}

/** Sum reported counters only. Provider tags remain on individual records. */
export function sumTokenCounts(entries: Iterable<TokenCounts>): TokenCounts {
  const total: TokenCounts = { input: 0, output: 0 };
  for (const entry of entries) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "thinking"] as const) {
      const value = entry[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}
