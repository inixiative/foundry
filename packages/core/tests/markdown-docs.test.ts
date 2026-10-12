import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudemdSource,
  instructionImports,
  MarkdownDocs,
  readInstructionFile,
  stripInstructionComments,
} from '../src/adapters/markdown-docs';

const TEST_DIR = '/tmp/foundry-markdown-docs-test';

function resetDir() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
  mkdirSync(TEST_DIR, { recursive: true });
}

afterAll(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

describe('MarkdownDocs.topologySource', () => {
  beforeEach(resetDir);

  test('emits path + H1 + H2 headings for each file', async () => {
    await Bun.write(
      join(TEST_DIR, 'auth.md'),
      '# Authentication\n\n## Session model\n\ntext\n\n## Token storage\n\nmore\n',
    );
    await Bun.write(
      join(TEST_DIR, 'api.md'),
      '# API Routes\n\n## Naming\n\n## Validation\n\n## Errors\n',
    );

    const docs = new MarkdownDocs(TEST_DIR);
    const src = docs.topologySource('docs-topo');
    const out = await src.load();

    expect(out).toContain('auth.md — Authentication');
    expect(out).toContain('H2: Session model, Token storage');
    expect(out).toContain('api.md — API Routes');
    expect(out).toContain('H2: Naming, Validation, Errors');
  });

  test('falls back to filename when no H1 is present', async () => {
    await Bun.write(join(TEST_DIR, 'notes.md'), 'Just a paragraph.\n\n## Orphan section\n');

    const docs = new MarkdownDocs(TEST_DIR);
    const src = docs.topologySource('t');
    const out = await src.load();

    expect(out).toContain('notes.md — notes');
    expect(out).toContain('H2: Orphan section');
  });

  test('omits H2 line for files with no H2 headings', async () => {
    await Bun.write(join(TEST_DIR, 'brief.md'), '# Brief\n\nOne short paragraph.\n');

    const docs = new MarkdownDocs(TEST_DIR);
    const src = docs.topologySource('t');
    const out = await src.load();

    expect(out).toContain('brief.md — Brief');
    expect(out).not.toContain('H2:');
  });

  test('skips empty files', async () => {
    await Bun.write(join(TEST_DIR, 'empty.md'), '');
    await Bun.write(join(TEST_DIR, 'real.md'), '# Real\n');

    const docs = new MarkdownDocs(TEST_DIR);
    const out = await docs.topologySource('t').load();

    expect(out).not.toContain('empty.md');
    expect(out).toContain('real.md');
  });

  test('caps H2 headings at maxHeadings', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `## Section ${i}`).join('\n\n');
    await Bun.write(join(TEST_DIR, 'huge.md'), `# Huge\n\n${many}\n`);

    const docs = new MarkdownDocs(TEST_DIR);
    const out = await docs.topologySource('t', { maxHeadings: 5 }).load();

    expect(out).toContain('H2: Section 0, Section 1, Section 2, Section 3, Section 4');
    expect(out).not.toContain('Section 5');
  });

  test('topology stays compact — roughly 50 tokens per file', async () => {
    for (let i = 0; i < 10; i++) {
      const sections = ['## Overview', '## Usage', '## Errors'].join('\n\n');
      await Bun.write(join(TEST_DIR, `file${i}.md`), `# File ${i}\n\n${sections}\n`);
    }
    const docs = new MarkdownDocs(TEST_DIR);
    const out = await docs.topologySource('t').load();

    // Rough token estimate: chars / 4. Ten files with 3 H2s each should be < 600 tokens.
    expect(out.length).toBeLessThan(2400);
    expect(out.split('\n').length).toBeGreaterThanOrEqual(20);
  });
});

describe('instruction @imports (Claude Code semantics)', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foundry-imports-'));
    home = mkdtempSync(join(tmpdir(), 'foundry-imports-home-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  const paths = (files: { path: string }[]) => files.map((file) => file.path);

  test('only bare @paths outside code import; escaped spaces join the path', () => {
    expect(
      instructionImports(
        [
          'See @a.md and @dir/b.md.',
          'Inline `@span.md` and ``@double.md`` stay literal; so do "@quoted.md" and aron@email.md',
          '@with\\ space.md',
          '```',
          '@fenced.md',
          '```',
          '~~~~',
          '@tilde-fenced.md',
          '```',
          '@still-fenced.md',
          '~~~~',
          '@after.md',
        ].join('\n'),
      ),
    ).toEqual(['a.md', 'dir/b.md.', 'with space.md', 'after.md']);
  });

  test('imports resolve relative to the importing file, then depth-first in document order', async () => {
    write(join(dir, 'CLAUDE.md'), 'root @docs/one.md @two.md');
    write(join(dir, 'docs', 'one.md'), 'one @nested/three.md');
    write(join(dir, 'docs', 'nested', 'three.md'), 'three');
    write(join(dir, 'two.md'), 'two');
    const files = await readInstructionFile(join(dir, 'CLAUDE.md'), { home });
    expect(paths(files)).toEqual([
      join(dir, 'CLAUDE.md'),
      join(dir, 'docs', 'one.md'),
      join(dir, 'docs', 'nested', 'three.md'),
      join(dir, 'two.md'),
    ]);
    expect(files.map((file) => file.depth)).toEqual([0, 1, 2, 1]);
    expect(files[2]!.importedBy).toBe(join(dir, 'docs', 'one.md'));
  });

  test('~/ imports resolve against the home directory, and absolute paths load as given', async () => {
    write(join(home, '.claude', 'mine.md'), 'mine');
    write(join(dir, 'abs.md'), 'absolute');
    write(join(dir, 'CLAUDE.md'), `@~/.claude/mine.md @${join(dir, 'abs.md')}`);
    const files = await readInstructionFile(join(dir, 'CLAUDE.md'), { home });
    expect(paths(files)).toEqual([
      join(dir, 'CLAUDE.md'),
      join(home, '.claude', 'mine.md'),
      join(dir, 'abs.md'),
    ]);
  });

  test('a chain stops after four hops, and a cycle loads each file once', async () => {
    for (let hop = 0; hop <= 5; hop++)
      write(join(dir, `h${hop}.md`), `hop ${hop} @h${hop + 1}.md @h0.md`);
    const files = await readInstructionFile(join(dir, 'h0.md'), { home });
    expect(paths(files)).toEqual([0, 1, 2, 3, 4].map((hop) => join(dir, `h${hop}.md`)));
  });

  test('missing, directory, non-text and refused targets are skipped', async () => {
    mkdirSync(join(dir, 'folder'));
    write(join(dir, 'outside.md'), 'outside');
    write(join(dir, 'image.png'), 'not text');
    write(join(dir, 'notes.md.'), 'trailing punctuation is part of the path');
    write(join(dir, 'README'), 'no extension imports');
    write(join(dir, 'CLAUDE.md'), '@missing.md @folder @outside.md @image.png @notes.md. @README');
    const files = await readInstructionFile(join(dir, 'CLAUDE.md'), {
      home,
      allows: (target) => !target.endsWith('outside.md'),
    });
    expect(paths(files)).toEqual([join(dir, 'CLAUDE.md'), join(dir, 'README')]);
  });

  test('block-level HTML comments are stripped outside code, kept inside it', () => {
    expect(
      stripInstructionComments(
        [
          'keep',
          '<!-- maintainer note',
          'over lines -->',
          'after',
          '```',
          '<!-- code -->',
          '```',
        ].join('\n'),
      ),
    ).toBe(['keep', 'after', '```', '<!-- code -->', '```'].join('\n'));
  });

  test('claudemdSource inlines imports under their own heading instead of passing @paths through', async () => {
    write(join(dir, 'CLAUDE.md'), 'Rules. @AGENTS.md');
    write(join(dir, 'AGENTS.md'), 'Shared agent rules.');
    expect(await claudemdSource('claude', join(dir, 'CLAUDE.md')).load()).toBe(
      `Rules. @AGENTS.md\n\nContents of ${join(dir, 'AGENTS.md')}:\n\nShared agent rules.`,
    );
  });
});
