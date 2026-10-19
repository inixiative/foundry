/**
 * @atlas
 * @kind schema
 * @partOf primitive:classify
 */
// The response protocols every Warden phase answers under, and their strict reading. NO_COMMENT is the
// expected answer in every phase; anything else is one JSON object in the phase's envelope (advice
// snippets, or guard findings), and an answer in neither shape is an error, never a guess.

import type { ClassifyOutcome } from '@inixiative/foundry-core';
import type { AdviceTrigger, TriggerPoint } from '../agents/warden-triggers';
import { parseWardenPointer, type WardenPointer } from './pointer';
import { parseRecognition, type Recognition } from './recognition';
import type { PointerSettings, StageOutcomes, StageReason, StageTask } from './stages';

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
  return guardValue(answer.value);
}

/** A guard answer's object, read as the guard envelope (the fields `extra` admits are the caller's). */
function guardValue(
  value: Record<string, unknown>,
  extra: readonly string[] = [],
): { findings: GuardAnswerFinding[] } | { error: string } {
  const beyond = outside(value, ['findings', ...extra]);
  if (beyond.length)
    return {
      error: `guard response has ${beyond.length} field(s) outside the protocol`,
    };
  const raw = value.findings;
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
  return adviceValue(answer.value);
}

/** An advice answer's object, read as the advice envelope (the fields `extra` admits are the caller's). */
function adviceValue(
  value: Record<string, unknown>,
  extra: readonly string[] = [],
): AdviceAnswer | { error: string } {
  const beyond = outside(value, ['layers', 'snippets', 'confidence', ...extra]);
  if (beyond.length)
    return {
      error: `advice response has ${beyond.length} field(s) outside the protocol`,
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

// ---------------------------------------------------------------------------
// Stage protocols: the response tail generated from a stage's task, outcomes and reason
// ---------------------------------------------------------------------------

/** The envelope an answer comes in: advice snippets, or guard findings. The trigger chooses it. */
export type Envelope = 'advice' | 'guard';

/** What a stage's response protocol is generated from. Charters never restate it. */
export interface ProtocolSpec {
  readonly envelope: Envelope;
  /** The trigger point the moment is framed for (`agent-action` for the guard envelope). */
  readonly trigger: TriggerPoint;
  readonly task: StageTask;
  readonly outcomes: StageOutcomes;
  readonly reason: StageReason;
}

const header = (spec: ProtocolSpec) =>
  spec.envelope === 'guard'
    ? '## Response protocol (guard phase, trigger: agent-action)'
    : `## Response protocol (advice phase, trigger: ${spec.trigger})`;

/** What "nothing applies" means for a stage, in the words of today's protocols. */
function nothingMeans(spec: ProtocolSpec): string {
  const subject = spec.envelope === 'guard' ? "the agent's actions this turn" : 'the moment';
  const verb = spec.envelope === 'guard' ? 'touch' : 'touches';
  const are = spec.envelope === 'guard' ? 'are' : 'is';
  const anyway = spec.envelope === 'guard' ? '' : ', whatever it says to build or not to use';
  return spec.task === 'recognise'
    ? `${subject} ${are} in none of your regions${anyway}`
    : `${subject} ${verb} nothing in your domain${anyway}`;
}

const REMARKS = {
  point: "the remarks of your pointer, one per line of the charter's shape, in its order",
  recognise: (outcomes: StageOutcomes) =>
    outcomes === 'ternary'
      ? 'the regions the moment is in, one per line: `<region id>: YES — <one line: what in the moment puts it in that region>`, or `<region id>: UNSURE — <one line: what makes it possibly that region>` when your description does not settle it'
      : 'the regions the moment is in, one per line: `<region id>: <one line: what in the moment puts it in that region>`',
};

/**
 * A stage's response protocol. The default (point, binary, no why) is exactly today's advice and
 * guard protocols; `followup` asks why after the answer, so its protocol is the same as `none`.
 */
export function responseProtocol(spec: ProtocolSpec): string {
  const plain = spec.reason !== 'inline';
  if (spec.task === 'point' && spec.outcomes === 'binary' && plain)
    return spec.envelope === 'guard'
      ? GUARD_RESPONSE_PROTOCOL
      : adviceResponseProtocol(spec.trigger as AdviceTrigger);
  const ternary = spec.outcomes === 'ternary';
  const recognise = spec.task === 'recognise';
  const remarks = recognise ? REMARKS.recognise(spec.outcomes) : REMARKS.point;
  const outcomeField =
    plain && (recognise || !ternary)
      ? ''
      : `"outcome": ${plain ? '' : '"no" | '}"yes"${ternary ? ' | "unsure"' : ''}, `;
  const whyField = plain ? '' : '"why": string, ';
  const envelope =
    spec.envelope === 'guard'
      ? `{ ${outcomeField}${whyField}"findings": [ { "severity": "advisory", "description": string, "location"?: string } ] }`
      : `{ ${outcomeField}${whyField}"snippets": string[], "layers": string[], "confidence": number }`;
  const when = recognise
    ? `Only when ${spec.envelope === 'guard' ? 'they are' : 'it is'} in one of your regions${ternary ? ', or may be' : ''}`
    : `Only when ${spec.envelope === 'guard' ? 'they touch' : 'it touches'} something your domain says already exists${ternary ? ', or may' : ''}`;
  const lines = [header(spec)];
  if (plain) {
    lines.push(`${NO_COMMENT_RULE} Here it means ${nothingMeans(spec)}.`);
    lines.push(`${when}, respond with JSON only, exactly this shape: ${envelope}.`);
  } else {
    lines.push(
      `Every answer is one JSON object, exactly this shape: ${envelope}. Where the charter says to answer ${NO_COMMENT}, answer "outcome": "no" instead, with the lists empty: "no" means ${nothingMeans(spec)}.`,
    );
    lines.push(
      '"why" is one or two sentences: what the moment asks for, and what in your knowledge it does or does not touch.',
    );
  }
  if (!recognise && ternary)
    lines.push(
      '"outcome" is "yes" when your knowledge names what it touches, "unsure" when it may touch your domain but your knowledge does not settle it; either way the remarks are what you would point at.',
    );
  lines.push(
    spec.envelope === 'guard'
      ? `One finding per remark: ${remarks}, its "description" the remark. "location" names the call (its number or tool) and file the remark is about.`
      : `"snippets" are ${remarks}; "layers" are IDs of your domain's layers to inject${recognise ? ' (none for a recogniser)' : ''}; at least one of them is non-empty${plain ? '' : ' unless "outcome" is "no"'}. "confidence" is a number from 0 to 1.`,
  );
  lines.push(STRICT_RULE);
  return lines.join('\n');
}

/** A stage's answer, read under its protocol. */
export interface StageReading {
  readonly outcome: ClassifyOutcome;
  /** `reason: inline`: the why given with the decision. */
  readonly why?: string;
  /** The remarks in order: advice snippets, or guard finding descriptions. */
  readonly remarks: readonly string[];
  readonly advice?: AdviceAnswer;
  readonly findings?: readonly GuardAnswerFinding[];
  /** A point stage with remarks: the pointer they make. */
  readonly pointer?: WardenPointer;
  /** A recognise stage: the regions it named. */
  readonly regions?: readonly Recognition[];
}

/**
 * Read a stage's answer strictly under its protocol. The default stage reads exactly as today's
 * advice and guard validators read. A malformed answer is an error, counted, never guessed: a pointer
 * shape the stage did not offer (choose-one with `pointer.any` off), a recogniser line in no shape,
 * a missing or unexpected outcome or why.
 */
export function readStageAnswer(
  content: unknown,
  spec: ProtocolSpec,
  pointer?: PointerSettings,
): StageReading | { error: string } {
  const ternary = spec.outcomes === 'ternary';
  const plain = spec.reason !== 'inline';
  const outcomeKey = !plain || (ternary && spec.task === 'point');
  let envelope:
    | { advice: AdviceAnswer; outcome: ClassifyOutcome; why?: string }
    | { findings: GuardAnswerFinding[]; outcome: ClassifyOutcome; why?: string };
  if (!outcomeKey) {
    const read =
      spec.envelope === 'guard' ? validateGuardResponse(content) : validateAdviceResponse(content);
    if ('error' in read) return read;
    const nothing = !!read.noComment;
    envelope =
      'findings' in read
        ? { findings: read.findings, outcome: nothing ? 'no' : 'yes' }
        : { advice: read, outcome: nothing ? 'no' : 'yes' };
  } else {
    const kind = spec.envelope;
    if (typeof content !== 'string') return { error: `${kind} response is not text` };
    const max = kind === 'guard' ? MAX_GUARD_RESPONSE : MAX_ADVICE_RESPONSE;
    if (content.length > max) return { error: `${kind} response exceeds ${max} characters` };
    const answer = protocolAnswer(content);
    if ('error' in answer) return { error: `${kind} ${answer.error}` };
    if (answer.noComment) {
      if (!plain)
        return { error: `${kind} answer must be JSON with "outcome": "no", not ${NO_COMMENT}` };
      envelope =
        kind === 'guard'
          ? { findings: [], outcome: 'no' }
          : { advice: { layers: [], snippets: [], confidence: 0, noComment: true }, outcome: 'no' };
    } else {
      const { outcome, why, ...rest } = answer.value;
      const allowed: readonly unknown[] = [
        ...(plain ? [] : ['no']),
        'yes',
        ...(ternary ? ['unsure'] : []),
      ];
      if (!allowed.includes(outcome))
        return {
          error: `${kind} answer requires "outcome": ${allowed.map((o) => `"${o}"`).join(' | ')}`,
        };
      if (!plain && (typeof why !== 'string' || !why.trim()))
        return { error: `${kind} answer requires "why": non-empty string` };
      if (plain && why !== undefined)
        return { error: `${kind} answer has 1 field(s) outside the protocol` };
      const o = outcome as ClassifyOutcome;
      const withWhy = plain ? {} : { why: (why as string).trim() };
      if (o === 'no') {
        const empty = (v: unknown) => Array.isArray(v) && v.length === 0;
        const ok =
          kind === 'guard'
            ? Object.keys(rest).every((k) => k === 'findings') && empty(rest.findings)
            : Object.keys(rest).every((k) => ['snippets', 'layers', 'confidence'].includes(k)) &&
              empty(rest.snippets) &&
              empty(rest.layers);
        if (!ok)
          return {
            error: `${kind} answer "outcome": "no" must carry empty lists and nothing else`,
          };
        envelope =
          kind === 'guard'
            ? { findings: [], outcome: 'no', ...withWhy }
            : {
                advice: { layers: [], snippets: [], confidence: 0, noComment: true },
                outcome: 'no',
                ...withWhy,
              };
      } else {
        const read = kind === 'guard' ? guardValue(rest) : adviceValue(rest);
        if ('error' in read) return read;
        envelope =
          'findings' in read
            ? { findings: read.findings, outcome: o, ...withWhy }
            : { advice: read, outcome: o, ...withWhy };
      }
    }
  }
  const remarks =
    'findings' in envelope ? envelope.findings.map((f) => f.description) : envelope.advice.snippets;
  const base = {
    outcome: envelope.outcome,
    ...(envelope.why !== undefined ? { why: envelope.why } : {}),
    remarks,
    ...('findings' in envelope ? { findings: envelope.findings } : { advice: envelope.advice }),
  };
  if (envelope.outcome === 'no') return base;
  if (spec.task === 'recognise' && !remarks.length)
    return { error: 'recogniser answer names no region' };
  if (!remarks.length) return base;
  if (spec.task === 'recognise') {
    const { regions, errors } = parseRecognition(remarks.join('\n'), spec.outcomes);
    if (errors.length)
      return {
        error: `recogniser answer has ${errors.length} line(s) in no shape (<region id>: <why>)`,
      };
    if (!regions.length) return { error: 'recogniser answer names no region' };
    const outcome = regions.some((r) => r.outcome === 'yes') ? 'yes' : 'unsure';
    return { ...base, outcome, regions };
  }
  const read = parseWardenPointer(remarks);
  if (read.shape === 'choose-one' && pointer && !pointer.any)
    return { error: 'a choose-one set is not offered at this stage (pointer.any is off)' };
  return { ...base, pointer: read };
}

// ---------------------------------------------------------------------------
// Follow-up: "why?" asked after the answer (`reason: followup`), descriptive only
// ---------------------------------------------------------------------------

/**
 * Asked after a stage's answer, with the answer quoted back: a quoted-answer review on the primed
 * transport, not the stage's own turn, so what it returns describes the answer and never changes it.
 */
export const FOLLOWUP_QUESTION = `This is a follow-up question, not a new moment. Above is the answer given to this moment. In at most two short lines, explain it:
1. What the moment asks for, in your words.
2. Which part of your domain it does or does not touch, and why.
Then one last line: \`REVISED: KEEP\` if that answer stands, or \`REVISED: YES\` / \`REVISED: UNSURE\` / \`REVISED: NO\` if on reflection another answer is right.`;

const followupLines = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** The follow-up's explanation and its last `REVISED:` verdict, wherever it stands. */
export function parseFollowup(text: string): {
  why?: string;
  revised?: 'keep' | ClassifyOutcome;
} {
  const all = [...text.matchAll(/REVISED:\s*\**\s*(KEEP|YES|UNSURE|NO)\b/gi)];
  const last = all.at(-1);
  const why = followupLines(text)
    .filter((l) => !/REVISED:/i.test(l))
    .join(' ')
    .replace(/`/g, '')
    .trim();
  return {
    ...(why ? { why } : {}),
    ...(last ? { revised: last[1]!.toLowerCase() as 'keep' | ClassifyOutcome } : {}),
  };
}
