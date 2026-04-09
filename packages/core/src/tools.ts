// ---------------------------------------------------------------------------
// Tools — typed interfaces for agent execution environments
// ---------------------------------------------------------------------------
//
// Agents need to do more than generate text. They need to search code,
// navigate browsers, call APIs, and execute scripts. Each of these is a
// "tool" with typed inputs/outputs, capability requirements, and
// observable side effects.
//
// This file defines the interfaces. Implementations live in adapters
// (core: lightweight, foundry: heavy-infra).
//
// Design principles:
// - Every tool operation maps to a capability for gating
// - Tool results are structured (JSON), not raw text — models waste
//   fewer tokens parsing unstructured output
// - Tools are registry-managed so agents discover what's available
//   without bloating their context with tool descriptions upfront
// ---------------------------------------------------------------------------

import type { Capability } from "./capability";
import type { ToolDefinition } from "./types";

// ---------------------------------------------------------------------------
// Tool result — every tool returns this wrapper
// ---------------------------------------------------------------------------

export interface ToolResult<T = unknown> {
  /** Whether the operation succeeded. */
  ok: boolean;
  /** Structured result data. */
  data?: T;
  /** Human-readable summary (for injecting into agent context). */
  summary: string;
  /** Error message if ok=false. */
  error?: string;
  /** Token estimate for the result (helps agents budget context). */
  estimatedTokens?: number;
}

// ---------------------------------------------------------------------------
// BrowserTool — navigate, interact with, and extract data from web pages
// ---------------------------------------------------------------------------

/** Accessibility tree element from a page snapshot. */
export interface PageElement {
  role: string;
  name: string;
  ref?: string;
  value?: string;
  children?: PageElement[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
  /** Estimated token count of the full snapshot. */
  estimatedTokens: number;
}

export interface NavigateOpts {
  /** Wait for this selector to appear before returning. */
  waitFor?: string;
  /** Timeout in ms. Default: 30000. */
  timeout?: number;
}

export interface BrowserTool {
  readonly id: string;
  readonly kind: "browser";

  /** Required capabilities for each operation. */
  readonly capabilities: {
    navigate: Capability;
    interact: Capability;
    execute: Capability;
    screenshot: Capability;
  };

  /** Navigate to a URL. */
  navigate(url: string, opts?: NavigateOpts): Promise<ToolResult<{ url: string; title: string }>>;

  /** Get the current page's accessibility tree snapshot. */
  snapshot(): Promise<ToolResult<PageSnapshot>>;

  /** Click an element by reference ID or selector. */
  click(ref: string): Promise<ToolResult<void>>;

  /** Fill a form field by reference ID or selector. */
  fill(ref: string, value: string): Promise<ToolResult<void>>;

  /** Select an option in a dropdown. */
  select(ref: string, value: string): Promise<ToolResult<void>>;

  /** Execute JavaScript in the page context. Returns serializable result. */
  evaluate<T = unknown>(script: string): Promise<ToolResult<T>>;

  /** Take a screenshot. Returns base64-encoded image. */
  screenshot(): Promise<ToolResult<{ base64: string; mimeType: string }>>;

  /** Get current page URL. */
  currentUrl(): Promise<string>;

  /** Close the browser / release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ApiTool — structured HTTP requests (better than curl)
// ---------------------------------------------------------------------------

export interface ApiRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: unknown;
  /** Timeout in ms. Default: 30000. */
  timeout?: number;
  /** Parse response body as this type. Default: "json". */
  responseType?: "json" | "text" | "buffer";
}

export interface ApiResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: T;
  /** Round-trip time in ms. */
  durationMs: number;
}

export interface ApiToolConfig {
  /** Base URL prepended to relative paths. */
  baseUrl?: string;
  /** Default headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /** Auth token applied as Authorization: Bearer header. */
  bearerToken?: string;
  /** Max response body size in bytes before truncation. Default: 1MB. */
  maxResponseSize?: number;
  /** Allowed URL patterns (glob). Empty = allow all. */
  allowedUrls?: string[];
  /** Blocked URL patterns (glob). Takes precedence. */
  blockedUrls?: string[];
}

export interface ApiTool {
  readonly id: string;
  readonly kind: "api";

  /** Required capability. */
  readonly capability: Capability;

  /** Make an HTTP request. */
  request<T = unknown>(req: ApiRequest): Promise<ToolResult<ApiResponse<T>>>;

  /** Convenience: GET request. */
  get<T = unknown>(url: string, headers?: Record<string, string>): Promise<ToolResult<ApiResponse<T>>>;

  /** Convenience: POST request with JSON body. */
  post<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<ToolResult<ApiResponse<T>>>;

  /** Convenience: PUT request with JSON body. */
  put<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<ToolResult<ApiResponse<T>>>;

  /** Convenience: DELETE request. */
  delete<T = unknown>(url: string, headers?: Record<string, string>): Promise<ToolResult<ApiResponse<T>>>;
}

// ---------------------------------------------------------------------------
// ShellTool — structured shell execution (better than raw bash)
// ---------------------------------------------------------------------------

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Whether stdout was truncated to fit token budget. */
  truncated: boolean;
  durationMs: number;
}

/**
 * Output filter function — transforms command output before returning.
 * Use this for RTK-style token reduction: strip noise, compress
 * repetitive output, remove ANSI codes, etc.
 */
export type OutputFilter = (stdout: string, command: string) => string;

export interface ShellOpts {
  /** Working directory. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Timeout in ms. Default: 120000. */
  timeout?: number;
  /** Max stdout bytes before truncation. Default: 100KB. */
  maxOutput?: number;
  /** Run in sandboxed mode (just-bash). */
  sandbox?: boolean;
  /**
   * Output filter applied before returning results.
   * Use for RTK-style token savings — strip ANSI, compress whitespace,
   * remove noise lines, etc. Applied after execution, before truncation.
   */
  outputFilter?: OutputFilter;
}

export interface ShellTool {
  readonly id: string;
  readonly kind: "shell";

  /** Required capability. */
  readonly capability: Capability;

  /** Execute a shell command. */
  exec(command: string, opts?: ShellOpts): Promise<ToolResult<ShellResult>>;

  /** Execute and return only stdout (convenience). */
  run(command: string, opts?: ShellOpts): Promise<string>;

  /** Check if a command exists. */
  which(command: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// ScriptTool — TypeScript/JS execution in isolate
// ---------------------------------------------------------------------------

export interface ScriptResult<T = unknown> {
  /** The return value of the script. */
  result: T;
  /** Console output captured during execution. */
  logs: string[];
  durationMs: number;
}

export interface ScriptOpts {
  /** Timeout in ms. Default: 30000. */
  timeout?: number;
  /** Modules available to the script (injected into scope). */
  modules?: Record<string, unknown>;
  /** Whether to capture console.log output. Default: true. */
  captureLogs?: boolean;
}

export interface ScriptTool {
  readonly id: string;
  readonly kind: "script";

  /** Required capability. */
  readonly capability: Capability;

  /** Execute a TypeScript/JS script and return the result. */
  evaluate<T = unknown>(code: string, opts?: ScriptOpts): Promise<ToolResult<ScriptResult<T>>>;
}

// ---------------------------------------------------------------------------
// MemoryTool — query and store across any memory backend
// ---------------------------------------------------------------------------
//
// Wraps the common contract that all Foundry memory adapters follow:
// write/get/search/delete + asSource + signalWriter.
//
// Why this matters as a tool (vs just a layer source):
// - Layers inject context passively at warm time
// - MemoryTool lets agents query on demand during execution
// - Agent decides what to search for based on the task, not upfront config
// - Results go through ToolResult (structured, token-estimated, truncated)

export interface MemoryEntry {
  id: string;
  kind: string;
  content: string;
  source?: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface MemorySearchOpts {
  /** Filter by entry kind. */
  kind?: string;
  /** Max results. Default: 20. */
  limit?: number;
  /** Minimum relevance score (0-1) if backend supports scoring. */
  minScore?: number;
}

export interface MemoryTool {
  readonly id: string;
  readonly kind: "memory";
  /** The underlying system name (e.g., "file", "sqlite", "redis", "supermemory"). */
  readonly system: string;

  /** Required capabilities. */
  readonly capabilities: {
    read: Capability;
    write: Capability;
    delete: Capability;
  };

  /** Search memory by query string. */
  search(query: string, opts?: MemorySearchOpts): Promise<ToolResult<MemoryEntry[]>>;

  /** Get a specific entry by ID. */
  get(id: string): Promise<ToolResult<MemoryEntry | null>>;

  /** List recent entries. */
  recent(limit?: number, kind?: string): Promise<ToolResult<MemoryEntry[]>>;

  /** Write an entry to memory. */
  write(entry: MemoryEntry): Promise<ToolResult<{ id: string }>>;

  /** Delete an entry. */
  delete(id: string): Promise<ToolResult<{ deleted: boolean }>>;
}

// ---------------------------------------------------------------------------
// Tool union type + registry
// ---------------------------------------------------------------------------

/** Any tool that can be registered. */
export type Tool = BrowserTool | ApiTool | ShellTool | ScriptTool | MemoryTool;

/** Tool kind discriminator. */
export type ToolKind = Tool["kind"];

/** Metadata about a registered tool (what agents see before using it). */
export interface ToolInfo {
  id: string;
  kind: ToolKind;
  /** Short description for agent context. */
  description: string;
  /** Capabilities required to use this tool. */
  capabilities: Capability[];
}

/**
 * ToolRegistry — agents discover and access tools through this.
 *
 * Instead of injecting all tool descriptions into agent context (which bloats
 * the prompt), agents query the registry for tools matching their needs.
 * The registry returns typed tool instances that go through capability gating.
 *
 * This is the "connector information" layer — adapters register here,
 * agents consume from here.
 */
export class ToolRegistry {
  private _tools = new Map<string, Tool>();
  private _info = new Map<string, ToolInfo>();

  /** Register a tool with its metadata. */
  register(tool: Tool, description: string): void {
    this._tools.set(tool.id, tool);

    const capabilities: Capability[] = [];
    if (tool.kind === "browser") {
      capabilities.push(
        tool.capabilities.navigate,
        tool.capabilities.interact,
        tool.capabilities.execute,
        tool.capabilities.screenshot,
      );
    } else if (tool.kind === "memory") {
      capabilities.push(
        tool.capabilities.read,
        tool.capabilities.write,
        tool.capabilities.delete,
      );
    } else {
      capabilities.push(tool.capability);
    }

    this._info.set(tool.id, {
      id: tool.id,
      kind: tool.kind,
      description,
      capabilities,
    });
  }

  /** Unregister a tool. */
  unregister(id: string): void {
    this._tools.delete(id);
    this._info.delete(id);
  }

  /** Get a tool by ID. */
  get<T extends Tool = Tool>(id: string): T | undefined {
    return this._tools.get(id) as T | undefined;
  }

  /** Get a tool by kind (returns first match). */
  byKind<K extends ToolKind>(kind: K): Extract<Tool, { kind: K }> | undefined {
    for (const tool of this._tools.values()) {
      if (tool.kind === kind) return tool as Extract<Tool, { kind: K }>;
    }
    return undefined;
  }

  /** Get all tools of a given kind. */
  allByKind<K extends ToolKind>(kind: K): Extract<Tool, { kind: K }>[] {
    const result: Extract<Tool, { kind: K }>[] = [];
    for (const tool of this._tools.values()) {
      if (tool.kind === kind) result.push(tool as Extract<Tool, { kind: K }>);
    }
    return result;
  }

  /** List all registered tool metadata (cheap — for agent context injection). */
  list(): ToolInfo[] {
    return Array.from(this._info.values());
  }

  /** List tools matching a capability filter. */
  listWithCapability(cap: Capability): ToolInfo[] {
    return this.list().filter((info) => info.capabilities.includes(cap));
  }

  /** Get a compact summary string for injecting into agent context. */
  summary(): string {
    const tools = this.list();
    if (tools.length === 0) return "No tools available.";
    return tools
      .map((t) => `- ${t.id} (${t.kind}): ${t.description}`)
      .join("\n");
  }

  /**
   * Generate LLM-compatible tool definitions from all registered tools.
   * Each tool method becomes a separate function the LLM can call.
   */
  toToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];

    for (const [id, tool] of this._tools) {
      const desc = this._info.get(id)?.description ?? id;

      switch (tool.kind) {
        case "shell":
          defs.push({
            name: `${id}_exec`,
            description: `[${id}] ${desc} — execute a shell command`,
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string", description: "Shell command to execute" },
              },
              required: ["command"],
            },
          });
          break;

        case "memory":
          defs.push(
            {
              name: `${id}_search`,
              description: `[${id}] Search ${desc}`,
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Search query" },
                  kind: { type: "string", description: "Filter by entry kind (optional)" },
                  limit: { type: "number", description: "Max results (default: 20)" },
                },
                required: ["query"],
              },
            },
            {
              name: `${id}_get`,
              description: `[${id}] Get entry by ID from ${desc}`,
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
            {
              name: `${id}_write`,
              description: `[${id}] Write an entry to ${desc}`,
              inputSchema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  kind: { type: "string" },
                  content: { type: "string" },
                },
                required: ["id", "kind", "content"],
              },
            },
          );
          break;

        case "script":
          defs.push({
            name: `${id}_evaluate`,
            description: `[${id}] ${desc} — execute code and return result`,
            inputSchema: {
              type: "object",
              properties: {
                code: { type: "string", description: "TypeScript/JS code to execute. Use 'return' to return a value." },
              },
              required: ["code"],
            },
          });
          break;

        case "api":
          defs.push({
            name: `${id}_request`,
            description: `[${id}] ${desc} — make an HTTP request`,
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
                body: { description: "Request body (JSON)" },
                headers: { type: "object", description: "Additional headers" },
              },
              required: ["url"],
            },
          });
          break;

        case "browser":
          defs.push(
            {
              name: `${id}_navigate`,
              description: `[${id}] Navigate to a URL`,
              inputSchema: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"],
              },
            },
            {
              name: `${id}_snapshot`,
              description: `[${id}] Get page accessibility snapshot`,
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: `${id}_click`,
              description: `[${id}] Click an element`,
              inputSchema: {
                type: "object",
                properties: { ref: { type: "string", description: "CSS selector or ref" } },
                required: ["ref"],
              },
            },
            {
              name: `${id}_evaluate`,
              description: `[${id}] Execute JavaScript in page`,
              inputSchema: {
                type: "object",
                properties: { script: { type: "string" } },
                required: ["script"],
              },
            },
          );
          break;
      }
    }

    return defs;
  }

  /**
   * Dispatch a tool call by name. Routes "toolId_method" to the right tool.
   * Returns the serialized result string.
   */
  async dispatch(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    // Parse "toolId_method" format
    const lastUnderscore = toolName.lastIndexOf("_");
    if (lastUnderscore === -1) {
      return { ok: false, summary: `Unknown tool: ${toolName}`, error: "Invalid tool name format" };
    }

    // Try progressively shorter prefixes (tool IDs can contain underscores)
    let tool: Tool | undefined;
    let method = "";
    for (let i = toolName.length - 1; i >= 0; i--) {
      if (toolName[i] === "_") {
        const candidateId = toolName.slice(0, i);
        const candidateMethod = toolName.slice(i + 1);
        if (this._tools.has(candidateId)) {
          tool = this._tools.get(candidateId);
          method = candidateMethod;
          break;
        }
      }
    }

    if (!tool) {
      return { ok: false, summary: `Unknown tool: ${toolName}`, error: `No registered tool matches "${toolName}"` };
    }

    try {
      switch (tool.kind) {
        case "shell":
          if (method === "exec") return await tool.exec(input.command as string);
          break;

        case "memory":
          if (method === "search") return await tool.search(input.query as string, { kind: input.kind as string, limit: input.limit as number });
          if (method === "get") return await tool.get(input.id as string);
          if (method === "write") return await tool.write({ id: input.id as string, kind: input.kind as string, content: input.content as string, timestamp: Date.now() });
          break;

        case "script":
          if (method === "evaluate") return await tool.evaluate(input.code as string);
          break;

        case "api":
          if (method === "request") return await tool.request({ url: input.url as string, method: (input.method as any) ?? "GET", body: input.body, headers: input.headers as Record<string, string> });
          break;

        case "browser":
          if (method === "navigate") return await tool.navigate(input.url as string);
          if (method === "snapshot") return await tool.snapshot();
          if (method === "click") return await tool.click(input.ref as string);
          if (method === "evaluate") return await tool.evaluate(input.script as string);
          break;
      }

      return { ok: false, summary: `Unknown method "${method}" for tool kind "${tool.kind}"`, error: "Method not found" };
    } catch (err) {
      return { ok: false, summary: `Tool error: ${(err as Error).message}`, error: (err as Error).message };
    }
  }

  /** Number of registered tools. */
  get size(): number {
    return this._tools.size;
  }
}
