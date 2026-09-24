import { ViewerFileAccess } from "../file-access";
import { constants } from "node:fs";
import { resolve as resolveFilePath } from "node:path";
import type {
  ActionQueue,
  Harness,
  TokenTracker,
  ToolRegistry,
} from "@inixiative/foundry-core";
import type { Hono } from "hono";
import { fromSettingsConfig, type ProjectRegistry } from "../../agents/project";
import type { ActionHandler, OperatorAction } from "../actions";
import type { AIAssist, AssistRequest } from "../ai-assist";
import type { AnalyticsStore, RollupPeriod } from "../analytics";
import {
  createProject,
  defaultProjectAgents,
  defaultProjectLayers,
  defaultProjectSources,
  type ConfigStore,
  type FoundryConfig,
  type McpSettingsConfig,
} from "../config";
import { validateId } from "../http-helpers";
import { readFileRef, writeFileRef, writeComposed, decomposeBack, RUNTIME_OUTPUT_FILES } from "../../prompts/composer";
import { FoundryTunnel, type TunnelInfo } from "../tunnel";
import { SESSION_COOKIE, sessionValue } from "../request-auth";
import { FoundrySelfChatStore, type SelfChatFocus } from "../foundry-self-chat";
import { registerAccessRoutes } from "./access";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isActionKind(value: string): value is OperatorAction["kind"] {
  return [
    "thread:pause",
    "thread:resume",
    "thread:archive",
    "thread:inspect",
    "layer:warm",
    "layer:invalidate",
    "agent:dispatch",
    "runtime:command",
    "system:snapshot",
  ].includes(value);
}

export interface ControlRoutesDeps {
  harness: Harness;
  actions: ActionHandler;
  configStore: ConfigStore;
  aiAssist: AIAssist | null;
  analyticsStore: AnalyticsStore | null;
  tokenTracker?: TokenTracker;
  projectRegistry?: ProjectRegistry;
  actionQueue: ActionQueue | null;
  /** Mutable tunnel holder — routes can start/stop the tunnel at runtime. */
  tunnelHolder: { tunnel: FoundryTunnel | null };
  /** Port the server is listening on (needed to start tunnel). */
  port: number;
  /** Directory for persistent foundry-self chat log. */
  selfChatDir?: string;
  /** Tool registry — when present, self-chat runs with the same tools as the executor. */
  assistTools?: ToolRegistry;
  /** Thread-list streams re-check membership (a removed project's threads become unowned). */
  threadsChanged: () => void;
}

export function registerControlRoutes(app: Hono, deps: ControlRoutesDeps): void {
  const protectedConfig = new ViewerFileAccess(deps.configStore.directory);
  protectedConfig.remember(deps.configStore.config);
  let initialProtection: Promise<void> | undefined;
  app.use("*", async (_c, next) => { initialProtection ??= deps.configStore.load().then(config => protectedConfig.remember(config)); await initialProtection; protectedConfig.remember(deps.configStore.config); return next(); });
  registerAccessRoutes(app, deps.configStore);
  const {
    harness,
    actions,
    configStore,
    aiAssist,
    analyticsStore,
    tokenTracker,
    projectRegistry,
    actionQueue,
    tunnelHolder,
    port,
    selfChatDir,
    assistTools,
  } = deps;

  const selfChat = new FoundrySelfChatStore(
    `${selfChatDir ?? ".foundry"}/foundry-self-chat.json`,
  );

  app.get("/api/definitions", async (c) => {
    await configStore.load();
    configStore.syncFromHarness(harness);
    const cfg = configStore.config;

    const instantiatedLayers = new Set(harness.thread.stack.layers.map((layer) => layer.id));
    const instantiatedAgents = new Set([...harness.thread.agents.keys()]);

    return c.json({
      layers: Object.values(cfg.layers).map((layer) => ({
        ...layer,
        instantiated: instantiatedLayers.has(layer.id),
      })),
      agents: Object.values(cfg.agents).map((agent) => ({
        ...agent,
        instantiated: instantiatedAgents.has(agent.id),
      })),
      sources: Object.values(cfg.sources),
    });
  });

  app.post("/api/actions", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (typeof body.kind !== "string") {
      return c.json({ error: "kind is required" }, 400);
    }
    if (!isActionKind(body.kind)) {
      return c.json({ error: `unknown action kind: ${body.kind}` }, 400);
    }
    for (const field of ["target", "threadId"] as const) {
      if (body[field] !== undefined && (typeof body[field] !== "string" || !body[field].trim())) {
        return c.json({ error: `${field} must be a nonempty string when supplied` }, 400);
      }
    }

    const action: OperatorAction = {
      kind: body.kind,
      target: typeof body.target === "string" ? body.target : undefined,
      threadId: typeof body.threadId === "string" ? body.threadId : undefined,
      payload: isRecord(body.payload) ? body.payload : undefined,
      operator: typeof body.operator === "string" ? body.operator : "ui",
      timestamp: typeof body.timestamp === "number" ? body.timestamp : Date.now(),
    };

    const result = await actions.execute(action);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.get("/api/actions/history", (c) => {
    return c.json(actions.history.slice(-50));
  });

  app.get("/api/settings", async (c) => {
    await configStore.load();
    configStore.syncFromHarness(harness);
    return c.json(configStore.config);
  });

  app.put("/api/settings", async (c) => {
    const body = await c.req.json<FoundryConfig>();
    await configStore.load();
    try { await configStore.save({ ...body, kingdomRuntime: configStore.config.kingdomRuntime }); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
    return c.json({ ok: true });
  });

  app.patch("/api/settings/:section", async (c) => {
    const section = c.req.param("section");
    const body = await c.req.json<Record<string, unknown>>();
    await configStore.load();
    try { return c.json(await configStore.patch(section, body)); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  app.delete("/api/settings/:section/:id", async (c) => {
    const section = c.req.param("section");
    const id = c.req.param("id");
    await configStore.load();
    const updated = await configStore.deleteItem(section, id);
    return c.json(updated);
  });

  app.post("/api/setup/complete", async (c) => {
    const config = await configStore.load();
    config.setupComplete = true;
    await configStore.save(config);
    return c.json({ ok: true });
  });

  app.post("/api/assist", async (c) => {
    if (!aiAssist) {
      return c.json({ error: "AI assist not configured. Pass assistProvider to ViewerConfig." }, 400);
    }
    const body = await c.req.json<AssistRequest>();
    await configStore.load();
    configStore.syncFromHarness(harness);
    try {
      const result = await aiAssist.analyze(configStore.config, body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: `AI assist failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  app.post("/api/assist/prompt", async (c) => {
    if (!aiAssist) {
      return c.json({ error: "AI assist not configured." }, 400);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const cfg = await configStore.load();
    const targetType = body.type === "agent" || body.type === "layer" ? body.type : "agent";
    try {
      const result = await aiAssist.improvePrompt(
        cfg,
        {
          type: targetType,
          id: typeof body.id === "string" ? body.id : "",
        },
        typeof body.currentPrompt === "string" ? body.currentPrompt : "",
        typeof body.instruction === "string" ? body.instruction : undefined,
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Prompt assist failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  app.post("/api/assist/agent-config", async (c) => {
    if (!aiAssist) {
      return c.json({ error: "AI assist not configured." }, 400);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const cfg = await configStore.load();
    try {
      const result = await aiAssist.suggestAgentConfig(
        cfg,
        typeof body.agentId === "string" ? body.agentId : "",
        typeof body.kind === "string" ? body.kind : "",
        typeof body.prompt === "string" ? body.prompt : "",
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Config assist failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  app.get("/api/analytics", (c) => {
    if (!analyticsStore || !tokenTracker) {
      return c.json({ error: "Analytics not configured. Pass tokenTracker to ViewerConfig." }, 400);
    }
    const projectId = c.req.query("project");
    const snapshot = analyticsStore.snapshot(tokenTracker);

    if (projectId && projectRegistry) {
      const project = projectRegistry.get(projectId);
      if (project) {
        return c.json({
          ...snapshot,
          projectId,
          projectThreadCount: project.threads.size,
        });
      }
    }

    return c.json(snapshot);
  });

  app.get("/api/analytics/timeseries", (c) => {
    if (!analyticsStore) return c.json({ error: "Analytics not configured." }, 400);
    const period = (c.req.query("period") ?? "hourly") as RollupPeriod;
    const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
    return c.json(analyticsStore.timeSeries(period, since));
  });

  app.get("/api/analytics/threads", (c) => {
    if (!analyticsStore) return c.json({ error: "Analytics not configured." }, 400);
    return c.json(analyticsStore.threadCosts());
  });

  app.get("/api/analytics/calls", (c) => {
    if (!analyticsStore) return c.json({ error: "Analytics not configured." }, 400);
    const field = c.req.query("field") as "provider" | "model" | "agentId" | "threadId" | undefined;
    const value = c.req.query("value");
    if (field && value) {
      return c.json(analyticsStore.callsBy(field, value));
    }
    return c.json(analyticsStore.callsBy("provider", ""));
  });

  app.get("/api/analytics/budget", (c) => {
    if (!tokenTracker) return c.json({ error: "No token tracker." }, 400);
    return c.json(tokenTracker.budgetStatus);
  });

  app.get("/api/projects", async (c) => {
    const cfg = await configStore.load();

    if (projectRegistry) {
      projectRegistry.loadFromConfigs(cfg.projects);
      return c.json({
        projects: projectRegistry.summaries(),
        tags: projectRegistry.allTags(),
      });
    }

    const projects = Object.values(cfg.projects).map((project) => ({
      ...project,
      status: "idle",
      threadCount: 0,
      activeThreadCount: 0,
      createdAt: 0,
      lastActiveAt: 0,
    }));
    const tags = [...new Set(projects.flatMap((project) => project.tags ?? []))].sort();
    return c.json({ projects, tags });
  });

  app.get("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (projectRegistry) {
      const project = projectRegistry.get(id);
      if (!project) return c.json({ error: "not found" }, 404);
      return c.json(project.summary());
    }

    const cfg = await configStore.load();
    const project = cfg.projects[id];
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(project);
  });

  app.post("/api/projects", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (typeof body.path !== "string") {
      return c.json({ error: "path is required" }, 400);
    }
    if (body.path.length > 500) {
      return c.json({ error: "path too long (max 500 chars)" }, 400);
    }

    await configStore.load();
    const cfg = configStore.config;

    // Seed project with default agents, layers, and sources based on global model defaults
    const { provider, model, classifierProvider, classifierModel } = cfg.defaults;

    const projectConfig = createProject(body.path, {
      label: typeof body.label === "string" ? body.label : undefined,
      tags: Array.isArray(body.tags)
        ? body.tags.filter((tag): tag is string => typeof tag === "string")
        : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      agents: defaultProjectAgents(provider, model, classifierProvider, classifierModel) as any,
      layers: defaultProjectLayers() as any,
      sources: defaultProjectSources(body.path),
    });

    await configStore.patch("projects", { [projectConfig.id]: projectConfig });
    if (projectRegistry && !projectRegistry.get(projectConfig.id)) {
      projectRegistry.register(fromSettingsConfig(projectConfig));
    }

    return c.json(projectConfig, 201);
  });

  app.delete("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    await configStore.load();
    await configStore.deleteItem("projects", id);
    if (projectRegistry) projectRegistry.remove(id);
    deps.threadsChanged();
    return c.json({ ok: true });
  });

  app.get("/api/projects/:id/config", async (c) => {
    const id = c.req.param("id");
    await configStore.load();
    const resolved = configStore.resolveProject(id);
    if (!resolved) return c.json({ error: "project not found" }, 404);
    return c.json(resolved);
  });

  // -- Project-scoped settings --

  app.patch("/api/projects/:id/settings/:section", async (c) => {
    const id = c.req.param("id");
    const section = c.req.param("section");
    const body = await c.req.json<Record<string, unknown>>();
    await configStore.load();
    const cfg = configStore.config;
    const current = cfg.projects[id];
    if (!current) return c.json({ error: "project not found" }, 404);
    // Mutate a copy: the live configuration changes only after the store validates the patch.
    const project = structuredClone(current);

    if (section === "sources") {
      project.sources = { ...project.sources, ...body } as Record<string, any>;
    } else if (section === "defaults") {
      project.defaults = { ...project.defaults, ...body } as any;
    } else if (section === "agents") {
      project.agents = { ...project.agents, ...body } as Record<string, any>;
    } else if (section === "layers") {
      project.layers = { ...project.layers, ...body } as Record<string, any>;
    } else {
      return c.json({ error: `unknown section: ${section}` }, 400);
    }

    try { await configStore.patch("projects", { [id]: project }); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
    return c.json({ ok: true, project });
  });

  app.get("/api/projects/:id/resolved/layers", async (c) => {
    const id = c.req.param("id");
    await configStore.load();
    const layers = configStore.inspectResolvedLayers(id);
    if (!layers) return c.json({ error: "project not found" }, 404);
    return c.json({ projectId: id, layers });
  });

  // -- Browse filesystem (for project folder + file picker) --

  app.get("/api/browse", async (c) => {
    const { readdirSync } = await import("node:fs");
    const { resolve, dirname, basename } = await import("node:path");
    const { homedir } = await import("node:os");

    const raw = c.req.query("path") || homedir();
    const includeFiles = c.req.query("files") === "1";
    const current = resolve(raw);
    const parent = dirname(current);

    try {
      const entries = readdirSync(current, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      const files = includeFiles
        ? entries
            .filter((e) => e.isFile() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
        : [];

      const allNames = new Set(entries.map((e) => e.name));
      const isRepo = allNames.has(".git") || allNames.has("package.json") || allNames.has("Cargo.toml") || allNames.has("go.mod");

      return c.json({
        current,
        parent: parent !== current ? parent : null,
        dirs,
        files,
        isRepo,
        name: basename(current),
      });
    } catch {
      return c.json({ error: "Cannot read directory", current }, 400);
    }
  });

  // -- File read/write (gated to project roots) --

  const fileAccess = protectedConfig;
  fileAccess.remember(configStore.config);
  const resolveGatedPath = async (rawPath: string): Promise<{ ok: true; abs: string } | { ok: false; error: string; status: 403 }> => {
    try { return { ok: true, abs: await fileAccess.resolve(rawPath, await configStore.load()) }; }
    catch { return { ok: false, error: "Path is outside allowed roots or contains private configuration", status: 403 }; }
  };

  app.get("/api/files", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path query required" }, 400);
    const gated = await resolveGatedPath(rawPath);
    if (!gated.ok) return c.json({ error: gated.error }, gated.status);

    const { open } = await import("node:fs/promises");
    try {
      const file = await open(gated.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
      const s = await file.stat();
      if (!s.isFile() || s.nlink !== 1) return c.json({ error: "Not a regular project file" }, 400);
      if (s.size > 2_000_000) return c.json({ error: "File too large (>2MB)" }, 400);
      const content = await file.readFile("utf8");
      return c.json({ path: resolveFilePath(rawPath.replace(/^file:\/\//, "")), content, size: s.size, mtime: s.mtimeMs });
      } finally { await file.close(); }
    } catch (err) {
      return c.json({ error: `Cannot read file: ${(err as Error).message}` }, 404);
    }
  });

  app.put("/api/files", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (typeof body.path !== "string") return c.json({ error: "path required" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "content required (string)" }, 400);
    if (body.content.length > 2_000_000) return c.json({ error: "Content too large (>2MB)" }, 400);

    const gated = await resolveGatedPath(body.path);
    if (!gated.ok) return c.json({ error: gated.error }, gated.status);

    const { open, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    try {
      await mkdir(dirname(gated.abs), { recursive: true });
      const checked = await resolveGatedPath(body.path);
      if (!checked.ok) return c.json({ error: checked.error }, checked.status);
      const file = await open(checked.abs, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1) return c.json({ error: "Not a regular project file" }, 400);
      await file.truncate(0);
      await file.writeFile(body.content, "utf8");
      const s = await file.stat();
      return c.json({ ok: true, path: resolveFilePath(body.path.replace(/^file:\/\//, "")), size: s.size, mtime: s.mtimeMs });
      } finally { await file.close(); }
    } catch (err) {
      return c.json({ error: `Cannot write file: ${(err as Error).message}` }, 500);
    }
  });

  // -- Foundry-self chat (persistent single-thread helper) --

  app.get("/api/self-chat", async (c) => {
    await selfChat.load();
    return c.json({ messages: selfChat.messages });
  });

  app.delete("/api/self-chat", async (c) => {
    await selfChat.clear();
    return c.json({ ok: true, messages: [] });
  });

  app.post("/api/self-chat", async (c) => {
    if (!aiAssist) {
      return c.json({ error: "AI assist not configured. Pass assistProvider to ViewerConfig." }, 400);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text required" }, 400);

    const focus: SelfChatFocus = isRecord(body.focus) ? {
      scope: body.focus.scope === "project" ? "project" : body.focus.scope === "global" ? "global" : undefined,
      projectId: typeof body.focus.projectId === "string" ? body.focus.projectId : undefined,
      tab: typeof body.focus.tab === "string" ? body.focus.tab : undefined,
      focusKind: typeof body.focus.focusKind === "string"
        ? (body.focus.focusKind as SelfChatFocus["focusKind"])
        : null,
      focusId: typeof body.focus.focusId === "string" ? body.focus.focusId : null,
    } : {};

    await configStore.load();
    await selfChat.load();

    const now = Date.now();
    await selfChat.append({ role: "user", content: text, ts: now, focus });

    // Resolve tool cwd: focused project's path if known, else foundry root.
    const focusedProject = focus.projectId ? configStore.config.projects?.[focus.projectId] : null;
    const toolCwd = focusedProject?.path ?? process.cwd();

    try {
      const { reply, tokens } = await aiAssist.chat(
        configStore.config,
        selfChat.messages,
        text,
        focus,
        assistTools ? { tools: assistTools, toolCwd } : undefined,
      );
      await selfChat.append({
        role: "assistant",
        content: reply,
        ts: Date.now(),
        tokens,
      });
      return c.json({ ok: true, messages: selfChat.messages });
    } catch (err) {
      const msg = `Chat failed: ${(err as Error).message}`;
      await selfChat.append({ role: "system", content: msg, ts: Date.now() });
      return c.json({ error: msg, messages: selfChat.messages }, 500);
    }
  });

  app.get("/api/prompts", (c) => {
    if (!actionQueue) return c.json({ prompts: [], count: 0 });
    const threadId = c.req.query("threadId");
    const prompts = threadId ? actionQueue.forThread(threadId) : actionQueue.pending();
    return c.json({ prompts, count: actionQueue.pendingCount(threadId) });
  });

  app.get("/api/prompts/count", (c) => {
    if (!actionQueue) return c.json({ count: 0, byThread: {} });
    const threads = new Map<string, number>();
    for (const prompt of actionQueue.pending()) {
      threads.set(prompt.threadId, (threads.get(prompt.threadId) ?? 0) + 1);
    }
    return c.json({
      count: actionQueue.pendingCount(),
      byThread: Object.fromEntries(threads),
    });
  });

  app.post("/api/prompts/:id/resolve", async (c) => {
    if (!actionQueue) return c.json({ error: "No action queue configured." }, 400);
    const id = c.req.param("id");
    const idErr = validateId(id, "prompt ID");
    if (idErr) return c.json({ error: idErr }, 400);

    const body = await c.req.json<Record<string, unknown>>();
    if (typeof body.action !== "string") {
      return c.json({ error: "action is required" }, 400);
    }

    const ok = actionQueue.resolve(id, body.action, {
      by: "human",
      input: typeof body.input === "string" ? body.input : undefined,
    });
    if (!ok) return c.json({ error: "Prompt not found or already resolved." }, 404);

    return c.json({ ok: true, promptId: id, action: body.action });
  });

  // -- Tunnel management --

  app.get("/api/tunnel", async (c) => {
    const cfg = await configStore.load();
    const tunnel = tunnelHolder.tunnel;
    const info = tunnel?.info ?? null;
    return c.json({
      active: !!info,
      url: info?.url ?? null,
      provider: info?.provider ?? cfg.tunnel?.provider ?? "localtunnel",
      enabled: cfg.tunnel?.enabled ?? false,
      subdomain: cfg.tunnel?.subdomain ?? null,
    });
  });

  let changingTunnel = false;
  app.post("/api/tunnel/start", async (c) => {
    if (changingTunnel) return c.json({ error: "Tunnel operation in progress" }, 409);
    changingTunnel = true;
    try {
      if (tunnelHolder.tunnel?.info) return c.json({ error: "Tunnel already running" }, 409);
      const cfg = await configStore.load();
      const tunnelCfg = cfg.tunnel ?? { enabled: true };
      const tunnel = tunnelHolder.tunnel ?? new FoundryTunnel({
        configDir: deps.selfChatDir, port, provider: tunnelCfg.provider ?? "localtunnel", subdomain: tunnelCfg.subdomain,
      });
      tunnelHolder.tunnel = tunnel;
      c.header("Cache-Control", "no-store");
      const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
      c.header("Set-Cookie", `${SESSION_COOKIE}=${sessionValue(tunnel.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`);
      try {
        await tunnel.start();
        cfg.tunnel = { ...tunnelCfg, enabled: true };
        await configStore.save(cfg);
        return c.json({ active: true, url: tunnel.info!.url });
      } catch {
        await tunnel.stop();
        return c.json({ error: "Tunnel could not start" }, 500);
      }
    } finally { changingTunnel = false; }
  });

  app.post("/api/tunnel/stop", async (c) => {
    if (changingTunnel) return c.json({ error: "Tunnel operation in progress" }, 409);
    changingTunnel = true;
    try {
      const tunnel = tunnelHolder.tunnel;
      if (!tunnel) return c.json({ error: "No tunnel running" }, 400);
      await tunnel.stop();
      const cfg = await configStore.load();
      if (cfg.tunnel) { cfg.tunnel.enabled = false; await configStore.save(cfg); }
      return c.json({ active: false });
    } finally { changingTunnel = false; }
  });

  app.patch("/api/tunnel", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const cfg = await configStore.load();
    const current = cfg.tunnel ?? { enabled: false };

    if ("password" in body) return c.json({ error: "Use the private tunnel-token file for credentials" }, 400);
    if (body.provider !== undefined && !["localtunnel", "cloudflared"].includes(String(body.provider)))
      return c.json({ error: "Unknown tunnel provider" }, 400);
    if (body.provider === "localtunnel" || body.provider === "cloudflared") current.provider = body.provider;
    if (typeof body.subdomain === "string") current.subdomain = body.subdomain || undefined;

    cfg.tunnel = current;
    await configStore.save(cfg);
    return c.json({ ok: true, tunnel: current });
  });

  // -- MCP server management --

  app.get("/api/mcp", async (c) => {
    const cfg = await configStore.load();
    const mcp = cfg.mcp ?? { enabled: false };
    return c.json({
      enabled: mcp.enabled,
      transport: mcp.transport ?? "stdio",
      installedProjects: mcp.installedProjects ?? {},
    });
  });

  app.post("/api/mcp/enable", async (c) => {
    const cfg = await configStore.load();
    cfg.mcp = { ...cfg.mcp, enabled: true, transport: cfg.mcp?.transport ?? "stdio" };
    await configStore.save(cfg);
    return c.json({ ok: true, mcp: cfg.mcp });
  });

  app.post("/api/mcp/disable", async (c) => {
    const cfg = await configStore.load();
    if (cfg.mcp) cfg.mcp.enabled = false;
    await configStore.save(cfg);
    return c.json({ ok: true });
  });

  app.patch("/api/mcp", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const cfg = await configStore.load();
    const current: McpSettingsConfig = cfg.mcp ?? { enabled: false };

    if (typeof body.transport === "string") current.transport = body.transport as "stdio" | "sse";
    if (typeof body.enabled === "boolean") current.enabled = body.enabled;

    cfg.mcp = current;
    await configStore.save(cfg);
    return c.json({ ok: true, mcp: current });
  });

  /**
   * Install MCP for a project — writes .mcp.json to the project directory
   * so Claude Code auto-discovers the Foundry MCP server.
   */
  app.post("/api/mcp/install/:projectId", async (c) => {
    const { existsSync, writeFileSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");

    const projectId = c.req.param("projectId");
    const cfg = await configStore.load();
    const project = cfg.projects[projectId];
    if (!project) return c.json({ error: "Project not found" }, 404);

    const projectPath = resolve(project.path);
    if (!existsSync(projectPath)) {
      return c.json({ error: `Project path does not exist: ${projectPath}` }, 400);
    }

    // Build the .mcp.json content for Claude Code
    const mcpCliPath = resolve("packages/foundry/src/mcp/cli.ts");
    const mcpJson = {
      mcpServers: {
        foundry: {
          command: "bun",
          args: ["run", mcpCliPath],
          cwd: projectPath,
        },
      },
    };

    const mcpJsonPath = join(projectPath, ".mcp.json");
    writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));

    // Track installation in config
    cfg.mcp = cfg.mcp ?? { enabled: true };
    cfg.mcp.enabled = true;
    cfg.mcp.installedProjects = cfg.mcp.installedProjects ?? {};
    cfg.mcp.installedProjects[projectId] = mcpJsonPath;
    await configStore.save(cfg);

    return c.json({
      ok: true,
      projectId,
      mcpJsonPath,
      mcpJson,
    });
  });

  /** Uninstall MCP from a project — removes .mcp.json. */
  app.delete("/api/mcp/install/:projectId", async (c) => {
    const { existsSync, unlinkSync } = await import("node:fs");

    const projectId = c.req.param("projectId");
    const cfg = await configStore.load();
    const installed = cfg.mcp?.installedProjects?.[projectId];

    if (installed && existsSync(installed)) {
      unlinkSync(installed);
    }

    if (cfg.mcp?.installedProjects) {
      delete cfg.mcp.installedProjects[projectId];
      await configStore.save(cfg);
    }

    return c.json({ ok: true, projectId });
  });
}
