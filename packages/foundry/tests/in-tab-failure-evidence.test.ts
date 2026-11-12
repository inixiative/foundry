import { expect, test } from 'bun:test';
import { mergeMessageHistory } from '../src/viewer/ui/conversation-state.js';

const marker = 'TAB_ONLY_FAILURE_TOOL_RESULT';

test("an interrupted journal row keeps the failure evidence only this tab saw, beside the server's record", () => {
  const local = [
    {
      id: 'agent-one',
      turnId: 'one',
      actor: 'agent',
      content: marker,
      meta: { persistence: 'failed', nativeOutcome: 'unknown', observedToolOutput: marker },
    },
  ];
  const recorded = [
    {
      id: 'agent-one',
      turnId: 'one',
      actor: 'agent',
      content: 'Interrupted',
      meta: { persistence: 'committed', turnStatus: 'interrupted', nativeOutcome: 'unknown' },
    },
  ];
  const [row] = mergeMessageHistory(local, recorded) as any[];
  expect(row.storage).toBe('server');
  expect(row.content).toBe('Interrupted');
  expect(row.meta.turnStatus).toBe('interrupted');
  expect(row.meta.browserFailureEvidence.observedToolOutput).toBe(marker);
});
