/**
 * @atlas
 * @kind script
 * @partOf feature:threads
 */
// Live probe (not a test): Foundry's MCP bridge with the thread-record tools over stdio, writing the
// thread's record (name, status, plan, loop) to PLAN_OUT after each write, so a real Claude session
// with Foundry's skills can be checked for calling them.
import { writeFileSync } from 'node:fs';
import { ContextStack, Thread, ToolRegistry } from '@inixiative/foundry-core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFoundryMcp } from '../../src/mcp/server';
import {
  describeRecord,
  THREAD_RECORD_TOOL_DESCRIPTION,
  ThreadRecordTool,
} from '../../src/tools/thread-record';

const thread = new Thread('probe', new ContextStack(), { description: '' });
const tools = new ToolRegistry();
tools.register(
  new ThreadRecordTool(() => ({
    read: () => thread,
    update: (_threadId, change) => {
      const result = change(thread);
      writeFileSync(process.env.PLAN_OUT ?? 'plan.json', describeRecord(thread));
      return result;
    },
  })),
  THREAD_RECORD_TOOL_DESCRIPTION,
);
await createFoundryMcp({ thread, tools }).server.connect(new StdioServerTransport());
