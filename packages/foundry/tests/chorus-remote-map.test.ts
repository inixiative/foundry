// Dev mode's remote Chorus in the Wardens' terms (R-2026-11-25-05): each call built within Chorus's
// limits, each answer read back as a local Warden's, and the degraded strip reading those answers.

import { describe, expect, test } from 'bun:test';
import { chorusMomentLimit } from '@inixiative/signet';
import { degradedGuards, degradedWardens } from '../src/agents/chorus-degraded';
import { chorusRemoteMap } from '../src/agents/chorus-remote-map';
import type { ReviewInput } from '../src/agents/warden';

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const asked = [
  { domain: 'convention', threadKnowledge: 'uses bun' },
  { domain: 'security', threadKnowledge: '' },
];
const domains = asked.map((a) => a.domain);

const call = (
  trigger: Parameters<typeof chorusRemoteMap.adviceCall>[0]['trigger'] = 'user-message',
) =>
  chorusRemoteMap.adviceCall({
    trigger,
    moment: 'add a route',
    threadState: 'state',
    asked,
    deadlineMs: 4_000,
    earlier: { messages: ['first'], dropped: 2 },
    capturedAt: 1,
  });

const contribution = (domain: string, extra: Record<string, unknown>) => ({
  callId: ID(1),
  domain,
  outcome: 'no-comment' as const,
  snippets: [],
  layers: [],
  confidence: 0,
  ...extra,
});

describe('adviceCall', () => {
  test('one operation per trigger', () => {
    expect(call('user-message').operation).toBe('chorus.advise');
    expect(call('subagent-spawn').operation).toBe('chorus.brief');
    expect(call('consumed').operation).toBe('chorus.consumed');
    expect(call('milestone').operation).toBe('chorus.milestone');
    expect(call('hand-back').operation).toBe('chorus.handBack');
  });

  test('the asked domains, their knowledge, and earlier messages only on a user message', () => {
    const advise = call();
    expect(advise.input).toEqual({
      moment: 'add a route',
      threadState: 'state',
      deadlineMs: 4_000,
      earlier: { messages: ['first'], dropped: 2 },
      threadKnowledge: { convention: 'uses bun' },
      domains,
    });
    expect('earlier' in call('milestone').input).toBe(false);
    // Each Warden's evidence is its own slice: no other Warden's knowledge.
    expect(advise.evidence.get('security')?.messages[0]?.content).not.toContain('uses bun');
  });

  test('clips the moment, clamps the deadline, and never sends a domain Chorus cannot carry', () => {
    const prepared = chorusRemoteMap.adviceCall({
      trigger: 'user-message',
      moment: 'x'.repeat(chorusMomentLimit + 10),
      threadState: '',
      asked: [...asked, { domain: 'bad domain!', threadKnowledge: '' }],
      deadlineMs: 10,
      capturedAt: 1,
    });
    expect((prepared.input as { moment: string }).moment).toHaveLength(chorusMomentLimit);
    expect(prepared.input.deadlineMs).toBe(1_000);
    expect(prepared.input.domains).toEqual(domains);
    const answers = chorusRemoteMap.advice(
      prepared,
      { ok: true, result: { rosterRevision: 'r1', contributions: [], elapsedMs: 1 } },
      [...domains, 'bad domain!'],
      false,
    );
    expect(answers.get('bad domain!')?.request.status).toBe('not-sent');
  });
});

describe('advice', () => {
  test('a spoke, a no-comment, and a domain the host did not name', () => {
    const prepared = call();
    const answers = chorusRemoteMap.advice(
      prepared,
      {
        ok: true,
        result: {
          rosterRevision: 'r7',
          contributions: [
            contribution('convention', {
              outcome: 'spoke',
              snippets: ['Use the helper.'],
              layers: ['L1'],
              confidence: 0.8,
              stages: [{ stage: 'recognise', outcome: 'yes', elapsedMs: 3 }],
            }),
          ],
          elapsedMs: 4,
        },
      },
      domains,
      false,
    );
    const spoke = answers.get('convention');
    expect(spoke?.outcome).toEqual({ status: 'answered', result: 'spoke' });
    expect(spoke?.snippets).toEqual(['Use the helper.']);
    expect(spoke?.classified).toMatchObject({ delivered: true, outcome: 'yes', finalStage: 0 });
    expect(spoke?.request.status).toBe('supplied');
    const missing = answers.get('security');
    expect(missing?.outcome).toEqual({ status: 'failed', cause: 'provider-error' });
    expect(missing?.reason).toContain('revision r7');
  });

  test('a warming host is not-held, catching up on a user message, and not degraded', () => {
    const answers = chorusRemoteMap.advice(
      call(),
      { ok: false, refusal: 'chorus_warming' },
      domains,
      true,
    );
    const answer = answers.get('convention');
    expect(answer?.outcome).toEqual({ status: 'not-sent', cause: 'not-held' });
    expect(answer?.catchesUp).toBe(true);
    const rows = [...answers].map(([domain, a]) => ({ domain, ...a }));
    expect(degradedWardens(rows)).toEqual([]);
  });

  test('an unavailable host is not-admitted and every asked Warden degraded', () => {
    const answers = chorusRemoteMap.advice(
      call(),
      { ok: false, refusal: 'chorus_unavailable' },
      domains,
      true,
    );
    expect(answers.get('security')?.outcome).toEqual({ status: 'not-sent', cause: 'not-admitted' });
    const rows = [...answers].map(([domain, a]) => ({ domain, ...a }));
    expect(degradedWardens(rows).map((d) => [d.domain, d.kind])).toEqual([
      ['convention', 'not-started'],
      ['security', 'not-started'],
    ]);
  });

  test('a transport timeout fails every Warden as a timeout', () => {
    const answers = chorusRemoteMap.advice(
      call(),
      { ok: false, failure: 'timeout', message: 'Chorus did not answer within 9000ms' },
      domains,
      false,
    );
    const rows = [...answers].map(([domain, a]) => ({ domain, ...a }));
    expect(degradedWardens(rows).map((d) => d.kind)).toEqual(['timeout', 'timeout']);
  });

  test('a per-Warden not-sent with catchesUp is not-held; without it, not-admitted', () => {
    const answers = chorusRemoteMap.advice(
      call(),
      {
        ok: true,
        result: {
          rosterRevision: 'r1',
          contributions: [
            contribution('convention', { outcome: 'not-sent', catchesUp: true, reason: 'cold' }),
            contribution('security', { outcome: 'not-sent', reason: 'down' }),
          ],
          elapsedMs: 1,
        },
      },
      domains,
      true,
    );
    expect(answers.get('convention')).toMatchObject({
      outcome: { status: 'not-sent', cause: 'not-held' },
      catchesUp: true,
    });
    expect(answers.get('security')?.outcome).toEqual({ status: 'not-sent', cause: 'not-admitted' });
  });
});

describe('guard', () => {
  const prepared = chorusRemoteMap.guardCall({
    calls: [{ tool: 'Edit', input: { file_path: 'a.ts' }, filesAffected: ['a.ts'], output: 'ok' }],
    threadState: '',
    asked,
    deadlineMs: 5_000,
    capturedAt: 1,
  });

  test('one call over the observations for every gated Warden', () => {
    expect(prepared.operation).toBe('chorus.guard');
    expect(prepared.input.observations).toEqual([
      {
        callIndex: 0,
        tool: 'Edit',
        filePath: 'a.ts',
        summary: '{"file_path":"a.ts"}',
        detail: 'ok',
      },
    ]);
    expect(prepared.input.domains).toEqual(domains);
  });

  test('findings, an all-clear, and a skipped Warden', () => {
    const results = chorusRemoteMap.guard(
      prepared,
      {
        ok: true,
        result: {
          rosterRevision: 'r1',
          findings: [
            { domain: 'convention', severity: 'advisory', description: 'Use the helper.' },
          ],
          checkedDomains: ['convention'],
          skippedDomains: ['security'],
          elapsedMs: 1,
        },
      },
      domains,
    );
    expect(results.get('convention')).toMatchObject({
      outcome: { status: 'answered', result: 'findings' },
      findings: [{ severity: 'advisory', description: 'Use the helper.' }],
    });
    const skipped = results.get('security');
    expect(skipped?.outcome).toEqual({ status: 'failed', cause: 'provider-error' });
    const rows = [...results].map(([domain, r]) => ({
      domain,
      outcome: r.outcome,
      findings: r.findings.length,
      ...(r.error ? { error: r.error } : {}),
    }));
    expect(degradedGuards(rows).map((d) => [d.domain, d.kind, d.reason])).toEqual([
      ['security', 'error', 'Chorus skipped its check'],
    ]);
  });

  test('a refused guard is not-sent for every Warden', () => {
    const results = chorusRemoteMap.guard(
      prepared,
      { ok: false, refusal: 'unknown_project' },
      domains,
    );
    expect(results.get('convention')).toMatchObject({
      outcome: { status: 'not-sent', cause: 'not-admitted' },
      admission: 'not-admitted',
    });
  });
});

describe('review', () => {
  const work: ReviewInput = {
    evidence: { kind: 'dispatch', id: 't1', timestamp: 1 },
    agentId: 'a1',
    userMessage: 'add a route',
    output: 'done',
    ok: true,
    toolObservations: [{ tool: 'Bash', input: 'bun test', output: '3 pass' }],
  };

  test('one call carrying every asked Warden', () => {
    const input = chorusRemoteMap.reviewCall({ work, threadState: '', asked, deadlineMs: 20_000 });
    expect(input).toEqual({
      workSummary: 'User message:\nadd a route\n\nAgent output:\ndone',
      observations: [{ callIndex: 0, tool: 'Bash', summary: 'bun test', detail: '3 pass' }],
      threadKnowledge: { convention: 'uses bun' },
      domains,
      deadlineMs: 20_000,
    });
  });

  test('each Warden reads its own update: learn, none, empty, too long, refused', () => {
    const outcome = {
      ok: true as const,
      result: {
        rosterRevision: 'r1',
        threadKnowledgeUpdates: { convention: 'now uses hono', security: 'x'.repeat(50) },
        elapsedMs: 1,
      },
    };
    expect(chorusRemoteMap.review(outcome, 'convention', 100)).toMatchObject({
      decision: 'learn',
      knowledge: 'now uses hono',
    });
    expect(chorusRemoteMap.review(outcome, 'other', 100).decision).toBe('no-comment');
    expect(chorusRemoteMap.review(outcome, 'security', 10).decision).toBe('invalid');
    expect(
      chorusRemoteMap.review({ ok: false, refusal: 'chorus_unavailable' }, 'convention', 100),
    ).toMatchObject({ decision: 'error', reason: 'Chorus refused: chorus_unavailable' });
  });
});
