import { expect, test } from 'bun:test';
import { milestoneOf, shellCommands, shellCommandText } from '../src/turns/milestones';

// The milestone detector (Aron, 2026-11-16): the calls a workflow rule governs, one notion for every worker.

const BRIDGE = 'foundry_01a1e7118975733393df9216d60e15a3';

const shell = (command: unknown, callId = 'c1', toolName = 'Bash') =>
  milestoneOf({ callId, toolName, toolInput: { command } }, 'before');

test('shell milestones: a pull request, a merge, a publish, a train', () => {
  expect(shell('gh pr create --fill')).toMatchObject({
    milestoneId: 'milestone-call:c1',
    kind: 'pull-request',
    tool: 'Bash',
    detail: 'gh pr create --fill',
    when: 'before',
  });
  expect(shell('cd x && gh pr merge 3 --squash')?.kind).toBe('merge');
  expect(shell('npm publish pkg.tgz')?.kind).toBe('publish');
  expect(shell('bun publish')?.kind).toBe('publish');
  expect(shell('bunx @inixiative/config train --lane=agentic')?.kind).toBe('publish');
  expect(shell(['gh', 'pr', 'merge', '4'])?.kind).toBe('merge');
});

test('global flags, runners and env prefixes still reach the subcommand', () => {
  expect(shell('gh -R inixiative/foundry pr merge 4 --squash')?.kind).toBe('merge');
  expect(shell('gh --repo=inixiative/foundry pr create --fill')?.kind).toBe('pull-request');
  expect(shell('pnpm -r publish')?.kind).toBe('publish');
  expect(shell('yarn npm publish')?.kind).toBe('publish');
  expect(shell('npx changeset publish')?.kind).toBe('publish');
  expect(shell('NPM_CONFIG_PROVENANCE=true npm publish')?.kind).toBe('publish');
  expect(shell(['bash', '-lc', 'cd pkg && npm publish'])?.kind).toBe('publish');
});

test('a chain that opens and merges a pull request is a merge', () => {
  expect(shell('gh pr create --fill && gh pr merge --auto --squash')?.kind).toBe('merge');
});

test('quoted text, heredocs, help and dry runs are no milestone', () => {
  expect(shell('echo "npm publish"')).toBeUndefined();
  expect(shell('echo npm publish')).toBeUndefined();
  expect(shell(`git commit -m "then gh pr merge 3"`)).toBeUndefined();
  expect(shell(`grep -rn 'gh pr create' docs`)).toBeUndefined();
  expect(shell('cat <<EOF > notes.md\ngh pr merge 3\nEOF\nls')).toBeUndefined();
  expect(shell('gh pr create --help')).toBeUndefined();
  expect(shell('npm publish --dry-run')).toBeUndefined();
  // A pull request whose body is a heredoc is still a pull request.
  expect(shell(`gh pr create --title x --body "$(cat <<'EOF'\nbody\nEOF\n)"`)?.kind).toBe(
    'pull-request',
  );
});

test('ordinary shell calls are no milestone', () => {
  expect(shell('gh pr view 3')).toBeUndefined();
  expect(shell('npm install')).toBeUndefined();
  expect(shell('')).toBeUndefined();
});

test("Codex's shell tools are read the same way", () => {
  expect(shell('gh pr merge 5', 'c2', 'shell')?.kind).toBe('merge');
  expect(
    milestoneOf(
      { callId: 'c3', toolName: 'exec_command', toolInput: { cmd: 'npm publish' } },
      'landed',
    ),
  ).toMatchObject({ kind: 'publish', when: 'landed' });
});

test('marking the thread done is a milestone, as Claude or as an observed Codex call', () => {
  const status = (toolName: string, status: string) =>
    milestoneOf({ toolName, toolInput: { status } }, 'landed');
  expect(status(`mcp__${BRIDGE}__set_status`, 'done')).toMatchObject({ kind: 'done' });
  expect(status(`${BRIDGE}/mcp__${BRIDGE}__set_status`, 'done')).toMatchObject({ kind: 'done' });
  expect(status(`mcp__${BRIDGE}__set_status`, 'needs-you')).toBeUndefined();
});

test('a call with no id still gets its own milestone id', () => {
  const a = milestoneOf({ toolName: 'Bash', toolInput: { command: 'npm publish' } }, 'landed');
  const b = milestoneOf({ toolName: 'Bash', toolInput: { command: 'npm publish' } }, 'landed');
  expect(a?.milestoneId).toStartWith('milestone-call:');
  expect(a?.milestoneId).not.toBe(b?.milestoneId);
});

test('writing a rules file (nested too) or the instruction ladder is a rule change', () => {
  const write = (file_path: string) =>
    milestoneOf(
      { toolName: 'Edit', toolInput: { file_path, old_string: 'a', new_string: 'b' } },
      'before',
    );
  expect(write('/r/docs/rules/permissions-and-signets.md')).toMatchObject({
    kind: 'rule-change',
    detail: '/r/docs/rules/permissions-and-signets.md',
  });
  expect(write('/r/docs/rules/archive/old.md')?.kind).toBe('rule-change');
  expect(write('/r/CLAUDE.md')?.kind).toBe('rule-change');
  expect(write('/r/AGENTS.local.md')?.kind).toBe('rule-change');
  expect(write('/r/docs/FLOW.md')).toBeUndefined();
});

test('shellCommandText reads command, argv, a shell script argv, or cmd', () => {
  expect(shellCommandText({ command: 'ls' })).toBe('ls');
  expect(shellCommandText({ command: ['ls', '-a'] })).toBe('ls -a');
  expect(shellCommandText({ command: ['zsh', '-lc', 'git status'] })).toBe('git status');
  expect(shellCommandText({ cmd: 'pwd' })).toBe('pwd');
  expect(shellCommandText({ command: '  ' })).toBeUndefined();
});

test('shellCommands splits a chain and drops data', () => {
  expect(shellCommands(`cd x && FOO=1 sudo npm publish; echo "a && b" | tee log`)).toEqual([
    'cd x',
    'npm publish',
    "echo ''",
    'tee log',
  ]);
});
