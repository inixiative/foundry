// Dev mode (R-2026-11-25-05): with a remote Chorus, the orchestrator sends one `chorus.*` call per
// moment for every Warden it would have asked, never its local Wardens' models, and reads the answer
// back into the same plan, chime, journal and guard report as a local Warden's.

import { describe, expect, it } from 'bun:test';
import {
  type CompletionResult,
  ContextLayer,
  ContextStack,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import type { ChorusOperation } from '@inixiative/signet';
import { FlowOrchestrator } from '../src/agents/flow-orchestrator';
import { Librarian } from '../src/agents/librarian';
import { Warden } from '../src/agents/warden';
import {
  type ChorusCallOutcome,
  type ChorusTransport,
  createChorusRemote,
} from '../src/providers/chorus-client';

const CALL_ID = '00000000-0000-4000-8000-000000000001';

/** A local model that must never be asked: dev mode's Wardens are Chorus's. */
const untouchable: LLMProvider = {
  id: 'local',
  async complete(): Promise<CompletionResult> {
    throw Error('a local Warden was asked in dev mode');
  },
};

interface Sent {
  operation: ChorusOperation;
  projectId: string;
  input: Record<string, unknown>;
}

type Reply = (operation: ChorusOperation, input: Record<string, unknown>) => unknown;

/** Speaks for every asked domain, or answers what `reply` says. */
const speakAll: Reply = (operation, input) => {
  const domains = (input.domains as string[] | undefined) ?? [];
  if (operation === 'chorus.guard')
    return {
      ok: true,
      result: {
        rosterRevision: 'r1',
        findings: domains.map((domain) => ({
          domain,
          severity: 'advisory',
          description: `${domain} finding`,
        })),
        checkedDomains: domains,
        skippedDomains: [],
        elapsedMs: 1,
      },
    };
  return {
    ok: true,
    result: {
      rosterRevision: 'r1',
      contributions: domains.map((domain) => ({
        callId: CALL_ID,
        domain,
        outcome: 'spoke',
        snippets: [`${domain} says: see docs/${domain}.md`],
        layers: [],
        confidence: 0.9,
      })),
      elapsedMs: 1,
    },
  };
};

function setup(reply: Reply = speakAll) {
  const signals = new SignalBus();
  const stack = new ContextStack([]);
  const librarian = new Librarian({ signals, stack });
  const warden = (domain: string, guardTriggers: string[]) =>
    new Warden({
      domain,
      cache: new ContextLayer({ id: `${domain}-cache` }),
      signals,
      llm: untouchable,
      guardTriggers,
    });
  const wardens = new Map([
    ['convention', warden('convention', ['file_write'])],
    ['security', warden('security', ['file_write', 'bash'])],
  ]);
  const sent: Sent[] = [];
  const state = { reply };
  const transport: ChorusTransport = async (operation, call) => {
    const input = call.input as Record<string, unknown>;
    sent.push({ operation, projectId: call.projectId, input });
    return state.reply(operation, input) as ChorusCallOutcome<typeof operation>;
  };
  const remote = createChorusRemote({ projectId: 'proj', endpoint: 'http://chorus', transport });
  const orchestrator = new FlowOrchestrator({
    wardens,
    librarian,
    stack,
    signals,
    chorus: () => remote,
  });
  return { orchestrator, sent, state };
}

describe('dev mode: one Chorus call per moment', () => {
  it('a user message is one chorus.advise for every Warden, and each spoke chimes in', async () => {
    const { orchestrator, sent } = setup();
    const plan = await orchestrator.preMessage('add a route');
    expect(sent.map((s) => [s.operation, s.projectId])).toEqual([['chorus.advise', 'proj']]);
    expect(sent[0]!.input.domains).toEqual(['convention', 'security']);
    expect(sent[0]!.input.moment).toBe('add a route');
    const { decoration } = await orchestrator.hydrateDelta(plan);
    const chimes = decoration.blocks
      .filter((b) => b.placement === 'after-message')
      .map((b) => b.text);
    expect(chimes).toEqual([
      'The convention Warden chimed in:\n- convention says: see docs/convention.md',
      'The security Warden chimed in:\n- security says: see docs/security.md',
    ]);
  });

  it('each between-turn trigger is its own operation', async () => {
    const { orchestrator, sent } = setup();
    await orchestrator.brief({ childThreadId: 'c1', handoffId: 'h1', prompt: 'audit auth' });
    await orchestrator.consume({ itemId: 'T-1', name: 'T-1', tool: 'Read', text: 'fix login' });
    await orchestrator.milestone({
      milestoneId: 'm1',
      kind: 'publish',
      tool: 'Bash',
      detail: 'git push',
      when: 'before',
    });
    await orchestrator.handBack({ turnId: 't1', text: 'done, pushed' });
    expect(sent.map((s) => s.operation)).toEqual([
      'chorus.brief',
      'chorus.consumed',
      'chorus.milestone',
      'chorus.handBack',
    ]);
  });

  it('each Warden journals the call exactly as sent', async () => {
    const { orchestrator, sent } = setup();
    const plan = await orchestrator.preMessage('add a route');
    for (const c of plan.contributions) {
      expect(c.request).toMatchObject({
        status: 'supplied',
        phase: 'advice',
        providerId: 'chorus-remote',
      });
      const journalled = c.request.status === 'supplied' ? c.request.messages[0]!.content : '';
      expect(JSON.parse(String(journalled))).toEqual({
        operation: 'chorus.advise',
        projectId: 'proj',
        input: sent[0]!.input,
      });
    }
  });

  it('a refusal (a warming host) is not admitted: degraded, nothing chimes', async () => {
    const { orchestrator } = setup(() => ({ ok: false, refusal: 'chorus_warming' }));
    const plan = await orchestrator.preMessage('first message');
    expect(plan.contributions.map((c) => [c.outcome, c.reason, c.catchesUp])).toEqual([
      [{ status: 'not-sent', cause: 'not-admitted' }, 'Chorus refused: chorus_warming', undefined],
      [{ status: 'not-sent', cause: 'not-admitted' }, 'Chorus refused: chorus_warming', undefined],
    ]);
    const { decoration } = await orchestrator.hydrateDelta(plan);
    expect(decoration.blocks.filter((b) => b.placement === 'after-message')).toEqual([]);
  });

  it('a Warden Chorus holds no session for catches up: its own missed message rides its own call', async () => {
    const { orchestrator, sent, state } = setup((operation, input) => {
      const answer = speakAll(operation, input) as {
        result: { contributions: Array<Record<string, unknown>> };
      };
      answer.result.contributions[1] = {
        callId: CALL_ID,
        domain: 'security',
        outcome: 'not-sent',
        reason: 'no session held',
        catchesUp: true,
        snippets: [],
        layers: [],
        confidence: 0,
      };
      return answer;
    });
    const plan = await orchestrator.preMessage('first message');
    expect(plan.contributions.map((c) => [c.domain, c.outcome, c.catchesUp])).toEqual([
      ['convention', { status: 'answered', result: 'spoke' }, undefined],
      ['security', { status: 'not-sent', cause: 'not-held' }, true],
    ]);
    state.reply = speakAll;
    await orchestrator.preMessage('second message');
    // One call per distinct catch-up: the convention Warden missed nothing, the security one a message.
    expect(sent.slice(1).map((s) => [s.input.domains, s.input.earlier])).toEqual([
      [['convention'], undefined],
      [['security'], { messages: ['first message'], dropped: 0 }],
    ]);
  });

  it('a host past its time is a timeout; a Warden that failed on a stage timeout is too', async () => {
    const { orchestrator, state } = setup(() => ({
      ok: false,
      failure: 'timeout',
      message: 'Chorus did not answer within 6000ms',
    }));
    let plan = await orchestrator.preMessage('one');
    expect(plan.contributions.map((c) => c.outcome)).toEqual([
      { status: 'failed', cause: 'timeout' },
      { status: 'failed', cause: 'timeout' },
    ]);
    state.reply = (operation, input) => {
      const answer = speakAll(operation, input) as {
        result: { contributions: Array<Record<string, unknown>> };
      };
      answer.result.contributions = answer.result.contributions.map((c) => ({
        ...c,
        outcome: 'failed',
        snippets: [],
        stages: [
          {
            stage: c.domain === 'security' ? 'recognise' : 'point',
            outcome: c.domain === 'security' ? 'timeout' : 'error',
          },
        ],
      }));
      return answer;
    };
    plan = await orchestrator.preMessage('two');
    expect(plan.contributions.map((c) => [c.domain, c.outcome])).toEqual([
      ['convention', { status: 'failed', cause: 'provider-error' }],
      ['security', { status: 'failed', cause: 'timeout' }],
    ]);
  });

  it('no token or no host is not sent, never a failure', async () => {
    const { orchestrator } = setup(() => ({
      ok: false,
      failure: 'no-token',
      message: 'no Chorus dev token in the keychain or environment',
    }));
    const plan = await orchestrator.preMessage('one');
    expect(plan.contributions.map((c) => c.outcome)).toEqual([
      { status: 'not-sent', cause: 'not-admitted' },
      { status: 'not-sent', cause: 'not-admitted' },
    ]);
  });

  it('Retry sends only the chosen Wardens', async () => {
    const { orchestrator, sent } = setup();
    const report = await orchestrator.retry('milestone', 'git push', ['security']);
    expect(sent.map((s) => [s.operation, s.input.domains])).toEqual([
      ['chorus.milestone', ['security']],
    ]);
    expect(report.contributions.map((c) => c.domain)).toEqual(['security']);
  });

  it('a guard is one chorus.guard for the Wardens its triggers gate', async () => {
    const { orchestrator, sent } = setup();
    const report = await orchestrator.postAction({
      turnId: 't1',
      observations: [{ tool: 'bash', input: { command: 'ls' }, output: 'a.ts' }],
    });
    expect(sent.map((s) => [s.operation, s.input.domains])).toEqual([
      ['chorus.guard', ['security']],
    ]);
    expect(report.outcomes.map((o) => [o.domain, o.outcome])).toEqual([
      ['security', { status: 'answered', result: 'findings' }],
    ]);
  });

  it('a guard is built once: every Warden journals it, a skipped one is not held', async () => {
    const { orchestrator, sent } = setup((operation, input) => ({
      ok: true,
      result: {
        rosterRevision: 'r1',
        findings: [],
        checkedDomains: ['convention'],
        skippedDomains: ['security'],
        elapsedMs: 1,
      },
    }));
    const requests: string[] = [];
    const report = await orchestrator.postAction(
      { turnId: 't1', observations: [{ tool: 'file_write', input: { path: 'a.ts' } }] },
      {
        onRequest: (_domain, evidence) => {
          requests.push(String(evidence.messages[0]!.content));
        },
      },
    );
    expect(sent).toHaveLength(1);
    const call = JSON.stringify({
      operation: 'chorus.guard',
      projectId: 'proj',
      input: sent[0]!.input,
    });
    expect(requests).toEqual([call, call]);
    expect(report.outcomes.map((o) => [o.domain, o.outcome, o.noComment])).toEqual([
      ['convention', { status: 'answered', result: 'all-clear' }, true],
      ['security', { status: 'not-sent', cause: 'not-held' }, undefined],
    ]);
  });

  it('a guard every Warden’s journal refuses is never sent', async () => {
    const { orchestrator, sent } = setup();
    const report = await orchestrator.postAction(
      { turnId: 't1', observations: [{ tool: 'file_write', input: { path: 'a.ts' } }] },
      {
        onRequest: () => {
          throw Object.assign(Error('journal refused'), { admission: 'not-admitted' });
        },
      },
    );
    expect(sent).toHaveLength(0);
    expect(report.outcomes.map((o) => [o.outcome, o.request?.status])).toEqual([
      [{ status: 'not-sent', cause: 'not-admitted' }, 'supplied'],
      [{ status: 'not-sent', cause: 'not-admitted' }, 'supplied'],
    ]);
  });
});
