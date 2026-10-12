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

/** Strongest first. Data, so every caller filters with exactly these. */
export const CORRECTION_PATTERNS: Readonly<
  Record<Exclude<CorrectionSignal, 'interruption'>, RegExp>
> = {
  /** The person says this already failed: the strongest sign of a repeat. */
  repeat:
    /\b(?:again|i thought we|didn'?t we|did(?:n'?t| not) (?:i|we) (?:say|tell|ask|agree|decide)|i (?:already )?(?:told|asked) you|once and for all|how many times|(?:keeps?|kept) (?:doing|adding|making|asking|forgetting|happening)|i keep (?:saying|telling|having|asking)|same (?:mistake|thing|lessons?|problem)|as i said|like i said|we(?:'ve| have) (?:talked|been over|discussed|decided)|over and over|who keeps|still (?:seeing|doing|not|using|adding))\b/i,
  /** A standing instruction or a challenge to what the agent did. */
  explicit:
    /\b(?:from now on|going forward|in the future|always|never|remember (?:that|to|this)|make sure (?:you|to|that)|stop \w+ing|do not|don'?t (?:ever|make|add|do|use|ask|touch|create|build|write|need|be|put|bother)|please don'?t|you (?:should|shouldn'?t|need to|have to|must|can (?:just|always)|don'?t (?:need|have) to)|we (?:should(?:n'?t)?|don'?t|never|always)|should (?:just|not|never|always|be)|shouldn'?t|no need to|just (?:merge|use|do|call|fix|throw|delete|go|run|ship)|stop asking|why (?:would|did|are|do) you|why not just)\b/i,
  /** A message that opens by pushing back (the Prospector's corrective openers). */
  opener:
    /^\s*(?:no\b|no,|nope|don'?t|dont\b|stop\b|wait\b|wrong\b|not what|that'?s not|thats not|actually,?\s|instead\b|undo\b|revert\b|why (?:did|would|are|is|do) you|why not|what the (?:fuck|hell)|wtf|that'?s wrong|you'?re wrong|i said)/i,
};

const WEIGHT: Record<CorrectionSignal, number> = {
  repeat: 0.9,
  explicit: 0.7,
  interruption: 0.6,
  opener: 0.5,
};
/** The agent ended on a question, so a bare "no" answers it rather than corrects it. */
const ASKED = /\?\s*[)*`]*\s*$/;
const INTERRUPTED = /^\s*\[Request interrupted by user/;
const INTERRUPTED_MARKER = /^\s*\[Request interrupted by user[^\]]*\]\s*/;

export function detectCorrection(
  text: string,
  before = '',
  options: { interrupted?: boolean } = {},
): CorrectionDetection {
  const signals: CorrectionSignal[] = [];
  let phrase: string | undefined;
  for (const signal of ['repeat', 'explicit', 'interruption', 'opener'] as const) {
    if (signal === 'interruption') {
      if (options.interrupted) signals.push(signal);
      continue;
    }
    const match = CORRECTION_PATTERNS[signal].exec(text);
    if (!match) continue;
    signals.push(signal);
    phrase ??= match[0].trim();
  }
  const [strongest] = signals;
  if (!strongest) return { hit: false, signals, score: 0 };
  let score = WEIGHT[strongest] + 0.1 * (signals.length - 1);
  if (signals.length === 1 && strongest === 'opener' && ASKED.test(before)) score -= 0.3;
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
): { corrections: CorrectionEvent[]; secretsScrubbed: number } {
  const corrections: CorrectionEvent[] = [];
  let before = '';
  let pendingInterruption = false;
  let secretsScrubbed = 0;
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
    if (!detection.hit || !detection.signal) continue;
    const scrubbedBefore = scrubSecrets(before.slice(-2000));
    const scrubbedText = scrubSecrets(text.trim().slice(0, 4000));
    secretsScrubbed += scrubbedBefore.hits + scrubbedText.hits;
    const event = {
      ...(turn.id ? { messageId: turn.id } : {}),
      ...(turn.sourceRef ? { sourceRef: turn.sourceRef } : {}),
      timestamp: turn.timestamp,
      before: scrubbedBefore.text,
      correction: scrubbedText.text,
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
];

/** Replace credential-shaped substrings. Transcripts are exactly where leaked keys live. */
export function scrubSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    out = out.replace(pattern, () => {
      hits++;
      return replacement;
    });
  return { text: out, hits };
}

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

export const CORRECTION_CLASSIFY_PROMPT = `You classify one message a person typed to an AI coding agent, given the agent's previous message.

A CORRECTION is feedback about how the agent works: the person redirects, fixes or rejects what the agent did, or states a rule or preference the agent should keep following beyond this task. These are NOT corrections: a new task or question, an answer to the agent's question, approving or reviewing one specific item, design discussion, status chatter.

For a correction, write each rule it carries as a statement: one imperative sentence of at most 160 characters that says when it applies ("When X, do Y." or "Never X."), general enough to hold next time, in plain words without quoting the message. At most three statements. Use names (products, tools, terms) only when the rule is about them.

Respond with JSON only:
{ "isCorrection": boolean, "category": "approach" | "scope" | "convention" | "fact" | "other", "statements": string[], "sharp": boolean }
category: approach = how to do the work; scope = what to do or not do; convention = naming, style, process or tooling rules; fact = something about the world or the codebase the agent got wrong; other = anything else.
sharp: false when it is a correction but no crisp rule can be stated; then statements is empty.`;

/** The messages every caller sends for one candidate. */
export function correctionClassifyMessages(
  event: Pick<CorrectionEvent, 'before' | 'correction'>,
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: CORRECTION_CLASSIFY_PROMPT },
    {
      role: 'user',
      content: `## Agent's prior message\n${event.before || '(start of session)'}\n\n## Person's message\n${event.correction}`,
    },
  ];
}

/** The classifier's answer, or undefined when it is not the contract's JSON. */
export function parseCorrectionClassification(
  content: string,
): CorrectionClassification | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '');
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.isCorrection !== 'boolean') return undefined;
  const category = CORRECTION_CATEGORIES.find((item) => item === value.category) ?? 'other';
  const statements = Array.isArray(value.statements)
    ? value.statements
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 160))
        .slice(0, 3)
    : [];
  if (!value.isCorrection) return { isCorrection: false, category, statements: [], sharp: false };
  const sharp = value.sharp !== false && statements.length > 0;
  return { isCorrection: true, category, statements: sharp ? statements : [], sharp };
}
