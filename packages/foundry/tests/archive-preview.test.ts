import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewImports } from '../src/archives/preview';

test('preview inventories supported histories and failures without importing or following symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-preview-'));
  const good = [ { type: 'session_meta', payload: { id: 'session-a' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review migration' }] } } ];
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'a.jsonl'), good.map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(join(root, 'nested', 'b.jsonl'), '{malformed');
    symlinkSync(root, join(root, 'cycle'));
    const result = previewImports(root, 'codex');
    expect(result.ready).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.sessions[0]).toMatchObject({ sessionId: 'session-a', entries: 1, status: 'ready' });
    expect(result.truncated).toBe(false);
    expect(previewImports(root, 'codex', 1)).toMatchObject({ ready: 1, rejected: 0, truncated: true });
    expect(existsSync(join(root, '.foundry'))).toBe(false);
    expect(() => previewImports(root, 'codex', 0)).toThrow('limit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('file import streams a source beyond the old 64 MB cap and preserves UTF-8 and line references', async () => {
  const { importTranscriptFile } = await import('../src/archives/import-file');
  const { openSync, closeSync, writeSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'archive-stream-'));
  const file = join(root, 'large.jsonl'), fd = openSync(file, 'w');
  try {
    writeSync(fd, JSON.stringify({ type: 'session_meta', payload: { id: 'large-native-history' } }) + '\n');
    const ignored = JSON.stringify({ type: 'ignored', payload: 'x'.repeat(65500) }) + '\n';
    for (let i = 0; i < 1024; i++) writeSync(fd, ignored);
    writeSync(fd, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '🏰 Migration evidence 文本'.repeat(4000) }] } }));
  } finally { closeSync(fd); }
  try {
    const archive = importTranscriptFile(file, { source: 'codex', sourceId: crypto.randomUUID() });
    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0].text).toBe('🏰 Migration evidence 文本'.repeat(4000));
    expect(archive.entries[0].sourceRef).toBe('line:1026');
    expect(archive.sessionId).toBe('large-native-history');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
