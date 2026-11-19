import { expect, test } from 'bun:test';
import {
  guardOutcomes,
  learningEntries,
  participantRequest,
} from '../src/viewer/ui/inspector-data.js';

// Inspector projections for the historical phase record (Fable, CORE-006 LI). Recorded fields only;
// absence is labelled; nothing is recomputed from current source, cache or protocol.

const supplied = {
  status: 'supplied',
  phase: 'guard',
  providerId: 'controlled-provider',
  capturedAt: 7,
  messages: [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ],
};

test('guards: per-observation status with per-Warden outcomes; pending and failed checks are never an all-clear; absent record is null', () => {
  const trace = {
    root: {
      annotations: {
        guards: [
          {
            observation: {
              momentId: 's1',
              tool: 'Write',
              callId: 'c1',
              dispatchId: 'd1',
              agentId: 'worker',
            },
            status: 'reported',
            domainsChecked: ['architecture', 'testing'],
            failed: ['testing'],
            findings: 1,
            outcomes: [
              {
                domain: 'architecture',
                outcome: { status: 'answered', result: 'findings' },
                findings: 1,
                threadKnowledgeRevision: 1,
                request: { ...supplied, phase: 'guard' },
              },
              {
                domain: 'testing',
                outcome: { status: 'failed', cause: 'provider-error' },
                findings: 0,
                error: 'CONTROLLED_REFUSAL',
                admission: {
                  nativeOutcome: 'unknown',
                  localOutcome: 'rejected',
                  dispatch: 'attempted',
                },
                request: { status: 'not-sent', phase: 'guard', reason: 'cold-cache' },
              },
            ],
          },
          { observation: { momentId: 's2', tool: 'Bash' }, status: 'pending' },
          {
            observation: { momentId: 's3', tool: 'Edit', callId: 'c3' },
            status: 'failed',
            error: 'post-action threw',
          },
        ],
      },
    },
  };
  const guards = guardOutcomes(trace)!;
  expect(guards).toHaveLength(3);
  expect(guards[0]).toMatchObject({
    tool: 'Write',
    callId: 'c1',
    dispatchId: 'd1',
    agentId: 'worker',
    status: 'reported',
    failed: ['testing'],
    findings: 1,
  });
  expect(guards[0]!.outcomes[0]).toEqual({
    domain: 'architecture',
    outcome: { status: 'answered', result: 'findings' },
    findings: 1,
    error: null,
    admission: null,
    revision: 1,
    reference: null,
    requestRecord: null,
    request: {
      state: 'recorded',
      phase: 'guard',
      providerId: 'controlled-provider',
      capturedAt: 7,
      messages: supplied.messages,
    },
  });
  expect(guards[0]!.outcomes[1]).toMatchObject({
    domain: 'testing',
    outcome: { status: 'failed', cause: 'provider-error' },
    findings: 0,
    error: 'CONTROLLED_REFUSAL',
    admission: { nativeOutcome: 'unknown' },
    request: { state: 'not-sent', reason: 'cold-cache' },
  });
  expect(guards[1]).toMatchObject({
    tool: 'Bash',
    callId: null,
    status: 'pending',
    outcomes: [],
    failed: [],
    findings: null,
  });
  expect(guards[2]).toMatchObject({
    tool: 'Edit',
    status: 'failed',
    error: 'post-action threw',
    outcomes: [],
  });
  expect(guardOutcomes({ root: { annotations: {} } })).toBeNull();
  expect(guardOutcomes(undefined)).toBeNull();
  expect(guardOutcomes({ root: { annotations: { guards: [] } } })).toEqual([]);
});

test('learning entries carry the review request state and job id; malformed shapes are not read as evidence', () => {
  const history = [
    {
      storedAt: 10,
      signal: {
        id: 'a',
        content: {
          domain: 'architecture',
          decision: 'learned',
          revision: 2,
          job: { id: 'review-1', base: { revision: 1 } },
          evidence: { messageId: 'turn-1' },
          request: { ...supplied, phase: 'review', providerId: 'controlled-review' },
        },
      },
    },
    {
      storedAt: 11,
      signal: {
        id: 'b',
        content: {
          domain: 'architecture',
          decision: 'discarded',
          reason: 'disposed',
          request: { status: 'not-sent', phase: 'review', reason: 'review call not started' },
        },
      },
    },
    {
      storedAt: 12,
      signal: { id: 'c', content: { domain: 'architecture', decision: 'no-comment' } },
    },
    {
      storedAt: 13,
      signal: {
        id: 'd',
        content: {
          domain: 'architecture',
          decision: 'error',
          request: { status: 'supplied', messages: 'not-an-array' },
        },
      },
    },
  ];
  const entries = learningEntries(history);
  expect(entries.map((e: any) => [e.decision, e.jobId, e.request.state])).toEqual([
    ['learned', 'review-1', 'recorded'],
    ['discarded', null, 'not-sent'],
    ['no-comment', null, 'not-recorded'],
    ['error', null, 'not-recorded'],
  ]);
  expect(entries[0]!.request.messages).toEqual(supplied.messages);
  expect(entries[0]!.request.providerId).toBe('controlled-review');
  expect(entries[1]!.request.reason).toBe('review call not started');
  expect(
    participantRequest({
      status: 'supplied',
      phase: 'review',
      providerId: 'p',
      capturedAt: 1,
      messages: [{ role: 'user', content: 'x' }, { role: 'user' }],
    }).messages,
  ).toEqual([{ role: 'user', content: 'x' }]);
});
