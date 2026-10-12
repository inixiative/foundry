import { createHash } from 'node:crypto';

// The Prospector's correction detection (moved from Oracle's session miner), shared by Oracle's
// `oracle mine`, Foundry's live feedback capture and `foundry repeats`. Data and pure functions only:
// callers bring the transcript turns and the model call.

/** Why a message became a candidate, strongest first. */
export type CorrectionSignal = 'repeat' | 'explicit' | 'interruption' | 'opener';

/** One turn of a transcript, whatever harness wrote it. */
export interface TranscriptTurn {
  role: 'user' | 'assistant';
  /** The harness's record id for the turn. */
  id?: string;
  /** ISO time, or '' when the record has none. */
  timestamp: string;
  /** What the person typed (user) or the agent's prose (assistant). */
  text: string;
  /** The person interrupted the agent just before this turn. */
  interrupted?: boolean;
  /** Where the turn sits in its source, e.g. `line:42`. */
  sourceRef?: string;
}

export interface CorrectionEvent {
  /** Stable identity: `<sessionId>:<messageId>`, or a content digest when the record has no id. */
  readonly id: string;
  readonly sessionId: string;
  readonly messageId?: string;
  readonly sourceRef?: string;
  readonly timestamp: string;
  /** What the agent said right before the correction ('' at the start of a session). */
  readonly before: string;
  /** The person's message. */
  readonly correction: string;
  /** The strongest signal, and every signal that fired. */
  readonly signal: CorrectionSignal;
  readonly signals: readonly CorrectionSignal[];
  /** The matched phrase of the strongest pattern signal. */
  readonly phrase?: string;
  /** 0–1 rank among candidates. */
  readonly score: number;
}

export interface CorrectionDetection {
  hit: boolean;
  signal?: CorrectionSignal;
  signals: CorrectionSignal[];
  phrase?: string;
  score: number;
}

/** Data, so every caller filters with exactly these. Tuned on a 19.8k-message scan against an Opus read. */
export const CORRECTION_PATTERNS: Readonly<
  Record<Exclude<CorrectionSignal, 'interruption'>, RegExp>
> = {
  /** The person says this already failed. A bare "again" is handled by `AGAIN_CORRECTION`, not here. */
  repeat:
    /\b(?:i thought we|didn'?t we|did(?:n'?t| not) (?:i|we) (?:say|tell|ask|agree|decide)|i (?:already )?(?:told|asked) you|once and for all|how many times|(?:keeps?|kept) (?:doing|adding|making|asking|forgetting|happening)|i keep (?:saying|telling|having|asking)|same (?:mistake|lessons?)|as i said|like i said|we(?:'ve| have) (?:talked|been over|discussed|decided)|over and over|who keeps|still (?:seeing|doing|using|adding)|gentle reminder|reminder:)/i,
  /** A standing instruction, a challenge, a reuse hint or a verdict on what the agent did. */
  explicit:
    /\b(?:from now on|going forward|in the future|always|never|remember (?:that|to|this)|make sure (?:you|to|that)|stop \w+ing|do not|don'?t (?:ever|make|add|do|use|ask|touch|create|build|write|need|be|put|bother)|please (?:don'?t|use|run|just)|you (?:should|shouldn'?t|need to|have to|must|can (?:just|always)|don'?t (?:need|have) to)|we (?:should(?:n'?t)?|don'?t|never|always)|should (?:just|not|never|always)|shouldn'?t|no need to|just (?:merge|use|do|call|fix|throw|delete|go|run|ship)|stop asking|why (?:would|did|are|do) (?:you|u)|why not just|why can'?t we just|get rid of|(?:is|are)n'?t needed|(?:does|do)n'?t make sense|i (?:really )?don'?t like|weird pattern|we (?:already )?have (?:a |an |the )?(?:native |existing |shared )?\w+(?: \w+)? (?:for|that|utils?|helpers?)|isn'?t there (?:already )?a|already (?:exists|have|has)|use (?:the )?(?:existing|internal|shared)|follow (?:what|how) \w+ (?:is doing|does)|are (?:you|u) assuming|did (?:you|u) (?:actually|read|check|test|run|verify)|i don'?t trust|have (?:you|u) (?:restarted|tested|run|checked|verified)|in both repos|backport|backprop|use (?:the )?logger)\b/i,
  /** A message that opens by pushing back (the Prospector's corrective openers). */
  opener:
    /^\s*(?:no\b|no,|nope|don'?t|dont\b|stop\b|wait\b|wrong\b|not what|that'?s not|thats not|actually,?\s|instead\b|undo\b|revert\b|why (?:did|would|are|is|do) (?:you|u)|why not|what the (?:fuck|hell)|wtf|that'?s wrong|you'?re wrong|i said)/i,
};

/**
 * "Again" marks a repeat only beside a negation or a challenge in the same sentence ("again, we
 * shouldn't…", "not again"). Retries ("try it again", "run again") and filler don't count.
 */
export const AGAIN_CORRECTION = {
  word: /\bagain\b/i,
  retry:
    /\b(?:try|run|do|check|show|send|ask|say|test|start|restart|look|read|load|open|build|deploy|push|pull|merge|call|post|go)(?: (?:it|that|this|them|me|the \w+))? again\b|^\W*again\W*$/i,
  context:
    /\b(?:don'?t|do not|not|never|shouldn'?t|stop|why|wrong|told|said|no longer|keep|still|same|we'?re|you'?re|you)\b/i,
} as const;

/** Measured precision per signal: openers hold best, interruptions worst. */
const WEIGHT: Record<CorrectionSignal, number> = {
  opener: 0.8,
  repeat: 0.7,
  explicit: 0.6,
  interruption: 0.5,
};
/** The agent ended on a question, so a bare "no" answers it rather than corrects it. */
const ASKED = /\?\s*[)*`]*\s*$/;
const INTERRUPTED = /^\s*\[Request interrupted by user/;
const INTERRUPTED_MARKER = /^\s*\[Request interrupted by user[^\]]*\]\s*/;

/** The person's own prose: pasted code, quotes and log lines are someone else's words. */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .split('\n')
    .filter(
      (line) =>
        !/^\s*>/.test(line) &&
        !/^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ]\d|\d{1,2}:\d{2}(?::\d{2})?\s|[\w.-]+:\d+(?::\d+)?\s)/.test(
          line,
        ),
    )
    .join('\n');
}

function againPhrase(prose: string): string | undefined {
  for (const sentence of prose.split(/(?<=[.!?\n])\s+/)) {
    if (!AGAIN_CORRECTION.word.test(sentence) || AGAIN_CORRECTION.retry.test(sentence)) continue;
    if (AGAIN_CORRECTION.context.test(sentence.replace(AGAIN_CORRECTION.word, ''))) return 'again';
  }
  return undefined;
}

export function detectCorrection(
  text: string,
  before = '',
  options: { interrupted?: boolean } = {},
): CorrectionDetection {
  const prose = proseOf(text);
  const found = new Map<CorrectionSignal, string | undefined>();
  for (const signal of ['opener', 'repeat', 'explicit'] as const) {
    const match = CORRECTION_PATTERNS[signal].exec(prose);
    if (match) found.set(signal, match[0].trim());
  }
  const again = againPhrase(prose);
  if (again && !found.has('repeat')) found.set('repeat', again);
  if (options.interrupted) found.set('interruption', undefined);
  const signals = [...found.keys()].sort((a, b) => WEIGHT[b] - WEIGHT[a]);
  const [strongest] = signals;
  if (!strongest) return { hit: false, signals, score: 0 };
  let score = WEIGHT[strongest] + 0.1 * (signals.length - 1);
  if (signals.length === 1 && strongest === 'opener' && ASKED.test(before)) score -= 0.4;
  const phrase = found.get(strongest) ?? signals.map((signal) => found.get(signal)).find(Boolean);
  return {
    hit: true,
    signal: strongest,
    signals,
    ...(phrase ? { phrase } : {}),
    score: Math.round(Math.min(1, score) * 100) / 100,
  };
}

export function correctionId(
  sessionId: string,
  event: Pick<CorrectionEvent, 'messageId' | 'timestamp' | 'before' | 'correction'>,
): string {
  if (event.messageId) return `${sessionId}:${event.messageId}`;
  const digest = createHash('sha256')
    .update(`${event.timestamp}\0${event.before}\0${event.correction}`)
    .digest('hex')
    .slice(0, 16);
  return `${sessionId}:sha256-${digest}`;
}

/** Correction candidates in one session's turns, secrets scrubbed. */
export function extractCorrections(
  sessionId: string,
  turns: Iterable<TranscriptTurn>,
  options: { minScore?: number } = {},
): { corrections: CorrectionEvent[]; secretsScrubbed: number } {
  const minScore = options.minScore ?? 0;
  const corrections: CorrectionEvent[] = [];
  let before = '';
  let pendingInterruption = false;
  let secretsScrubbed = 0;
  // An identical message resent within ten minutes is one correction, not a repeat.
  const recent = new Map<string, number>();
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      if (turn.text.trim()) before = turn.text;
      continue;
    }
    if (turn.interrupted || INTERRUPTED.test(turn.text)) pendingInterruption = true;
    const text = turn.text.replace(INTERRUPTED_MARKER, '');
    if (!text.trim()) continue;
    const detection = detectCorrection(text, before, { interrupted: pendingInterruption });
    pendingInterruption = false;
    const key = text.toLowerCase().replace(/\s+/g, ' ').trim();
    const at = Date.parse(turn.timestamp);
    const sent = recent.get(key);
    recent.set(key, at);
    if (sent !== undefined && Number.isFinite(at) && at - sent < 600_000) continue;
    if (!detection.hit || !detection.signal || detection.score < minScore) continue;
    // Scrub before truncating, so a cut can't leave part of a secret unmatched.
    const scrubbedBefore = scrubSecrets(before);
    const scrubbedText = scrubSecrets(text.trim());
    secretsScrubbed += scrubbedBefore.hits + scrubbedText.hits;
    const event = {
      ...(turn.id ? { messageId: turn.id } : {}),
      ...(turn.sourceRef ? { sourceRef: turn.sourceRef } : {}),
      timestamp: turn.timestamp,
      before: scrubbedBefore.text.slice(-2000),
      correction: scrubbedText.text.slice(0, 4000),
      signal: detection.signal,
      signals: detection.signals,
      ...(detection.phrase ? { phrase: detection.phrase } : {}),
      score: detection.score,
    };
    corrections.push({ id: correctionId(sessionId, event), sessionId, ...event });
  }
  return { corrections, secretsScrubbed };
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED:anthropic-key]'],
  [/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:api-key]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github-token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github-token]'],
  [/AIza[A-Za-z0-9_-]{30,}/g, '[REDACTED:google-key]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/AKIA[A-Z0-9]{16}/g, '[REDACTED:aws-key]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED:private-key]',
  ],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/\b[a-z]+_(?:live|test|prod|runtime)_[A-Za-z0-9]{16,}/g, '[REDACTED:token]'],
  [/\b(?:npm_|glpat-|hf_)[A-Za-z0-9_-]{20,}/g, '[REDACTED:token]'],
  [/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, '[REDACTED:slack-webhook]'],
  [/\bASIA[A-Z0-9]{16}/g, '[REDACTED:aws-key]'],
  [/\b(Bearer|Basic|DPoP)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [REDACTED:credential]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED:password]@'],
  [
    /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']{8,}["']?/g,
    '$1[REDACTED:value]',
  ],
  [
    /(["']?)\b(password|passwd|api[_-]?key|secret|(?:access|auth|refresh)?[_-]?token)\1(\s*[:=]\s*)["']?[^\s"',}]{8,}["']?/gi,
    '$1$2$1$3[REDACTED:value]',
  ],
];

/** Replace credential-shaped substrings. Transcripts are exactly where leaked keys live. */
export function scrubSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    out = out.replace(pattern, (...match: unknown[]) => {
      hits++;
      return replacement.replace(/\$(\d)/g, (_, group: string) => {
        const value = match[Number(group)];
        return typeof value === 'string' ? value : '';
      });
    });
  return { text: out, hits };
}

/** FEEDBACK-LOG's tags plus process: the closed list feedback items and repeat rules are tagged with. */
export const FEEDBACK_TAGS = [
  'hygiene',
  'naming',
  'merge',
  'reuse',
  'overbuild',
  'architecture',
  'data',
  'product',
  'coordination',
  'communication',
  'tooling',
  'security',
  'process',
] as const;
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number];

export const CORRECTION_CATEGORIES = ['approach', 'scope', 'convention', 'fact', 'other'] as const;
export type CorrectionCategory = (typeof CORRECTION_CATEGORIES)[number];

export interface CorrectionClassification {
  isCorrection: boolean;
  category: CorrectionCategory;
  /** Imperative rules, each at most 160 characters and saying when it applies; empty when none. */
  statements: string[];
  /** False when it is a correction but no crisp rule can be stated. */
  sharp: boolean;
}

export const CORRECTION_CLASSIFY_PROMPT = `You classify messages a person typed to an AI coding agent. Each message comes with the agent's previous message, and each is judged on its own.

A CORRECTION is feedback about how the agent works: the person redirects, fixes or rejects what the agent did, or states a rule or preference the agent should keep following beyond this task. These are NOT corrections: a new task or question, an answer to the agent's question, approving or reviewing one specific item, design discussion, status chatter.

For a correction, write each rule it carries as a statement: one imperative sentence of at most 160 characters that says when it applies ("When X, do Y." or "Never X."), general enough to hold next time, in plain words without quoting the message. At most three statements per message. Use names (products, tools, terms) only when the rule is about them.

Respond with JSON only, one result per message id:
{ "results": { "<id>": { "isCorrection": boolean, "category": "approach" | "scope" | "convention" | "fact" | "other", "statements": string[], "sharp": boolean } } }
category: approach = how to do the work; scope = what to do or not do; convention = naming, style, process or tooling rules; fact = something about the world or the codebase the agent got wrong; other = anything else.
sharp: false when it is a correction but no crisp rule can be stated; then statements is empty.`;

/** The stable start of every classify input: providers that prime a session reuse it (`stablePrefix`). */
export const CORRECTION_CLASSIFY_PREFIX = 'Classify each message below.\n\n';

/** The messages every caller sends for a batch of candidates (one is a batch of one). Ids are M1..Mn. */
export function correctionClassifyMessages(
  events: readonly Pick<CorrectionEvent, 'before' | 'correction'>[],
  limits: { before?: number; correction?: number } = {},
): { role: 'system' | 'user'; content: string }[] {
  const before = limits.before ?? 1200;
  const correction = limits.correction ?? 3000;
  const body = events
    .map(
      (event, index) =>
        `## M${index + 1}\n### Agent's prior message\n${event.before.slice(-before) || '(start of session)'}\n\n### Person's message\n${event.correction.slice(0, correction)}`,
    )
    .join('\n\n');
  return [
    { role: 'system', content: CORRECTION_CLASSIFY_PROMPT },
    { role: 'user', content: `${CORRECTION_CLASSIFY_PREFIX}${body}` },
  ];
}

function classification(value: unknown): CorrectionClassification | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.isCorrection !== 'boolean') return undefined;
  const category = CORRECTION_CATEGORIES.find((entry) => entry === item.category) ?? 'other';
  const statements = Array.isArray(item.statements)
    ? item.statements
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim().slice(0, 160))
        .slice(0, 3)
    : [];
  if (!item.isCorrection) return { isCorrection: false, category, statements: [], sharp: false };
  const sharp = item.sharp !== false && statements.length > 0;
  return { isCorrection: true, category, statements: sharp ? statements : [], sharp };
}

/** The first balanced `{...}` in a model answer, so prose or braces after it don't break parsing. */
function firstJsonObject(content: string): string | undefined {
  const start = content.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '\\') i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return content.slice(start, i + 1);
  }
  return undefined;
}

/** One answer per message of the batch, in order; undefined where the answer is missing or malformed. */
export function parseCorrectionClassifications(
  content: string,
  count: number,
): (CorrectionClassification | undefined)[] {
  let raw: unknown;
  try {
    raw = JSON.parse(firstJsonObject(content) ?? '');
  } catch {
    return Array.from({ length: count }, () => undefined);
  }
  const results =
    raw && typeof raw === 'object' ? (raw as { results?: unknown }).results : undefined;
  const byId = results && typeof results === 'object' ? (results as Record<string, unknown>) : {};
  return Array.from({ length: count }, (_, index) => classification(byId[`M${index + 1}`]));
}
