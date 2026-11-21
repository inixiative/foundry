/**
 * @atlas
 * @kind transformer
 * @partOf primitive:vcr
 */
// Foundry-specific scrubbing policy over @inixiative/vcr/scrub: preserves Foundry's cassette
// placeholders, scrubs JSON-quoted secret assignments inside plain text, allows Codex login
// method enums, and drops claude.ai account MCP connectors.
import {
  accountHomeDirectory,
  createScrubber,
  DEFAULT_SECRET_KEY_PATTERN,
  defaultPlaceholderFor,
  type LeakFinding,
  type Scrubber,
  type ScrubContext,
  type ScrubPlaceholderKind,
  type ScrubRule,
} from '@inixiative/vcr/scrub';

export type { ScrubContext };

const FOUNDRY_PLACEHOLDERS: Partial<Record<ScrubPlaceholderKind, string>> = {
  secret: 'REDACTED',
  bearer: 'REDACTED',
  basic: 'REDACTED',
  dpop: 'REDACTED',
  jwt: 'JWT_REDACTED',
  anthropic_key: 'sk-ant-REDACTED',
  openai_key: 'sk-REDACTED',
  github_token: 'GITHUB_TOKEN_REDACTED',
  slack_token: 'SLACK_TOKEN_REDACTED',
  kingdom_token: 'kingdom_REDACTED',
  header_secret: 'REDACTED',
  query_secret: 'REDACTED',
};

const foundryPlaceholderFor = (kind: ScrubPlaceholderKind, match: string): string => {
  if (kind === 'key_secret') {
    return /^Bearer\s+/i.test(match.trim()) ? 'Bearer REDACTED' : 'REDACTED';
  }
  return FOUNDRY_PLACEHOLDERS[kind] ?? defaultPlaceholderFor(kind, match);
};

// Reuse @inixiative/vcr's secret-key table with non-capturing groups so embedded JSON-quoted
// secrets in plain text (e.g. `Update available {"api_key":"..."}`) are scrubbed before leak checks.
const secretKeyCore = DEFAULT_SECRET_KEY_PATTERN.source
  .replace(/^\^|\$$/g, '')
  .replace(/\((?!\?)/g, '(?:');

const QUOTED_SECRET_VALUE_RULE: ScrubRule = {
  id: 'quoted_secret_assignment',
  pattern: new RegExp(
    `((\\\\?["'])${secretKeyCore}\\2\\s*:\\s*(\\\\?["']))(?!<REDACTED:|REDACTED\\b|Bearer\\s+REDACTED\\b)(?:[^"'\\\\\\n\\r]|\\\\(?!["']))+\\3`,
    'gi',
  ),
  placeholder: (_match, prefix, _keyQuote, valQuote) => `${prefix}REDACTED${valQuote}`,
  checkLeak: false,
};

/**
 * A login method is a closed enum, not identity: the Codex app-server's `account.type` is exactly
 * what `codex login status` recordings keep ("Logged in using ChatGPT"), and Foundry refuses
 * anything but a ChatGPT login. Kept only for `type` and only for these values.
 */
const LOGIN_METHODS = new Set(['chatgpt', 'apiKey', 'amazonBedrock']);
const allowLoginMethod = (key: string | undefined, value: string): boolean =>
  key === 'type' && LOGIN_METHODS.has(value);

/**
 * The claude.ai connectors an account has enabled (Gmail, Drive…) show up in every Claude
 * session's `system:init` `mcp_servers`. They describe the account, not the protocol: dropped so a
 * cassette neither names them nor drifts when the account adds one.
 */
const isAccountConnector = (item: unknown): boolean =>
  !!item && typeof item === 'object' && (item as { source?: unknown }).source === 'claudeai';

export const foundryScrubber: Scrubber = createScrubber({
  placeholderFor: foundryPlaceholderFor,
  rules: [QUOTED_SECRET_VALUE_RULE],
  allowValue: allowLoginMethod,
  filterArrayItem: (key, item) => !(key === 'mcp_servers' && isAccountConnector(item)),
});

/** The real account home, even when a test points HOME at a temporary profile. */
export const accountHome = accountHomeDirectory;

export const scrubText = (text: string, context?: ScrubContext): string =>
  foundryScrubber.scrubText(text, context);

export const scrubValue = <T>(value: T, context?: ScrubContext): T =>
  foundryScrubber.scrubValue(value, context);

/** One protocol line: JSON stays valid JSON, anything else is scrubbed as text. */
export const scrubLine = (line: string, context?: ScrubContext): string =>
  foundryScrubber.scrubLine(line, context);

/** Fill placeholders back in for this replay's own directories. */
export const rehydrate = (text: string, context?: ScrubContext): string =>
  foundryScrubber.rehydratePlaceholders(text, context);

export const leakLabel = (finding: LeakFinding): string =>
  finding.kind.startsWith('unredacted_')
    ? `unredacted ${finding.kind.slice('unredacted_'.length)}`
    : finding.kind.replace(/_/g, ' ');

/** Leaks in a cassette's text or parsed JSON, formatted as deduplicated labels. */
export const findLeaks = (text: string): string[] => {
  let input: unknown = text;
  try {
    input = JSON.parse(text);
  } catch {
    /* Non-JSON text: scan raw string directly. */
  }
  return [...new Set(foundryScrubber.findUnscrubbedSecrets(input).map(leakLabel))];
};
