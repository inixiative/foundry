import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { composeDomainLoop, domainLoopPlan } from '../../../../scripts/domain-loop-composition';
import type { SessionAdapter } from '../../src/providers/session-adapter';

/** Explicit controlled native adapters ONLY. The production composition constructs
 * real providers, runtime, project threads, viewer and file-backed journal. */
export async function startupLoopFixture(dir: string) {
  await mkdir(join(dir, 'project-a'), { recursive: true }); await mkdir(join(dir, 'project-b'));
  const sessions: any[] = [], attempts: any[] = [];
  const make = (central: boolean): SessionAdapter => ({ runtime: 'claude-code',
    async getExternalSessionId() { return null; }, async clearSession() { throw Error('No binding clear'); },
    describeConstruction() { return { bindingId: 'controlled-startup', resumedBinding: null }; }, observedConfiguration() { return Object.freeze([]); },
    async releaseIdleSession(s: any) { if (attempts.some(a => a.session === s && a.native.rpcOutcome !== 'resolved')) return 'unknown'; s.released = true; s.detach(); return 'released'; },
    async createSession(opts) {
      const listeners = new Set<(event: any) => void>();
      const s: any = { opts, released: false, externalSessionId: `startup-controlled-${sessions.length}`, admissionProtocol: 'prewrite-v1', turnBudgetProtocol: 'optional-max-turns-v1',
        async start() {}, kill() { throw Error('No model kill'); }, detach() { listeners.clear(); },
        onEvent(fn: (e: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
        inspectAttempt(id: string) { const a = attempts.find(a => a.native.admissionId === id && a.session === s); return a ? structuredClone(a.native) : undefined; },
        async send(_prompt: string, sendOpts: any) {
          const native: any = { admissionId: `startup-admission-${attempts.length}`, externalSessionId: s.externalSessionId, nativeSessionId: s.externalSessionId,
            dispatch: 'not-dispatched', nativeOutcome: 'unknown', localOutcome: 'pending', rpcOutcome: 'pending', events: [] };
          const a = { session: s, native }; attempts.push(a); await sendOpts.onAdmission?.(structuredClone(native)); native.dispatch = 'attempted';
          const emit = (value: any) => { const e = { ...structuredClone(native), timestamp: Date.now(), ...value }; for (const fn of listeners) fn(e); };
          if (central) {
            emit({ kind: 'tool_use', callId: `tool-${native.admissionId}`, toolName: 'Bash', toolInput: { command: 'controlled-public-check' } });
            emit({ kind: 'tool_result', callId: `tool-${native.admissionId}`, toolName: 'Bash', toolOutput: 'CONTROLLED_TOOL_RESULT' });
          }
          const content = central ? 'CONTROLLED_OBSERVABLE_COMPLETION'
            : opts.threadId.endsWith(':agent:classifier') ? '{"category":"feature","reasoning":"controlled"}'
            : opts.threadId.endsWith(':agent:router') ? '{"destination":"artificer","contextSlice":["system","architecture","testing"],"priority":5}'
            : opts.threadId.endsWith(':cartographer') ? '{"domains":["architecture","testing"],"layers":["architecture","testing"],"confidence":1}'
            : '{"decision":"abstain","reason":"No learned assertion in startup fixture","layers":[],"snippets":[],"findings":[],"confidence":1}';
          Object.assign(native, { content, nativeOutcome: 'completed', localOutcome: 'resolved', rpcOutcome: 'resolved', terminal: { type: 'result', subtype: 'success' },
            // Deliberately absent auxiliary usage; it must not be relabelled zero.
            ...(central ? { tokens: { input: 1234, output: 321 } } : {}) });
          emit({ kind: 'result' }); return structuredClone(native);
        },
      }; sessions.push(s); return s;
    },
  });
  const loop = await composeDomainLoop(domainLoopPlan({ runId: 'm4-startup-qa', engine: 'claude', model: 'fable', effort: 'high', reviewerModel: 'fable', admissionMs: 900000 }), dir, { central: make(true), auxiliary: make(false) });
  return { loop, sessions, attempts, async close() {
    for (const id of Object.values(loop.plan.threads)) await loop.current.manager.get(id)!.learningSettled();
    await loop.reconcile(); if (!await loop.closeSettled()) throw Error('Original startup fixture occupancy unresolved');
    loop.dispose(); if (!sessions.every(s => s.released)) throw Error('Controlled resource release incomplete');
  } };
}
