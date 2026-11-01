/**
 * @atlas
 * @kind script
 * @partOf feature:threads
 */
// Live probe (not a test): Foundry's MCP bridge with set_plan over stdio, writing each recorded plan
// to PLAN_OUT, so a real Claude session with Foundry's skills can be checked for calling set_plan.
import { writeFileSync } from 'node:fs';
import { ContextStack, Thread, ToolRegistry } from '@inixiative/foundry-core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFoundryMcp } from '../../src/mcp/server';
import { applyPlanPatch, PLAN_TOOL_DESCRIPTION, ThreadPlanTool } from '../../src/tools/thread-plan';

const thread = new Thread('probe', new ContextStack(), { description: '' });
const tools = new ToolRegistry();
tools.register(
  new ThreadPlanTool(() => ({
    setPlan: (_threadId, patch) => {
      thread.meta.plan = applyPlanPatch(thread.meta.plan, patch);
      writeFileSync(process.env.PLAN_OUT ?? 'plan.json', JSON.stringify(thread.meta.plan, null, 2));
      return thread.meta.plan;
    },
  })),
  PLAN_TOOL_DESCRIPTION,
);
await createFoundryMcp({ thread, tools }).server.connect(new StdioServerTransport());
