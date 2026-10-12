import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  dedupeHierarchy,
  discoverHierarchy,
  type HierarchyFile,
  type HierarchyLocation,
  type HierarchyNode,
  markdownSections,
  selectHierarchyNodes,
} from '../src/adapters/markdown-hierarchy';

let root: string;
let home: string;
let org: string;
let project: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'core-markdown-hierarchy-')));
  home = join(root, 'home');
  org = join(root, 'code', 'org');
  project = join(org, 'app');
  mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const RANK: Record<string, number> = { personal: 0, team: 1, org: 2 };
const tierRank = (tier: string) => RANK[tier] ?? 9;

/** Aron's ladder: computer personal; org and org personal; a project and project personal. */
const ladder = (): HierarchyNode[] => [
  {
    id: 'computer',
    scope: 'computer',
    personal: true,
    tier: 'personal',
    imports: 'anywhere',
    sources: [{ path: '{home}/computer.md' }],
  },
  {
    id: 'org',
    scope: 'org',
    personal: false,
    tier: 'org',
    when: { paths: ['{orgRoot}'] },
    sources: [{ path: '{anchor}/ORG.md' }],
  },
  {
    id: 'org-personal',
    scope: 'org',
    personal: true,
    tier: 'personal',
    parent: 'org',
    sources: [{ path: '{home}/personal/org.md' }],
  },
  {
    id: 'project',
    scope: 'project',
    personal: false,
    tier: 'team',
    parent: 'org',
    when: { projects: ['app'] },
    anchor: '{projectPath}',
    sources: [{ path: 'PROJECT.md' }, { path: 'docs/rules/*.md' }],
  },
  {
    id: 'project-personal',
    scope: 'project',
    personal: true,
    tier: 'personal',
    parent: 'project',
    anchor: '{projectPath}',
    sources: [{ path: '{home}/personal/app.md' }],
  },
];

const at = (cwd: string, extra: Partial<HierarchyLocation> = {}): HierarchyLocation => ({
  cwd,
  home,
  vars: { home, orgRoot: org, projectPath: project },
  ...extra,
});
const ids = (location: HierarchyLocation) =>
  selectHierarchyNodes(ladder(), location).map((entry) => entry.node.id);

test('node selection: only the levels the working location is inside, children only under their parent', () => {
  // Outside the org: only the computer level.
  expect(ids(at(join(root, 'elsewhere')))).toEqual(['computer']);
  // In the org, no project thread: org and org personal.
  expect(ids(at(org))).toEqual(['computer', 'org', 'org-personal']);
  // A project thread inside the org: every level, in ladder order.
  expect(ids(at(project, { projectId: 'app' }))).toEqual([
    'computer',
    'org',
    'org-personal',
    'project',
    'project-personal',
  ]);
  // The project's thread working outside its org: the project hangs off the org, so neither applies.
  expect(ids(at(join(root, 'elsewhere'), { projectId: 'app' }))).toEqual(['computer']);
  // Owner and harness matching.
  const owned: HierarchyNode[] = [
    {
      id: 'kingdom-org',
      scope: 'org',
      personal: false,
      tier: 'org',
      when: { owners: ['Organization::o:'] },
      sources: [],
    },
    {
      id: 'codex-only',
      scope: 'computer',
      personal: true,
      tier: 'personal',
      when: { harness: ['codex'] },
      sources: [],
    },
  ];
  const pick = (location: HierarchyLocation) =>
    selectHierarchyNodes(owned, location).map((entry) => entry.node.id);
  expect(pick(at(org, { owner: 'Organization::o:', harness: 'claude' }))).toEqual(['kingdom-org']);
  expect(pick(at(org, { harness: 'codex' }))).toEqual(['codex-only']);
});

test('composition order: computer, then org and org personal, then project and project personal', async () => {
  write(join(home, 'computer.md'), 'COMPUTER');
  write(join(org, 'ORG.md'), 'ORG');
  write(join(home, 'personal', 'org.md'), 'ORG_PERSONAL');
  write(join(project, 'PROJECT.md'), 'PROJECT');
  write(join(project, 'docs', 'rules', 'b.md'), 'RULE_B');
  write(join(project, 'docs', 'rules', 'a.md'), 'RULE_A');
  write(join(home, 'personal', 'app.md'), 'PROJECT_PERSONAL');
  const stack = await discoverHierarchy(ladder(), at(join(project, 'src'), { projectId: 'app' }), {
    tierRank,
  });
  expect(stack.files.map((file) => [file.content, file.node, file.tier])).toEqual([
    ['COMPUTER', 'computer', 'personal'],
    ['ORG', 'org', 'org'],
    ['ORG_PERSONAL', 'org-personal', 'personal'],
    ['PROJECT', 'project', 'team'],
    ['RULE_A', 'project', 'team'],
    ['RULE_B', 'project', 'team'],
    ['PROJECT_PERSONAL', 'project-personal', 'personal'],
  ]);
});

test('a walk interleaves by directory: shared before personal at each level, root to cwd', async () => {
  const nodes: HierarchyNode[] = [
    {
      id: 'shared',
      scope: 'project',
      personal: false,
      tier: 'team',
      sources: [{ walk: [{ path: 'CLAUDE.md' }], span: { within: [org] } }],
    },
    {
      id: 'mine',
      scope: 'project',
      personal: true,
      tier: 'personal',
      sources: [{ walk: [{ path: 'CLAUDE.local.md' }] }],
    },
    {
      id: 'last',
      scope: 'project',
      personal: true,
      tier: 'personal',
      anchor: '{cwd}',
      sources: [{ path: '{home}/memory.md' }],
    },
  ];
  write(join(org, 'CLAUDE.md'), 'ORG');
  write(join(org, 'CLAUDE.local.md'), 'ORG_LOCAL');
  write(join(project, 'CLAUDE.md'), 'APP');
  write(join(project, 'CLAUDE.local.md'), 'APP_LOCAL');
  write(join(home, 'memory.md'), 'MEMORY');
  const stack = await discoverHierarchy(
    nodes,
    { cwd: project, home, vars: { home, cwd: project } },
    { tierRank },
  );
  expect(stack.files.map((file) => file.content)).toEqual([
    'ORG',
    'ORG_LOCAL',
    'APP',
    'APP_LOCAL',
    'MEMORY',
  ]);
});

test('the same file reached twice (a symlink, an import) loads once and the second reach is recorded', async () => {
  write(join(org, 'ORG.md'), 'ORG @shared.md');
  write(join(org, 'shared.md'), 'SHARED');
  write(join(project, 'PROJECT.md'), 'PROJECT @../shared.md');
  mkdirSync(join(project, 'docs', 'rules'), { recursive: true });
  symlinkSync(join(org, 'ORG.md'), join(project, 'docs', 'rules', 'org-link.md'));
  const nodes = ladder().map((node) =>
    node.id === 'project' ? { ...node, imports: [org] as readonly string[] } : node,
  );
  const stack = await discoverHierarchy(nodes, at(project, { projectId: 'app' }), { tierRank });
  expect(stack.files.map((file) => file.content)).toEqual([
    'ORG @shared.md',
    'SHARED',
    'PROJECT @../shared.md',
  ]);
  expect(
    stack.duplicates.map((d) => [d.kind, d.path.slice(root.length), d.keptPath.slice(root.length)]),
  ).toEqual([
    ['path', '/code/org/shared.md', '/code/org/shared.md'],
    ['path', '/code/org/app/docs/rules/org-link.md', '/code/org/ORG.md'],
  ]);
});

test('an import keeps the narrower tier of a node that owns its path', async () => {
  const nodes: HierarchyNode[] = [
    {
      id: 'shared',
      scope: 'project',
      personal: false,
      tier: 'team',
      imports: [org],
      sources: [{ path: join(project, 'CLAUDE.md') }],
    },
    {
      id: 'mine',
      scope: 'project',
      personal: true,
      tier: 'personal',
      owns: { names: ['CLAUDE.local.md'] },
      sources: [],
    },
  ];
  write(join(project, 'CLAUDE.md'), 'TEAM @CLAUDE.local.md');
  write(join(project, 'CLAUDE.local.md'), 'SECRET');
  const stack = await discoverHierarchy(nodes, { cwd: project, home, vars: {} }, { tierRank });
  expect(stack.files.map((file) => [file.content, file.node, file.tier])).toEqual([
    ['TEAM @CLAUDE.local.md', 'shared', 'team'],
    ['SECRET', 'mine', 'personal'],
  ]);
});

test('configured paths never read dotfiles, keys or credential directories', async () => {
  write(join(home, '.env'), 'TOKEN=1');
  write(join(home, '.ssh', 'notes.md'), 'SSH');
  const nodes: HierarchyNode[] = [
    {
      id: 'x',
      scope: 'computer',
      personal: true,
      tier: 'personal',
      sources: [{ path: '{home}/.env' }, { path: '{home}/.ssh/*.md' }],
    },
  ];
  const stack = await discoverHierarchy(nodes, { cwd: home, home, vars: { home } }, { tierRank });
  expect(stack.files).toEqual([]);
});

const file = (path: string, node: string, content: string): HierarchyFile => ({
  path,
  node,
  tier: 'team',
  content,
  depth: 0,
});

test('identical content: the most specific copy is kept (a worktree and its main checkout)', () => {
  const result = dedupeHierarchy([
    file('/repo/CLAUDE.md', 'project', '# Rules\n\nSame.\n'),
    file('/repo/.worktrees/x/CLAUDE.md', 'project', '# Rules  \r\n\r\nSame.'),
  ]);
  expect(result.files.map((f) => f.path)).toEqual(['/repo/.worktrees/x/CLAUDE.md']);
  expect(result.duplicates).toEqual([
    {
      kind: 'content',
      path: '/repo/CLAUDE.md',
      node: 'project',
      chars: 15,
      keptPath: '/repo/.worktrees/x/CLAUDE.md',
      keptNode: 'project',
    },
  ]);
});

test('identical sections: removed from the more general file with their subsections; distinct ones stay', () => {
  const general = [
    'Preamble.',
    '',
    '## Merging',
    '',
    'Merge once green.',
    '',
    '### Detail',
    '',
    'Run the full check.',
    '',
    '## Ports',
    '',
    'From the registry.',
    '',
    '## Empty',
    '',
    '```md',
    '## Merging',
    '```',
  ].join('\n');
  const specific = [
    '# Project',
    '',
    '## merging',
    '',
    'Merge once green.',
    '',
    '### Detail',
    'Run the full   check.',
    '',
    '## Ports',
    '',
    'Pick any.',
  ].join('\n');
  const result = dedupeHierarchy([
    file('/org/CLAUDE.md', 'org', general),
    file('/org/app/CLAUDE.md', 'project', specific),
  ]);
  expect(result.files[0]!.content).not.toContain('Merge once green.');
  expect(result.files[0]!.content).not.toContain('### Detail');
  expect(result.files[0]!.content).toContain('From the registry.');
  expect(result.files[0]!.content).toContain('## Empty');
  expect(result.files[1]!.content).toBe(specific);
  expect(result.duplicates.map((d) => [d.kind, d.path, d.heading, d.keptPath])).toEqual([
    ['section', '/org/CLAUDE.md', 'Merging', '/org/app/CLAUDE.md'],
  ]);
});

test('section and content dedupe can each be turned off', () => {
  const files = [file('/a.md', 'org', '## A\n\nx'), file('/b.md', 'project', '## A\n\nx')];
  expect(dedupeHierarchy(files, { content: false, sections: false }).files).toHaveLength(2);
  expect(dedupeHierarchy(files, { content: false }).duplicates.map((d) => d.kind)).toEqual([
    'section',
  ]);
});

test('sections ignore headings inside fenced code and carry their subsections', () => {
  const sections = markdownSections(
    '# T\n\n## A\n\nbody\n\n### A1\n\nmore\n\n```\n## not\n```\n\n## B\n',
  );
  expect(sections.map((s) => [s.heading, s.level, s.start, s.end, !!s.key])).toEqual([
    ['T', 1, 0, 16, true],
    ['A', 2, 2, 14, true],
    ['A1', 3, 6, 14, true],
    ['B', 2, 14, 16, false],
  ]);
});

test('section dedupe keeps a heading path, indentation and untouched code blank lines', () => {
  const general = [
    '# Testing',
    '',
    '## Rules',
    '',
    '- never mock the database',
    '',
    '# Config',
    '',
    '```yaml',
    'a:',
    '  b: 1',
    '```',
    '',
    '## Shared',
    '',
    'same',
    '',
    '## Code',
    '',
    '```py',
    'x = 1',
    '',
    '',
    'y = 2',
    '```',
  ].join('\n');
  const specific = [
    '# Deploy',
    '',
    '## Rules',
    '',
    '- never mock the database',
    '',
    '# Config',
    '',
    '```yaml',
    'a:',
    'b: 1',
    '```',
    '',
    '## Shared',
    '',
    'same',
  ].join('\n');
  const result = dedupeHierarchy([
    file('/g.md', 'org', general),
    file('/s.md', 'project', specific),
  ]);
  const kept = result.files[0]!.content;
  // Testing > Rules is not Deploy > Rules; the YAML differs by indentation.
  expect(kept).toContain('- never mock the database');
  expect(kept).toContain('  b: 1');
  // Config > Shared is the same section: removed, and the Python block's double blank line survives.
  expect(result.duplicates.map((d) => d.heading)).toEqual(['Shared']);
  expect(kept).toContain('x = 1\n\n\ny = 2');
});

test('frontmatter is not a section', () => {
  expect(markdownSections('---\n# key: v\n---\n## A\n\nbody').map((s) => s.heading)).toEqual(['A']);
});
