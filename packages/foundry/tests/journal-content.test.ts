import { expect, test } from 'bun:test';
import {
  chunkText,
  contentHash,
  decodeRecord,
  encodeRecord,
} from '../src/persistence/journal-content';

function memoryStore() {
  const content = new Map<string, string>();
  return {
    content,
    put: (text: string) => {
      const hash = contentHash(text);
      content.set(hash, text);
      return hash;
    },
    get: (hash: string) => content.get(hash)!,
  };
}

test('long text and deep structure are referenced by hash and read back exactly', () => {
  const store = memoryStore();
  const shared = `# Shared\n${'Look first. '.repeat(300)}`;
  const record = {
    turn: 't1',
    participants: Array.from({ length: 3 }, (_, i) => ({
      domain: `d${i}`,
      segments: { instructions: shared, domainKnowledge: `knowledge ${i}`, threadKnowledge: '' },
      request: { messages: [{ role: 'system', content: shared }] },
    })),
    when: new Date(0),
    skipped: undefined,
  };
  const text = encodeRecord(record, store);
  expect(text.length).toBeLessThan(shared.length);
  expect(decodeRecord(text, store)).toEqual(JSON.parse(JSON.stringify(record)));
  // The shared text is stored once, however many places hold it.
  expect([...store.content.values()].filter((value) => value === shared)).toHaveLength(1);
});

test('a changed section of long text stores only that section anew', () => {
  const store = memoryStore();
  const sections = Array.from(
    { length: 8 },
    (_, i) => `## Section ${i}\n${'Body text. '.repeat(80)}\n`,
  );
  encodeRecord({ text: sections.join('') }, store);
  const before = store.content.size;
  sections[5] = `## Section 5\n${'Edited body. '.repeat(80)}\n`;
  const text = encodeRecord({ text: sections.join('') }, store);
  // The edited section and the new section list.
  expect(store.content.size - before).toBe(2);
  expect(decodeRecord<{ text: string }>(text, store).text).toBe(sections.join(''));
  expect(chunkText(sections.join('')).join('')).toBe(sections.join(''));
});

test('a record over its row limit after references spills its bulk and reads back whole', () => {
  const store = memoryStore();
  const record = {
    owner: { threadId: 't', projectId: 'P' },
    domain: 'docs',
    participants: Array.from({ length: 4000 }, (_, i) => ({ i, note: `short ${i}` })),
  };
  const text = encodeRecord(record, store, { bytes: 20_000, spillKey: '$journal', reason: 'test' });
  expect(Buffer.byteLength(text)).toBeLessThan(20_000);
  const raw = JSON.parse(text);
  expect(raw.owner).toEqual(record.owner);
  expect(raw.domain).toBe('docs');
  expect(raw.$journal.paths).toEqual(['$.participants']);
  const { $journal: _note, ...back } = decodeRecord<Record<string, unknown>>(text, store);
  expect(back).toEqual(record);
});
