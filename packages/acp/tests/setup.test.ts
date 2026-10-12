import { describe, expect, test } from 'bun:test';
import { mergePaseoConfig, paseoProvider } from '../src/setup';

describe('foundry-acp setup', () => {
  const command = ['/opt/homebrew/bin/bun', '/x/foundry-acp/src/cli.ts'];

  test('adds Foundry to Paseo next to existing providers and settings', () => {
    const merged = mergePaseoConfig(
      { theme: 'dark', agents: { default: 'claude', providers: { other: { extends: 'acp' } } } },
      command,
    );
    expect(merged).toEqual({
      theme: 'dark',
      agents: {
        default: 'claude',
        providers: { other: { extends: 'acp' }, foundry: paseoProvider(command) },
      },
    });
  });

  test('starts a Paseo config from nothing, and replaces an older Foundry entry', () => {
    expect(mergePaseoConfig(undefined, command)).toEqual({
      agents: { providers: { foundry: { extends: 'acp', label: 'Foundry', command } } },
    });
    const replaced = mergePaseoConfig(
      { agents: { providers: { foundry: { extends: 'acp', command: ['bun', '/old/cli.ts'] } } } },
      command,
    ) as { agents: { providers: { foundry: { command: string[] } } } };
    expect(replaced.agents.providers.foundry.command).toEqual(command);
  });
});
