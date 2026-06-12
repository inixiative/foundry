import type { LLMMessage, LLMProvider, ToolRegistry } from "@inixiative/foundry-core";
import type { FoundryConfig, AgentSettingsConfig, LayerSettingsConfig } from "./config";
import type { SelfChatFocus, SelfChatMessage } from "./foundry-self-chat";
import { toolUseLoop } from "../agents/tool-loop";

// ---------------------------------------------------------------------------
// AI Assist — uses LLM to suggest configuration improvements
// ---------------------------------------------------------------------------

export interface AISuggestion {
  readonly id: string;
  readonly section: "agents" | "layers" | "prompts" | "providers";
  readonly target: string;
  readonly kind: "improve" | "add" | "remove" | "warning";
  readonly title: string;
  readonly description: string;
  /** The suggested change as a partial config patch. */
  readonly patch?: Record<string, unknown>;
  readonly confidence: number;
}

export interface AssistRequest {
  /** What section to get help with. */
  section: "agents" | "layers" | "prompts" | "all";
  /** Optional specific item to focus on. */
  target?: string;
  /** Free-form question or request. */
  question?: string;
}

export interface AssistResponse {
  suggestions: AISuggestion[];
  explanation: string;
}

/**
 * AIAssist — uses an LLM provider to analyze the current config
 * and suggest improvements, spot issues, and help write prompts.
 */
export class AIAssist {
  private _provider: LLMProvider;
  private _model?: string;

  constructor(provider: LLMProvider, model?: string) {
    this._provider = provider;
    this._model = model;
  }

  /**
   * Analyze the current config and produce suggestions.
   */
  async analyze(config: FoundryConfig, request: AssistRequest): Promise<AssistResponse> {
    const systemPrompt = this._buildSystemPrompt();
    const userPrompt = this._buildUserPrompt(config, request);

    const completion = await this._provider.complete(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        model: this._model,
        maxTokens: 2048,
        temperature: 0.3,
      }
    );

    return this._parseResponse(completion.content, request.section);
  }

  /**
   * Generate or improve a prompt for an agent or layer.
   */
  async improvePrompt(
    config: FoundryConfig,
    target: { type: "agent" | "layer"; id: string },
    currentPrompt: string,
    instruction?: string
  ): Promise<{ improved: string; explanation: string }> {
    const context = this._describeConfig(config);

    const userMsg = [
      `I need help with a ${target.type} prompt.`,
      `${target.type === "agent" ? "Agent" : "Layer"} ID: ${target.id}`,
      "",
      "Current prompt:",
      "```",
      currentPrompt || "(empty)",
      "```",
      "",
      instruction ? `User request: ${instruction}` : "Please improve this prompt for clarity, specificity, and effectiveness.",
      "",
      "System context:",
      context,
      "",
      "Respond with ONLY the improved prompt text, no explanation. Then on a new line after '---', add a brief explanation of what you changed.",
    ].join("\n");

    const completion = await this._provider.complete(
      [
        { role: "system", content: "You are an expert AI prompt engineer. You write clear, specific prompts for AI agent systems. Keep prompts concise but thorough." },
        { role: "user", content: userMsg },
      ],
      {
        model: this._model,
        maxTokens: 1024,
        temperature: 0.2,
      }
    );

    const parts = completion.content.split("---");
    return {
      improved: parts[0].trim(),
      explanation: parts[1]?.trim() ?? "Prompt improved.",
    };
  }

  /**
   * Suggest a model/temperature configuration for an agent based on its role.
   */
  async suggestAgentConfig(
    config: FoundryConfig,
    agentId: string,
    agentKind: string,
    prompt: string
  ): Promise<Partial<AgentSettingsConfig>> {
    const availableModels = Object.values(config.providers)
      .filter(p => p.enabled)
      .flatMap(p => p.models.map(m => ({
        provider: p.id,
        model: m.id,
        tier: m.tier,
        cost: m.costTier,
      })));

    const userMsg = [
      `Suggest the optimal LLM configuration for this agent:`,
      `- Agent ID: ${agentId}`,
      `- Kind: ${agentKind}`,
      `- Prompt: "${prompt.slice(0, 200)}"`,
      "",
      "Available models:",
      JSON.stringify(availableModels, null, 2),
      "",
      "Respond in JSON format:",
      '{ "provider": "...", "model": "...", "temperature": 0.0, "reasoning": "..." }',
      "",
      "Consider: classifiers/routers need fast cheap models. Executors need powerful ones. Temperature 0 for deterministic, 0.3-0.7 for creative.",
    ].join("\n");

    const completion = await this._provider.complete(
      [
        { role: "system", content: "You are an AI systems architect. Suggest optimal model configurations. Respond only in JSON." },
        { role: "user", content: userMsg },
      ],
      {
        model: this._model,
        maxTokens: 256,
        temperature: 0,
      }
    );

    try {
      const json = this._extractJSON(completion.content);
      return {
        provider: json.provider,
        model: json.model,
        temperature: typeof json.temperature === "number" ? json.temperature : 0,
      };
    } catch {
      return {};
    }
  }

  // -- Internal --

  private _buildSystemPrompt(): string {
    return [
      "You are an AI systems architect analyzing an agent infrastructure configuration.",
      "The system has: providers (LLM APIs), agents (each with a model/prompt/role),",
      "layers (context), and data sources (memory backends).",
      "",
      "Analyze the configuration and suggest improvements. Focus on:",
      "1. Model selection: are agents using appropriate models for their roles?",
      "2. Prompts: are they clear, specific, and non-redundant?",
      "3. Architecture: are there missing agents or layers that would improve the system?",
      "4. Cost: can cheaper models be used for simple tasks without quality loss?",
      "",
      "Respond in JSON format:",
      '{ "suggestions": [{ "section": "agents"|"layers"|"prompts"|"providers",',
      '  "target": "<id>", "kind": "improve"|"add"|"remove"|"warning",',
      '  "title": "<short>", "description": "<detail>", "confidence": 0.0-1.0,',
      '  "patch": {<optional partial config>} }],',
      '  "explanation": "<summary>" }',
    ].join("\n");
  }

  private _buildUserPrompt(config: FoundryConfig, request: AssistRequest): string {
    const parts = ["Current configuration:", JSON.stringify(config, null, 2)];

    if (request.question) {
      parts.push("", `User question: ${request.question}`);
    }

    if (request.section !== "all") {
      parts.push("", `Focus on the "${request.section}" section.`);
    }

    if (request.target) {
      parts.push(`Specifically look at: ${request.target}`);
    }

    return parts.join("\n");
  }

  private _describeConfig(config: FoundryConfig): string {
    const agentCount = Object.keys(config.agents).length;
    const layerCount = Object.keys(config.layers).length;
    const providerCount = Object.values(config.providers).filter(p => p.enabled).length;

    return [
      `System has ${agentCount} agents, ${layerCount} layers, ${providerCount} active providers.`,
      `Default model: ${config.defaults.provider}/${config.defaults.model}`,
      agentCount > 0 ? `Agents: ${Object.keys(config.agents).join(", ")}` : "",
      layerCount > 0 ? `Layers: ${Object.keys(config.layers).join(", ")}` : "",
    ].filter(Boolean).join("\n");
  }

  private _parseResponse(content: string, section: string): AssistResponse {
    try {
      const json = this._extractJSON(content);
      return {
        suggestions: (json.suggestions || []).map((s: any, i: number) => ({
          id: `suggestion-${i}`,
          section: s.section || section,
          target: s.target || "",
          kind: s.kind || "improve",
          title: s.title || "Suggestion",
          description: s.description || "",
          patch: s.patch,
          confidence: typeof s.confidence === "number" ? Math.min(1, Math.max(0, s.confidence)) : 0.5,
        })),
        explanation: json.explanation || "Analysis complete.",
      };
    } catch {
      return {
        suggestions: [],
        explanation: content.slice(0, 500),
      };
    }
  }

  /**
   * Conversational chat — a persistent single-thread helper focused on
   * customizing Foundry itself. Sees the current view context ("focus")
   * so the user doesn't have to re-state where they are on every turn.
   *
   * When `tools` is provided, runs through `toolUseLoop` so the assistant
   * has the same tool surface as the executor agent (bash, scripts, memory, etc).
   */
  async chat(
    config: FoundryConfig,
    history: SelfChatMessage[],
    userText: string,
    focus: SelfChatFocus,
    opts?: {
      tools?: ToolRegistry;
      toolCwd?: string;
      onToolCall?: (name: string, input: Record<string, unknown>, result: string) => void;
    },
  ): Promise<{ reply: string; tokens?: { input: number; output: number } }> {
    const systemPrompt = this._buildSelfChatSystemPrompt(config, focus, !!opts?.tools);
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: this._framedUserMessage(userText, focus) },
    ];

    const completionOpts = {
      model: this._model,
      maxTokens: 4096,
      temperature: 0.4,
    };

    const completion = opts?.tools
      ? await toolUseLoop(this._provider, messages, opts.tools, {
          ...completionOpts,
          toolCwd: opts.toolCwd,
          maxIterations: 10,
          onToolCall: opts.onToolCall,
        })
      : await this._provider.complete(messages, completionOpts);

    return {
      reply: completion.content,
      tokens: completion.tokens,
    };
  }

  private _framedUserMessage(userText: string, focus: SelfChatFocus): string {
    const where = [
      focus.scope ? `scope=${focus.scope}` : null,
      focus.projectId ? `project=${focus.projectId}` : null,
      focus.tab ? `tab=${focus.tab}` : null,
      focus.focusKind && focus.focusId ? `focus=${focus.focusKind}:${focus.focusId}` : null,
    ].filter(Boolean).join(" ");
    const header = where ? `[viewing: ${where}]\n\n` : "";
    return `${header}${userText}`;
  }

  private _buildSelfChatSystemPrompt(config: FoundryConfig, focus: SelfChatFocus, hasTools: boolean): string {
    const project = focus.projectId ? config.projects?.[focus.projectId] : null;
    const focusDetail = this._focusDetail(config, focus);

    const toolsLine = hasTools
      ? "You have the same tool surface as the executor agent — you can run shell commands, read files, search memory, and execute scripts to investigate and propose edits."
      : "You see the full Foundry repo (read-only in this chat — you propose edits, the operator applies them from the UI).";

    return [
      "You are the Foundry self-help assistant — a conversational helper embedded in the Foundry viewer's settings panel.",
      "You help the operator customize and understand their own Foundry install.",
      "",
      toolsLine,
      "Be concrete: name files, name keys, show JSON patch snippets when suggesting config edits.",
      "Be concise — the chat pane is narrow. Prefer short paragraphs and small code blocks.",
      "",
      `Default executor: ${config.defaults.provider}/${config.defaults.model}`,
      `Classifier: ${config.defaults.classifierProvider ?? config.defaults.provider}/${config.defaults.classifierModel ?? config.defaults.model}`,
      `Agents (${Object.keys(config.agents).length}): ${Object.keys(config.agents).join(", ") || "none"}`,
      `Layers (${Object.keys(config.layers).length}): ${Object.keys(config.layers).join(", ") || "none"}`,
      `Projects (${Object.keys(config.projects ?? {}).length}): ${Object.keys(config.projects ?? {}).join(", ") || "none"}`,
      "",
      project ? `Active project: ${project.label ?? project.id} (${project.path})` : "",
      focusDetail ? `Operator is currently looking at:\n${focusDetail}` : "",
    ].filter(Boolean).join("\n");
  }

  private _focusDetail(config: FoundryConfig, focus: SelfChatFocus): string {
    if (!focus.focusKind || !focus.focusId) return "";
    const { focusKind, focusId } = focus;
    const project = focus.projectId ? config.projects?.[focus.projectId] : null;

    let target: unknown;
    if (focusKind === "source") {
      target = project?.sources?.[focusId] ?? config.sources?.[focusId];
    } else if (focusKind === "agent") {
      target = project?.agents?.[focusId] ?? config.agents?.[focusId];
    } else if (focusKind === "layer") {
      target = project?.layers?.[focusId] ?? config.layers?.[focusId];
    } else if (focusKind === "provider") {
      target = config.providers?.[focusId];
    }
    if (!target) return `(${focusKind}:${focusId} — not found in config)`;
    return "```json\n" + JSON.stringify(target, null, 2) + "\n```";
  }

  private _extractJSON(content: string): any {
    // Try direct parse first
    try { return JSON.parse(content); } catch {}
    // Try extracting from code block
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1]); } catch {}
    }
    // Try finding JSON object in text
    const braceMatch = content.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      return JSON.parse(braceMatch[0]);
    }
    throw new Error("No JSON found in response");
  }
}
