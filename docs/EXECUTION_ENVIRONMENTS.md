# Execution Environments

How Foundry agents interact with systems beyond LLM text generation.

---

## The Problem

LLMs generate text. To do useful work, they need to *execute* — read files,
run commands, navigate browsers, call APIs. The execution environment determines
what an agent can do and how efficiently it does it.

**Bash was the first execution layer.** Models generate a grep command (7 tokens),
get back 30 tokens of relevant code, and now have precise context instead of
dumping the entire codebase (100K+ tokens) into the prompt. This is why coding
agents work at all — deterministic tool calls compensate for nondeterministic
generation.

**But bash isn't enough.** No type safety, no structured I/O, no permission
standards, no isolation between agents, no way to know if a command is destructive.
Each execution environment trades off differently across these concerns.

---

## Available Environments

### `bash` — Direct Shell

The default. Agent generates shell commands executed on the host system.

```json
{
  "id": "executor-fix",
  "executionEnv": "bash",
  "permissions": "supervised"
}
```

**When to use:**
- File search (grep, find, ripgrep)
- Git operations
- Running tests, linters, builds
- System administration tasks

**Strengths:** Universal, well-understood by models, can do anything.
**Weaknesses:** No isolation, no type safety, destructive commands look the same
as safe ones, every CLI has different output formats.

**Token efficiency:** High for discovery (grep is ~7 tokens for a precise search),
low for data transformation (piping through sed/awk/jq is verbose and fragile).

**Capability gate:** Requires `exec:shell`.

---

### `just-bash` — Virtualized Shell

Bash semantics in a sandboxed environment. Uses [just-bash](https://github.com/nichochar/just-bash)
to provide shell commands without real filesystem access. The agent thinks
it's using bash, but everything runs in-memory.

```json
{
  "id": "executor-sandbox",
  "executionEnv": "just-bash",
  "permissions": "bypass"
}
```

**When to use:**
- Multi-tenant environments (multiple users sharing one server)
- Untrusted agent execution
- Testing agent behavior without side effects
- Cloud-hosted agent workers

**Strengths:** Agents don't need to change behavior — bash commands just work.
Fully isolated. No filesystem escape. Safe to run with `permissions: "bypass"`.
**Weaknesses:** Can't access real system state. Limited to what just-bash implements.

**Token efficiency:** Same as bash — the agent generates identical commands.

**Capability gate:** `exec:shell` maps to the virtualized shell. No `file:write`
or `file:delete` capabilities needed (writes are in-memory only).

**Setup:**
```typescript
import { createJustBash } from "just-bash";

const sandbox = createJustBash({
  // Seed with project files for the agent to explore
  files: await loadProjectFiles(projectPath),
});

// Use as the execution backend for the agent's shell calls
const executor = new Executor({
  id: "sandboxed-agent",
  stack,
  handler: async (ctx, payload) => {
    // Agent's bash commands route through the sandbox
    return sandbox.exec(payload);
  },
});
```

---

### `typescript` — Code Execution in Isolate

Agent writes TypeScript/JavaScript that runs in a V8 isolate or Bun subprocess.
Instead of piping data through bash, the agent writes real code.

```json
{
  "id": "executor-data",
  "executionEnv": "typescript",
  "permissions": "supervised"
}
```

**When to use:**
- Data filtering and transformation (where bash pipes get ugly)
- API calls that need structured request/response handling
- Complex logic that benefits from type checking
- When the agent needs to chain multiple operations without round-tripping
  back to the LLM between each step

**Strengths:** Typed inputs/outputs. Models are trained on TypeScript — they
write it better than bash one-liners. A single TS block can do what would take
5+ bash tool calls, each requiring LLM round-trips. Cloudflare's code-mode
showed ~40% fewer tokens vs MCP tool calls for the same tasks.
**Weaknesses:** Needs a runtime (Bun/Node/V8 isolate). Heavier than a shell command.

**Token efficiency:** Much higher for multi-step operations. Instead of:
```
Tool call 1: fetch users → 43K tokens of JSON back to model
Tool call 2: model reads JSON, generates filter command
Tool call 3: fetch filtered result
```
The agent writes:
```typescript
const users = await fetch("/api/users").then(r => r.json());
const active = users.filter(u => u.lastLogin > Date.now() - 86400000);
return active.map(u => ({ id: u.id, name: u.name }));
// Only the filtered result goes back to the model
```

**Capability gate:** `exec:process` for general execution. Can be scoped with
additional custom capabilities per-API.

---

### `browser` — Web Interaction

Agent navigates and interacts with web pages. Two distinct modes:

#### Playwright MCP (click-based)

The agent receives a page snapshot (accessibility tree), then issues click/fill/
navigate commands. Works like a human using a screen reader.

```json
{
  "id": "executor-browse",
  "executionEnv": "browser",
  "browser": {
    "mode": "playwright-mcp",
    "screenshots": true,
    "maxNavigations": 10,
    "allowedUrls": ["https://your-app.dev/*"]
  }
}
```

**When to use:**
- Testing your own web app (navigate, fill forms, verify state)
- Scraping pages that require interaction (login, pagination)
- Any task where visual page structure matters

**Strengths:** Works with any page. Models understand accessibility trees well.
Screenshots provide visual verification. Playwright MCP handles session state.
**Weaknesses:** Verbose — each click/fill/navigate is a separate tool call.
The accessibility snapshot can be large (thousands of tokens for complex pages).
Multiple round-trips between model and browser for simple tasks.

#### JS Execution (code-based)

The agent writes JavaScript that executes directly in the page context.
Instead of "click the button with text 'Submit'", the agent writes
`document.querySelector('form').submit()`.

```json
{
  "id": "executor-browse-js",
  "executionEnv": "browser",
  "browser": {
    "mode": "js-execute",
    "screenshots": false,
    "allowedUrls": ["https://your-app.dev/*"]
  }
}
```

**When to use:**
- Data extraction from pages (agent writes querySelectorAll + map)
- Complex multi-step page interactions (agent writes a single script)
- When you need token efficiency over visual verification
- Models specifically trained for this pattern (GPT 5.4, Claude with tools)

**Strengths:** Dramatically fewer tokens. One script replaces 5-10 click commands.
Deterministic — code does exactly what it says. Can filter/transform data
before returning to the model (same benefit as `typescript` env).
**Weaknesses:** Requires the model to understand the page's DOM structure.
Less robust to UI changes. No visual verification unless combined with screenshots.
Higher security surface — JS execution in page context can do anything.

#### Hybrid Browser Mode

Best of both: Playwright MCP for navigation and discovery, JS execution for
data extraction and complex interactions.

```json
{
  "id": "executor-browse-hybrid",
  "executionEnv": "browser",
  "browser": {
    "mode": "hybrid",
    "screenshots": true,
    "maxNavigations": 20,
    "allowedUrls": ["https://*.your-domain.com/*"]
  }
}
```

**Capability gate for all browser modes:**
- `browser:navigate` — loading URLs
- `browser:interact` — clicking, filling forms (Playwright MCP)
- `browser:execute` — running JS in page context (prompted by default)
- `browser:screenshot` — capturing page state

---

### `hybrid` — Multi-Environment

Agent can use multiple execution environments, choosing per-task. The router
or the agent itself decides which environment fits.

```json
{
  "id": "executor-fullstack",
  "executionEnv": "hybrid",
  "browser": {
    "mode": "hybrid",
    "screenshots": true
  },
  "permissions": "supervised"
}
```

**When to use:**
- Full-stack agents that need to read code (bash), transform data (typescript),
  and verify in browser (browser)
- Investigation/debugging workflows
- Agents that triage and delegate to the right execution mode

---

## Decision Matrix

| Task | Best Env | Why |
|------|----------|-----|
| Find a function definition | `bash` | `grep -rn "function foo"` — 7 tokens, deterministic |
| Filter 10K rows to 3 matches | `typescript` | `.filter()` runs once, returns 3 rows — not 10K tokens |
| Run test suite | `bash` | `bun test` — straightforward shell command |
| Fill a web form | `browser` (playwright) | Click-based interaction with visual verification |
| Extract table data from a page | `browser` (js-execute) | `querySelectorAll('tr')` + map — returns clean JSON |
| Multi-step API workflow | `typescript` | Chain fetch calls, handle errors, return summary |
| Sandboxed code review | `just-bash` | Agent reads code without write access |
| End-to-end app verification | `hybrid` | Read code (bash) → check browser (browser) → verify API (typescript) |

---

## Configuring Agents

### In `.foundry/settings.json`

```json
{
  "agents": {
    "executor-build": {
      "id": "executor-build",
      "kind": "executor",
      "executionEnv": "bash",
      "prompt": "...",
      "provider": "claude-code",
      "model": "sonnet",
      "enabled": true
    },
    "executor-verify": {
      "id": "executor-verify",
      "kind": "executor",
      "executionEnv": "browser",
      "browser": {
        "mode": "hybrid",
        "screenshots": true,
        "maxNavigations": 10,
        "allowedUrls": ["http://localhost:*/*"]
      },
      "prompt": "Verify the implementation by checking the running app in the browser.",
      "provider": "claude-code",
      "model": "sonnet",
      "permissions": "supervised",
      "enabled": true
    },
    "executor-sandbox": {
      "id": "executor-sandbox",
      "kind": "executor",
      "executionEnv": "just-bash",
      "prompt": "Review and analyze the codebase. Read-only — no changes.",
      "provider": "claude-code",
      "model": "haiku",
      "permissions": "bypass",
      "enabled": true
    }
  }
}
```

### Per-Project Overrides

A project can override execution environments for its agents:

```json
{
  "projects": {
    "web-app": {
      "id": "web-app",
      "path": "/path/to/web-app",
      "agents": {
        "executor-build": {
          "executionEnv": "hybrid",
          "browser": {
            "mode": "playwright-mcp",
            "allowedUrls": ["http://localhost:3000/*"]
          }
        }
      }
    }
  }
}
```

---

## Capability Gating

Each execution environment maps to capabilities that the `CapabilityGate` checks:

| Environment | Required Capabilities |
|-------------|----------------------|
| `bash` | `exec:shell`, `file:read`, `file:write` |
| `just-bash` | `exec:shell` (virtualized) |
| `typescript` | `exec:process` |
| `browser` (navigate) | `browser:navigate` |
| `browser` (interact) | `browser:interact` |
| `browser` (js-execute) | `browser:execute` |
| `browser` (screenshot) | `browser:screenshot` |

Use the built-in `BROWSER_POLICY` for browser-capable agents:

```typescript
import { CapabilityGate, BROWSER_POLICY } from "@inixiative/foundry-core";

const gate = new CapabilityGate(BROWSER_POLICY, actionQueue);
// navigate: allow, interact: allow, execute: prompt, screenshot: allow
```

---

## Token Efficiency Guidelines

The core insight: **use the environment that minimizes round-trips and result size.**

1. **Discovery** — bash is king. A grep command is 7 tokens. Let the agent find
   what it needs with deterministic search, not by reading everything.

2. **Transformation** — TypeScript beats bash. When the agent needs to filter,
   map, or reshape data, one TS block replaces multiple bash pipes + LLM
   round-trips. The model is better at writing TypeScript than awk.

3. **Interaction** — browser mode (JS) beats click-based for efficiency, but
   click-based (Playwright MCP) is more robust to UI changes. Use JS execution
   when the DOM structure is known/stable, Playwright for exploration.

4. **Verification** — browser screenshots are cheap context. A screenshot is
   worth 1000 tokens of accessibility tree description.

5. **Isolation** — just-bash is free isolation. Use it whenever the agent
   doesn't need real system access. No permission prompts, no risk.

---

## Native Tool Adapters

Foundry provides built-in tool adapters that wrap best-in-class libraries
with structured I/O, capability gating, and observability. Agents interact
with these through the `ToolRegistry` — no MCP schemas, no prompt bloat.

### ToolRegistry

The registry is how agents discover tools. Instead of injecting all tool
descriptions into the prompt (which eats context), agents get a one-line
summary per tool and call typed methods.

```typescript
import { ToolRegistry } from "@inixiative/foundry-core";
import { PlaywrightBrowser, HttpApi } from "@inixiative/foundry";

const registry = new ToolRegistry();

// Register tools with short descriptions
const browser = new PlaywrightBrowser({ allowedUrls: ["http://localhost:*/*"] });
await browser.launch();
registry.register(browser, "Navigate and interact with web pages");

const api = new HttpApi({ baseUrl: "https://api.example.com", bearerToken: "..." });
registry.register(api, "Make HTTP requests to the Example API");

// What agents see in context (compact — not 72K tokens of MCP schemas):
console.log(registry.summary());
// - browser (browser): Navigate and interact with web pages
// - api (api): Make HTTP requests to the Example API

// Agents get typed tool instances:
const browserTool = registry.byKind("browser");
const apiTool = registry.byKind("api");
```

### PlaywrightBrowser

Wraps Playwright with Foundry's typed `BrowserTool` interface. Every
operation returns a `ToolResult` with structured data + a compact summary.

```typescript
import { PlaywrightBrowser } from "@inixiative/foundry";

const browser = new PlaywrightBrowser({
  headless: true,
  allowedUrls: ["http://localhost:3000/*"],
  maxNavigations: 20,
});
await browser.launch();

// Navigate — returns { url, title }, not raw HTML
const nav = await browser.navigate("http://localhost:3000/dashboard");
// nav.summary: 'Navigated to http://localhost:3000/dashboard — "Dashboard"'

// Snapshot — structured accessibility tree, not DOM dump
const snap = await browser.snapshot();
// snap.data.elements: [{ role: "button", name: "Save" }, ...]
// snap.estimatedTokens: 340

// JS execution — run code in page, get serializable result
const data = await browser.evaluate(`
  Array.from(document.querySelectorAll('.user-row'))
    .map(row => ({
      name: row.querySelector('.name')?.textContent,
      email: row.querySelector('.email')?.textContent,
    }))
`);
// data.data: [{ name: "Alice", email: "alice@..." }, ...]
// Not 10K tokens of HTML — just the data the agent needs.

// Click, fill, screenshot — all typed
await browser.click('button[data-testid="save"]');
await browser.fill('input[name="email"]', "test@example.com");
const shot = await browser.screenshot();
// shot.data.base64: "iVBORw0KGgo..."

await browser.close();
```

**Peer dependency:** `bun add playwright`

**Shared sessions:** Pass `contextId` to share browser auth state across agents:
```typescript
const login = new PlaywrightBrowser({ contextId: "shared-auth" });
const verify = new PlaywrightBrowser({ contextId: "shared-auth" });
// Both share cookies, localStorage, session state
```

### HttpApi

Wraps `fetch` with structured request/response, auth management, URL gating,
and response truncation. Better than curl because results are typed JSON,
not raw text that the model has to parse.

```typescript
import { HttpApi } from "@inixiative/foundry";

const api = new HttpApi({
  baseUrl: "https://api.example.com",
  bearerToken: process.env.API_TOKEN,
  maxResponseSize: 512_000, // 512KB — truncate large responses
  allowedUrls: ["https://api.example.com/**"],
});

// Typed request/response — no parsing raw curl output
const users = await api.get<{ id: string; name: string }[]>("/users?active=true");
// users.data.status: 200
// users.data.body: [{ id: "1", name: "Alice" }, ...]
// users.summary: "GET /users?active=true — 200 OK (42ms)"
// users.estimatedTokens: 156

// POST with JSON body — Content-Type set automatically
const created = await api.post("/users", { name: "Bob", email: "bob@example.com" });

// Auth token updated at runtime (e.g., after OAuth flow)
api.setBearerToken(newToken);
```

### JustBashShell

Wraps [just-bash](https://github.com/nichochar/just-bash) for sandboxed shell
execution. Agents write normal grep/find/cat commands, but everything runs in
a virtual in-memory filesystem. Nothing touches the real disk.

```typescript
import { JustBashShell } from "@inixiative/foundry";

const shell = new JustBashShell({
  // Seed with project files — agent can grep/cat these
  files: {
    "src/index.ts": await Bun.file("src/index.ts").text(),
    "package.json": await Bun.file("package.json").text(),
  },
  timeout: 15_000,
});
registry.register(shell, "Sandboxed shell for code analysis");

// Agent uses normal commands — same as real bash
const result = await shell.exec("grep -rn 'export default' src/");
// result.data.stdout: "src/index.ts:5:export default ..."
// result.summary: "$ grep -rn 'export default' src/ — OK (12ms, 45 chars)"

// Seed more files later (e.g., when thread context changes)
await shell.seedFiles({ "src/new-file.ts": "..." });
```

**Peer dependency:** `bun add just-bash`

Safe to run with `permissions: "bypass"` — there's no real filesystem to damage.

### BunScript

Executes TypeScript/JS in an isolated Bun subprocess. Each `evaluate()` call
spawns a fresh process — no state leaks between executions. Communication with
shared data sources happens through the agent's handler, not through the
subprocess.

```typescript
import { BunScript } from "@inixiative/foundry";

const script = new BunScript({ timeout: 10_000 });
registry.register(script, "Execute TypeScript for data transformation");

// Agent writes code — receives input via injected modules
const result = await script.evaluate(`
  const data = JSON.parse(input);
  return data.users
    .filter(u => u.lastLogin > Date.now() - 86400000)
    .map(u => ({ id: u.id, name: u.name }));
`, {
  modules: { input: JSON.stringify(userData) },
});
// result.data.result: [{ id: "1", name: "Alice" }]
// result.data.logs: [] (captured console.log output)
// result.data.durationMs: 23

// Why this beats bash for data work:
//   bash:   curl $url | jq '.users[] | select(.active)' — fragile, verbose
//   script: data.users.filter(u => u.active) — typed, composable, one shot
```

**No peer deps** — uses Bun's built-in `eval` subprocess.

API keys are stripped from the subprocess environment — scripts can't
accidentally use LLM credentials.

---

## Wiring Tools into Agents

### Thread Factory Integration

The `ThreadFactory` reads `executionEnv` from agent config and wires
the appropriate tools into the agent's handler:

```typescript
import { ThreadFactory, PlaywrightBrowser, HttpApi } from "@inixiative/foundry";
import { ToolRegistry, BROWSER_POLICY, CapabilityGate } from "@inixiative/foundry-core";

// 1. Create registry and register tools
const registry = new ToolRegistry();

const browser = new PlaywrightBrowser({
  allowedUrls: ["http://localhost:3000/*"],
});
await browser.launch();
registry.register(browser, "Local dev app browser");

const api = new HttpApi({ baseUrl: "http://localhost:3000/api" });
registry.register(api, "Local dev API");

// 2. Create capability gate for browser agents
const gate = new CapabilityGate(BROWSER_POLICY, actionQueue);

// 3. Agents access tools through registry in their handlers
const factory = new ThreadFactory({
  provider,
  tokenTracker,
  sourceResolver,
});
```

### Agent Handler Example

An executor handler that uses both browser and API tools:

```typescript
const handler = async (ctx: string, payload: string) => {
  const browser = registry.byKind("browser")!;
  const api = registry.byKind("api")!;

  // Check capability before browser use
  await gate.require("browser:navigate", { agentId: "executor-verify", threadId });

  // Navigate and verify
  const nav = await browser.navigate("http://localhost:3000/dashboard");
  const snap = await browser.snapshot();

  // Extract data via JS (fewer tokens than parsing snapshot)
  const counts = await browser.evaluate(`({
    users: document.querySelectorAll('.user-row').length,
    alerts: document.querySelectorAll('.alert').length,
  })`);

  // Cross-check against API
  const apiData = await api.get("/dashboard/stats");

  return JSON.stringify({
    browser: { url: nav.data?.url, title: nav.data?.title },
    pageData: counts.data,
    apiData: apiData.data?.body,
    match: counts.data?.users === apiData.data?.body?.userCount,
  });
};
```

---

## Future: Sandboxed TypeScript with just-js

As [just-js](https://github.com/nichochar/just-js) matures, it will provide
the same isolation benefits as just-bash but for TypeScript execution:

- Agents write TypeScript that runs in an isolated V8 context
- Virtual filesystem access (read project files without real FS)
- Network calls proxied through a permission layer
- No escape to the host system

This is the convergence point: typed code execution + sandbox isolation +
browser-like APIs. When it's ready, it becomes the default `ScriptTool`
implementation.
