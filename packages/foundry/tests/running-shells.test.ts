import { expect, test } from 'bun:test';
import { backgroundShells } from '../src/viewer/ui/running-shells.js';

const turn = (toolUses: object[]) => ({ toolUses });

test('a background Bash call is a running shell; BashOutput adds output and status; KillShell stops it', () => {
  const started = {
    toolName: 'Bash',
    callId: 'c1',
    observedAt: 1,
    toolInput: {
      command: 'PORT=3502 bun run dev',
      description: 'API server',
      run_in_background: true,
    },
    toolOutput: 'Command running in background with ID: bash_1',
  };
  const tests = {
    toolName: 'Bash',
    callId: 'c2',
    toolInput: { command: 'bun test --watch', run_in_background: true },
    toolOutput: 'Command running in background with ID: bash_2',
  };
  const plain = { toolName: 'Bash', callId: 'c3', toolInput: { command: 'ls' }, toolOutput: 'a' };
  expect(
    backgroundShells([turn([started, tests, plain])]).map((s) => [s.id, s.state, s.port, s.label]),
  ).toEqual([
    ['bash_2', 'running', null, 'bun test --watch'],
    ['bash_1', 'running', '3502', 'API server'],
  ]);

  const read = {
    toolName: 'BashOutput',
    toolInput: { bash_id: 'bash_2' },
    toolOutput: '<status>completed</status>\n12 pass',
  };
  const kill = { toolName: 'KillShell', toolInput: { shell_id: 'bash_1' }, toolOutput: 'killed' };
  const shells = backgroundShells([turn([started, tests]), turn([read, kill])]);
  expect(shells.find((s) => s.id === 'bash_2')).toMatchObject({ state: 'passed' });
  expect(shells.find((s) => s.id === 'bash_2')?.output.at(-1)).toContain('12 pass');
  expect(shells.find((s) => s.id === 'bash_1')).toMatchObject({ state: 'stopped' });
});
