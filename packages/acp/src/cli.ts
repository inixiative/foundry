#!/usr/bin/env bun
/**
 * `foundry-acp`: Foundry as an ACP agent over stdio. A host (Paseo, T3 Code, Zed) spawns it per
 * connection; it reaches the local daemon through the ACP launch file and starts the daemon when
 * it is down. stdout carries only ACP; diagnostics go to stderr.
 */
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import packageJson from '../package.json' with { type: 'json' };
import { createFoundryAgent } from './agent';

const connection = createFoundryAgent({ version: packageJson.version }).connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
await connection.closed;
process.exit(0);
