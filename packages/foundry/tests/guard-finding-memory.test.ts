import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextLayer,
  DEFAULT_MEMORY_SELECTION,
  FileMemory,
  InterventionLog,
  SignalBus,
  selectMemory,
} from '@inixiative/foundry-core';
import { DomainLibrarian } from '../src/agents/domain-librarian';

// An advisory guard finding is evidence, not a human correction: it is retained in the
// thread's memory log but never pinned into every later turn.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('advisory guard findings are retained as audit-only memory; an operator correction stays pinned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-guard-finding-'));
  dirs.push(dir);
  const memory = new FileMemory(dir);
  await memory.load();
  const owner = { threadId: 't1', projectId: 'p1' };
  const signals = new SignalBus();
  const write = memory.signalWriter();
  signals.onAny((signal) => write(signal, owner));

  const cache = new ContextLayer({ id: 'architecture', segment: 'domain-knowledge' });
  cache.set('Preserve module boundaries.');
  const lib = new DomainLibrarian({
    domain: 'architecture',
    cache,
    signals,
    guardTriggers: ['Write'],
    llm: {
      id: 'controlled-guard',
      complete: async () => ({
        model: 'controlled',
        content: JSON.stringify({
          findings: [
            { severity: 'advisory', description: 'ADVISORY-SENTINEL consider a migration test' },
            { severity: 'critical', description: 'CRITICAL-SENTINEL schema drops a column' },
          ],
        }),
      }),
    },
  });
  const result = await lib.guard({ tool: 'Write', input: { file_path: 'contacts.ts' } });
  expect(result.status).toBe('completed');
  await new InterventionLog().intervene(
    { id: owner.threadId, signals },
    'trace',
    'span',
    null,
    'OPERATOR-SENTINEL use the primitive',
    'ui',
  );

  const entries = memory.view(owner).all();
  const advisory = entries.find((e) => e.content.includes('ADVISORY-SENTINEL'));
  expect(advisory?.kind).toBe('guard_finding');
  expect(JSON.parse(advisory!.content)).toMatchObject({
    domain: 'architecture',
    severity: 'advisory',
    tool: 'Write',
  });
  expect(entries.find((e) => e.content.includes('CRITICAL-SENTINEL'))?.kind).toBe(
    'security_concern',
  );

  const { text, report } = selectMemory(
    entries,
    DEFAULT_MEMORY_SELECTION,
    'Rename the onboarding banner copy',
  );
  expect(text).toContain('OPERATOR-SENTINEL');
  expect(text).not.toContain('ADVISORY-SENTINEL');
  expect(report.selected.find((s) => s.id === advisory!.id)).toBeUndefined();
  expect(report.omitted.find((o) => o.id === advisory!.id)?.reason).toBe('audit-only');
  expect(report.selected.find((s) => s.kind === 'correction')?.reason).toBe('pinned');
});
