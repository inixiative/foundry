// ---------------------------------------------------------------------------
// Foundry MCP Server — mid-session bridge (FLOW.md Loop 2)
//
// Exposes foundry context to a running Claude Code session via MCP tools.
// The agent calls these tools when it discovers knowledge gaps mid-task.
// Each tool routes to the relevant warm cache in the thread's ContextStack.
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import type {
  Thread,
  SignalBus,
  ContextStack,
  ContextLayer,
  SignalKind,
} from "@inixiative/foundry-core";
import type { SessionManager } from "../agents/session";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FoundryMcpConfig {
  /** The active thread this MCP server is bridging. */
  thread: Thread;
  /** Session manager for cross-thread queries. */
  sessionManager?: SessionManager;
  /** Server name for MCP identification. */
  name?: string;
  /** Server version. */
  version?: string;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a Foundry MCP server with the 5 tool surface from FLOW.md:
 *
 * - foundry_query     — pull context from warm caches by topic
 * - foundry_conventions — get conventions for a domain
 * - foundry_memory    — search memory layers
 * - foundry_threads   — get sibling thread summaries
 * - foundry_signal    — emit a signal into the bus
 */
export function createFoundryMcpServer(config: FoundryMcpConfig): McpServer {
  const { thread, sessionManager } = config;
  const stack = thread.stack;
  const signals = thread.signals;

  const server = new McpServer({
    name: config.name ?? "foundry",
    version: config.version ?? "0.1.0",
  });

  // -----------------------------------------------------------------------
  // foundry_query — "What do you know about [topic]?"
  //
  // Searches warm layer content by keyword match. Returns summary (map entry)
  // or full hydrated content depending on detail level.
  // -----------------------------------------------------------------------
  server.tool(
    "foundry_query",
    "Search Foundry's warm caches for context about a topic. Use when you hit a knowledge gap about the codebase, conventions, or prior decisions.",
    {
      topic: z.string().describe("The topic to search for (e.g., 'auth', 'payment processing', 'test patterns')"),
      detail: z.enum(["summary", "full"]).default("summary").describe("'summary' returns compact matches (~50 tokens each). 'full' returns hydrated layer content (~1-8k tokens)."),
    },
    async ({ topic, detail }) => {
      const matches = findMatchingLayers(stack, topic);

      if (matches.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No context found for "${topic}". Try a broader search term, or use native file/grep tools.` }],
        };
      }

      if (detail === "summary") {
        const summaries = matches.map((l) => {
          const tokens = estimateTokens(l.content);
          return `- **${l.id}** (${l.state}, ~${tokens} tokens, trust=${l.trust.toFixed(2)}): ${l.content.slice(0, 150).replace(/\n/g, " ")}...`;
        });
        return {
          content: [{ type: "text" as const, text: `Found ${matches.length} relevant layers for "${topic}":\n\n${summaries.join("\n")}` }],
        };
      }

      // detail === "full" — hydrate and return full content
      // Warm any cold layers first
      await Promise.all(matches.filter((l) => !l.isWarm).map((l) => l.warm()));

      const sections = matches.map((l) => `## ${l.id}\n\n${l.content}`);
      return {
        content: [{ type: "text" as const, text: sections.join("\n\n---\n\n") }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // foundry_conventions — "What are the conventions for [domain]?"
  //
  // Returns conventions from layers tagged with convention-related IDs.
  // -----------------------------------------------------------------------
  server.tool(
    "foundry_conventions",
    "Get project conventions for a specific domain. Use before writing code to ensure it follows established patterns.",
    {
      domain: z.string().describe("The domain to get conventions for (e.g., 'auth', 'testing', 'api', 'naming')"),
    },
    async ({ domain }) => {
      const conventionLayers = stack.layers.filter((l) =>
        l.isWarm &&
        (l.id.includes("convention") || l.id.includes("pattern") || l.id.includes("rule")) &&
        (l.id.includes(domain) || l.content.toLowerCase().includes(domain.toLowerCase()))
      );

      if (conventionLayers.length === 0) {
        // Fallback: search all layers for convention-like content
        const fallback = findMatchingLayers(stack, `${domain} convention pattern rule`);
        if (fallback.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No conventions found for "${domain}". This domain may not have established conventions yet.` }],
          };
        }
        const sections = fallback.map((l) => `## ${l.id}\n\n${l.content}`);
        return {
          content: [{ type: "text" as const, text: `Found related context for "${domain}" conventions:\n\n${sections.join("\n\n---\n\n")}` }],
        };
      }

      const sections = conventionLayers.map((l) => `## ${l.id}\n\n${l.content}`);
      return {
        content: [{ type: "text" as const, text: `Conventions for "${domain}":\n\n${sections.join("\n\n---\n\n")}` }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // foundry_memory — "Have we seen [pattern] before?"
  //
  // Searches memory-tagged layers for relevant past decisions/observations.
  // -----------------------------------------------------------------------
  server.tool(
    "foundry_memory",
    "Search Foundry's memory for past decisions, failures, patterns, and observations. Use when you want to know if something has been tried before.",
    {
      query: z.string().describe("What to search for (e.g., 'auth middleware refactor', 'payment retry logic', 'this pattern failed')"),
    },
    async ({ query }) => {
      const memoryLayers = stack.layers.filter((l) =>
        l.isWarm &&
        (l.id.includes("memory") || l.id.includes("history") || l.id.includes("decision") || l.id.includes("observation"))
      );

      // Search across memory layers
      const matches = memoryLayers.filter((l) =>
        l.content.toLowerCase().includes(query.toLowerCase())
      );

      // Also search general layers as fallback
      if (matches.length === 0) {
        const general = findMatchingLayers(stack, query);
        if (general.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No memory entries found for "${query}". This may be new territory.` }],
          };
        }
        const sections = general.slice(0, 3).map((l) => `## ${l.id}\n\n${l.content}`);
        return {
          content: [{ type: "text" as const, text: `No direct memory matches, but found related context:\n\n${sections.join("\n\n---\n\n")}` }],
        };
      }

      const sections = matches.map((l) => `## ${l.id}\n\n${l.content}`);
      return {
        content: [{ type: "text" as const, text: `Memory entries matching "${query}":\n\n${sections.join("\n\n---\n\n")}` }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // foundry_threads — "What are other threads working on?"
  //
  // Returns summaries of sibling threads from the session manager.
  // -----------------------------------------------------------------------
  server.tool(
    "foundry_threads",
    "Get summaries of other active threads. Use when you suspect another thread is working on related code or to avoid conflicts.",
    {},
    async () => {
      if (!sessionManager) {
        return {
          content: [{ type: "text" as const, text: "Thread awareness is not available (no session manager configured)." }],
        };
      }

      const currentThreadId = thread.id;
      const siblings = [...sessionManager.threads.values()].filter((t) => t.id !== currentThreadId);

      if (siblings.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No other active threads." }],
        };
      }

      const summaries = siblings.map((t) => {
        const meta = t.meta;
        const tags = meta.tags.length > 0 ? ` [${meta.tags.join(", ")}]` : "";
        return `- **${t.id}**${tags}: ${meta.description} (status: ${meta.status}, messages: ${meta.messageCount})`;
      });

      return {
        content: [{ type: "text" as const, text: `Active sibling threads (${siblings.length}):\n\n${summaries.join("\n")}` }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // foundry_signal — "I found something important"
  //
  // Emits a signal directly into the thread's signal bus. Immediate, not
  // deferred. Used by the session to report observations back to Foundry.
  // -----------------------------------------------------------------------
  server.tool(
    "foundry_signal",
    "Emit a signal to Foundry about something you observed. Use when you find missing context, wrong conventions, security concerns, or architecture observations.",
    {
      kind: z.enum([
        "missing_context",
        "wrong_convention",
        "security_concern",
        "architecture_observation",
        "correction",
        "info",
      ]).describe("The type of signal"),
      content: z.string().describe("Description of what you observed"),
      confidence: z.number().min(0).max(1).default(0.8).describe("How confident you are (0-1)"),
    },
    async ({ kind, content: signalContent, confidence }) => {
      signals.emit({
        kind: kind as SignalKind,
        source: "session-mcp",
        content: signalContent,
        confidence,
      });

      return {
        content: [{ type: "text" as const, text: `Signal emitted: [${kind}] ${signalContent.slice(0, 100)}` }],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

/**
 * Start the MCP server on stdio transport.
 * Used when Claude Code spawns the MCP server as a subprocess.
 */
export async function startStdioTransport(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Create an SSE transport handler for embedding in an HTTP server.
 * Used when the MCP server runs alongside the viewer.
 */
export function createSseTransport(): SSEServerTransport {
  return new SSEServerTransport("/mcp/messages");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple keyword search across warm layer content. */
function findMatchingLayers(stack: ContextStack, query: string): ContextLayer[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [];

  return stack.layers
    .filter((l) => l.isWarm && l.content.length > 0)
    .map((l) => {
      const lowerContent = l.content.toLowerCase();
      const lowerId = l.id.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (lowerId.includes(kw)) score += 3; // ID match is strong signal
        if (lowerContent.includes(kw)) score += 1;
      }
      return { layer: l, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.layer);
}

/** Rough token estimate: ~4 chars per token for code, ~0.75 words per token for prose. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
