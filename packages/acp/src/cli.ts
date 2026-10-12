#!/usr/bin/env bun
/**
 * `foundry-acp`: Foundry as an ACP agent over stdio. A host (Paseo, T3 Code, Zed) spawns it per
 * connection; it reaches the local daemon through the ACP launch file and starts the daemon when
 * it is down. stdout carries only ACP; diagnostics go to stderr.
 *
 * `--permission-mode <mode>`: the mode every session this host opens starts in, for a host whose
 * own permission setting never reaches the agent. A mode the host sets on a session wins.
 *
 * `foundry-acp setup` installs Foundry and points hosts at it; `foundry-acp repeats` is `foundry repeats`.
 */
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import packageJson from '../package.json' with { type: 'json' };
import { createFoundryAgent } from './agent';

const [command, ...rest] = process.argv.slice(2);
if (command === 'setup' || command === 'repeats') {
  try {
    const code =
      command === 'setup'
        ? await (await import('./setup')).runSetup(rest)
        : await (await import('@inixiative/foundry/repeats')).runRepeats(rest);
    process.exit(code);
  } catch (error) {
    process.stderr.write(`foundry-acp ${command}: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

let agent: ReturnType<typeof createFoundryAgent>;
try {
  const { values } = parseArgs({
    options: { 'permission-mode': { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  agent = createFoundryAgent({
    version: packageJson.version,
    permissionMode: values['permission-mode'],
  });
} catch (error) {
  process.stderr.write(`foundry-acp: ${(error as Error).message}\n`);
  process.exit(2);
}

const connection = agent.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
await connection.closed;
process.exit(0);
