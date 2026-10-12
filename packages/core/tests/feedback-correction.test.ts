import { describe, expect, test } from 'bun:test';
import {
  CORRECTION_CLASSIFY_PREFIX,
  correctionClassifyMessages,
  detectCorrection,
  extractCorrections,
  parseCorrectionClassifications,
  scrubSecrets,
  type TranscriptTurn,
} from '../src';

const user = (text: string, extra: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  role: 'user',
  timestamp: '2026-06-12T10:00:00Z',
  text,
  ...extra,
});
const agent = (text: string): TranscriptTurn => ({
  role: 'assistant',
  timestamp: '2026-06-12T10:01:00Z',
  text,
});

describe('detectCorrection', () => {
  test('a repeat marker outranks an instruction', () => {
    const result = detectCorrection("Again, don't make me track approvals. Just merge it.");
    expect(result).toMatchObject({ hit: true, signal: 'repeat', phrase: 'Again' });
    expect(result.signals).toEqual(['repeat', 'explicit']);
    expect(result.score).toBe(1);
  });

  test('standing instructions and challenges are explicit', () => {
    expect(detectCorrection('From now on run the full check').signal).toBe('explicit');
    expect(detectCorrection('Why would you add an approver id? The audit log has it').signal).toBe(
      'explicit',
    );
  });

  test('an opener counts only at the start', () => {
    expect(detectCorrection('No, use the existing helper').signals).toContain('opener');
    expect(detectCorrection('There is no helper for that').hit).toBe(false);
  });

  test('a bare "no" to a question the agent asked ranks low', () => {
    expect(detectCorrection('No.', 'Should I open a PR for this?').score).toBeLessThan(
      detectCorrection('No.', 'I opened a PR for this.').score,
    );
  });

  test('ordinary requests are not candidates', () => {
    expect(detectCorrection('How does our WebSocket work?')).toEqual({
      hit: false,
      signals: [],
      score: 0,
    });
  });
});

describe('extractCorrections', () => {
  test('an interruption marks the next message, with the agent turn before it', () => {
    const { corrections } = extractCorrections('s1', [
      user('add a util module with a constant'),
      agent("I'll add util.ts with the constant."),
      user('[Request interrupted by user]\nuse a named export not default', { id: 'm1' }),
    ]);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      id: 's1:m1',
      signal: 'interruption',
      correction: 'use a named export not default',
    });
    expect(corrections[0]!.before).toContain('util.ts');
  });

  test('a separate interruption record carries over to the next message', () => {
    const { corrections } = extractCorrections('s1', [
      agent('Running the subset.'),
      user('[Request interrupted by user for tool use]'),
      user('run all of it'),
    ]);
    expect(corrections.map((event) => event.signal)).toEqual(['interruption']);
  });

  test('corrective phrasing without an interruption is flagged; ids are stable without record ids', () => {
    const turns = [
      user('build the thing'),
      agent('Built it with approach A.'),
      user('actually, use approach B instead'),
    ];
    const first = extractCorrections('s1', turns).corrections;
    expect(first.map((event) => event.signal)).toEqual(['opener']);
    expect(extractCorrections('s1', turns).corrections[0]!.id).toBe(first[0]!.id);
  });

  test('scrubs secrets from what it keeps', () => {
    const { corrections, secretsScrubbed } = extractCorrections('s1', [
      agent('Using sk-ant-abcdefghijklmnop for the call.'),
      user('never paste ghp_abcdefghijklmnopqrstuvwxyz into chat'),
    ]);
    expect(secretsScrubbed).toBe(2);
    expect(JSON.stringify(corrections)).not.toMatch(/sk-ant-abc|ghp_abc/);
  });
});

describe('classification', () => {
  test('one batch carries every candidate with its prior agent turn', () => {
    const [system, prompt] = correctionClassifyMessages([
      { before: '', correction: 'never do X' },
      { before: 'Did Y.', correction: 'stop doing Y' },
    ]);
    expect(system!.content).toContain('"results"');
    expect(prompt!.content.startsWith(CORRECTION_CLASSIFY_PREFIX)).toBe(true);
    expect(prompt!.content).toContain('## M1');
    expect(prompt!.content).toContain('(start of session)');
    expect(prompt!.content).toContain('## M2');
  });

  test('parses each result by id; missing or malformed answers are undefined', () => {
    const parsed = parseCorrectionClassifications(
      `ok {"results":{
        "M1":{"isCorrection":true,"category":"process","statements":["Never X."],"sharp":true},
        "M2":{"isCorrection":true,"category":"scope","statements":["x"],"sharp":false},
        "M3":{"isCorrection":false},
        "M5":{"nope":1}}}`,
      5,
    );
    expect(parsed).toEqual([
      { isCorrection: true, category: 'other', statements: ['Never X.'], sharp: true },
      { isCorrection: true, category: 'scope', statements: [], sharp: false },
      { isCorrection: false, category: 'other', statements: [], sharp: false },
      undefined,
      undefined,
    ]);
    expect(parseCorrectionClassifications('no json', 2)).toEqual([undefined, undefined]);
    expect(
      parseCorrectionClassifications(
        '{"results":{"M1":{"isCorrection":false}}} trailing {brace}',
        1,
      )[0]?.isCorrection,
    ).toBe(false);
  });
});

describe('scrubSecrets', () => {
  test('keeps the label and hides the value', () => {
    const { text, hits } = scrubSecrets(
      'curl -H "Authorization: Bearer abcdefghijklmnopqrstuv" postgres://app:hunter22@db:5432/x RAILWAY_TOKEN=abcd1234efgh',
    );
    expect(hits).toBe(3);
    expect(text).toContain('Bearer [REDACTED:credential]');
    expect(text).toContain('postgres://app:[REDACTED:password]@db');
    expect(text).toContain('RAILWAY_TOKEN=[REDACTED:value]');
  });

  test('a key cut by truncation is still scrubbed', () => {
    const { corrections } = extractCorrections('s1', [
      user(`never paste keys like ${'x'.repeat(3990)} sk-ant-abcdefghijklmnopqrst`),
    ]);
    expect(corrections[0]!.correction).not.toContain('sk-ant');
  });

  test('leaves ordinary prose alone', () => {
    expect(scrubSecrets('just ordinary prose about skiing')).toEqual({
      text: 'just ordinary prose about skiing',
      hits: 0,
    });
  });
});
