// The response protocols every Warden phase answers under, and their strict reading. NO_COMMENT is the
// expected answer in every phase; anything else is one JSON object in the phase's envelope (advice
// snippets, or guard findings), and an answer in neither shape is an error, never a guess.

import type { AdviceTrigger } from '../agents/warden-triggers';

/** An advice answer read in its envelope: NO_COMMENT, or a contribution with a snippet or a layer. */
export interface AdviceAnswer {
  layers: string[];
  snippets: string[];
  confidence: number;
  noComment?: true;
}

/** A guard finding as the protocol allows it: advisory, its description one remark of the pointer. */
export interface GuardAnswerFinding {
  severity: 'advisory';
  description: string;
  location?: string;
}

/**
 * The one answer a Warden gives when it has nothing to add, in every phase. It is the expected,
 * most common answer, carries no other fields, and adds nothing to the thread: no note, no block,
 * nothing delivered to the native session. It is still journalled as the Warden's decision.
 */
export const NO_COMMENT = 'NO_COMMENT';

export const NO_COMMENT_RULE = `Nothing to add is the expected answer, and the most common one. Then respond with exactly ${NO_COMMENT} and nothing else: no JSON, no explanation, no punctuation. It adds nothing to the thread.`;
export const STRICT_RULE = `Any other answer, including JSON with empty lists or extra fields, is an error, not a comment.`;

/**
 * The advice phase's response contract for a trigger. Sent with every advice request, independent of
 * the domain's instructions. Every trigger has the one bar the charter's first principle sets:
 * NO_COMMENT only when the moment touches nothing in the domain, whatever it says to build or not to
 * use; the snippets are the pointer's remarks. At a handoff (`subagent-spawn`) the moment is the task
 * text a subagent starts from.
 */
export function adviceResponseProtocol(trigger: AdviceTrigger): string {
  return [
    `## Response protocol (advice phase, trigger: ${trigger})`,
    `${NO_COMMENT_RULE} Here it means the moment touches nothing in your domain, whatever it says to build or not to use.`,
    'Only when it touches something your domain says already exists, respond with JSON only, exactly this shape: { "snippets": string[], "layers": string[], "confidence": number }.',
    '"snippets" are the remarks of your pointer, one per line of the charter\'s shape, in its order; "layers" are IDs of your domain\'s layers to inject; at least one of them is non-empty. "confidence" is a number from 0 to 1.',
    STRICT_RULE,
  ].join('\n');
}

/** The advice phase's response contract at the user's message. */
export const ADVICE_RESPONSE_PROTOCOL = adviceResponseProtocol('user-message');

/**
 * The guard phase's response contract, sent with every guard request: the agent's actions are
 * classified like any moment, so a finding is one remark of the pointer, always advisory, with no
 * suggested fix. Nothing in it is a verdict.
 */
export const GUARD_RESPONSE_PROTOCOL = [
  '## Response protocol (guard phase, trigger: agent-action)',
  `${NO_COMMENT_RULE} Here it means the agent's actions this turn touch nothing in your domain.`,
  'Only when they touch something your domain says already exists, respond with JSON only, exactly this shape: { "findings": [ { "severity": "advisory", "description": string, "location"?: string } ] }: one finding per remark of your pointer, in the charter\'s order, its "description" the remark. "location" names the call (its number or tool) and file the remark is about.',
  STRICT_RULE,
].join('\n');

const MAX_ADVICE_RESPONSE = 20_000;
const MAX_GUARD_RESPONSE = 20_000;
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Read one answer strictly: exactly NO_COMMENT, or one JSON object (alone, or as the whole content of
 * one code fence). Prose around either is a protocol error. Errors never carry the answer's text.
 */
export function protocolAnswer(
  text: string,
): { noComment: true } | { noComment: false; value: Record<string, unknown> } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === NO_COMMENT) return { noComment: true };
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?\s*```$/.exec(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    return {
      error: trimmed.includes(NO_COMMENT)
        ? `${NO_COMMENT} must be the whole answer, with nothing else`
        : `answer is neither ${NO_COMMENT} nor a JSON object`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return {
      error: `answer must be ${NO_COMMENT} or a JSON object, received ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`}`,
    };
  return { noComment: false, value: parsed as Record<string, unknown> };
}

const outside = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).filter((key) => !allowed.includes(key));

/**
 * Validate a guard-phase response against the protocol. Errors are bounded and never carry
 * the response text. NO_COMMENT is a completed check with nothing to add; otherwise only an object
 * with a non-empty `findings` array of well-formed findings is a result.
 */
export function validateGuardResponse(
  content: unknown,
): { findings: GuardAnswerFinding[]; noComment?: true } | { error: string } {
  if (typeof content !== 'string') return { error: 'guard response is not text' };
  if (content.length > MAX_GUARD_RESPONSE)
    return { error: `guard response exceeds ${MAX_GUARD_RESPONSE} characters` };
  const answer = protocolAnswer(content);
  if ('error' in answer) return { error: `guard ${answer.error}` };
  if (answer.noComment) return { findings: [], noComment: true };
  const extra = outside(answer.value, ['findings']);
  if (extra.length)
    return {
      error: `guard response has ${extra.length} field(s) outside the protocol`,
    };
  const raw = answer.value.findings;
  if (!Array.isArray(raw)) return { error: 'guard response requires "findings": array' };
  if (!raw.length)
    return {
      error: `guard response has no findings; answer ${NO_COMMENT} when there is nothing to add`,
    };
  const findings: GuardAnswerFinding[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i] as {
      severity?: unknown;
      description?: unknown;
      location?: unknown;
    } | null;
    if (!f || typeof f !== 'object' || Array.isArray(f))
      return { error: `guard finding ${i} is not an object` };
    // A Warden points: a critical severity or a suggested fix would be a verdict, so neither is in the protocol.
    const findingExtra = outside(f as Record<string, unknown>, [
      'severity',
      'description',
      'location',
    ]);
    if (findingExtra.length)
      return {
        error: `guard finding ${i} has ${findingExtra.length} field(s) outside the protocol`,
      };
    if (f.severity !== 'advisory')
      return { error: `guard finding ${i} requires "severity": "advisory"` };
    if (typeof f.description !== 'string' || !f.description.trim())
      return { error: `guard finding ${i} requires "description": non-empty string` };
    if (f.location !== undefined && typeof f.location !== 'string')
      return { error: `guard finding ${i} "location" must be a string` };
    findings.push({
      severity: f.severity,
      description: f.description,
      ...(f.location !== undefined ? { location: f.location } : {}),
    });
  }
  return { findings };
}

/**
 * Validate one advice response against the protocol: NO_COMMENT, or a contribution with at least one
 * snippet or layer. Errors name the violated field by kind only and never include the response text.
 */
export function validateAdviceResponse(content: unknown): AdviceAnswer | { error: string } {
  if (typeof content !== 'string') return { error: 'advice response is not text' };
  if (content.length > MAX_ADVICE_RESPONSE)
    return { error: `advice response exceeds ${MAX_ADVICE_RESPONSE} characters` };
  const answer = protocolAnswer(content);
  if ('error' in answer) return { error: `advice ${answer.error}` };
  if (answer.noComment) return { layers: [], snippets: [], confidence: 0, noComment: true };
  const value = answer.value;
  const extra = outside(value, ['layers', 'snippets', 'confidence']);
  if (extra.length)
    return {
      error: `advice response has ${extra.length} field(s) outside the protocol`,
    };
  if (!stringArray(value.layers)) return { error: 'advice response requires "layers": string[]' };
  if (!stringArray(value.snippets))
    return { error: 'advice response requires "snippets": string[]' };
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  )
    return { error: 'advice response requires "confidence": finite number from 0 to 1' };
  const snippets = value.snippets.filter((snippet) => snippet.trim());
  if (snippets.length !== value.snippets.length)
    return { error: 'advice response "snippets" must not contain empty strings' };
  if (!snippets.length && !value.layers.length)
    return {
      error: `advice response contributes nothing; answer ${NO_COMMENT} when there is nothing to add`,
    };
  return { layers: value.layers, snippets, confidence: value.confidence };
}
