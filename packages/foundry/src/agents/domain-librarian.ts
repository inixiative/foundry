// ---------------------------------------------------------------------------
// Domain Librarian — the shared pattern for all domain sub-agents (FLOW.md)
//
// Each domain librarian:
// 1. Maintains a warm cache for its domain (a ContextLayer)
// 2. Advises on incoming messages ("what context from my domain?")
// 3. Guards after tool calls ("did this violate anything in my domain?")
// 4. Emits signals to the Librarian for reconciliation
//
// The Librarian coordinates domain librarians — trigger-gating which guards
// fire and reconciling all their signals into the thread-state layer.
//
// This is the base class. Concrete domains (docs, convention, security,
// architecture, memory) subclass or instantiate with domain-specific config.
// ---------------------------------------------------------------------------

import {
  ContextLayer,
  type Signal,
  type SignalBus,
  type LLMProvider,
  type LLMMessage,
  type CompletionOpts,
} from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the domain librarian advises: context slices to inject. */
export interface AdviseResult {
  /** Layer IDs to hydrate and inject. */
  layers: string[];
  /** Optional text snippets to include directly (small enough to inline). */
  snippets: string[];
  /** Confidence in the recommendation (0-1). Low confidence = might be wrong. */
  confidence: number;
}

/** What the domain librarian finds during guard check. */
export interface GuardFinding {
  /** Severity: critical findings push to session immediately, advisory are deferred. */
  severity: "critical" | "advisory";
  /** Human-readable description of the finding. */
  description: string;
  /** Which file/line/tool the finding relates to. */
  location?: string;
  /** Suggested fix, if any. */
  suggestion?: string;
}

/** A tool call observation that guards evaluate. */
export interface ToolObservation {
  /** Tool name (e.g., "file_write", "bash", "file_read"). */
  tool: string;
  /** Tool input (file_path, command, etc.). */
  input: Record<string, unknown>;
  /** Tool output (truncated if large). */
  output?: string;
  /** Files affected by this tool call. */
  filesAffected?: string[];
}

/** Guard result: either findings or all-clear. */
export interface GuardResult {
  /** Empty array = all clear. */
  findings: GuardFinding[];
  /** Whether the guard actually ran (false if trigger-gated out). */
  ran: boolean;
}

/**
 * How a compiled rule was produced and when to recompile it.
 *
 * Every "programmatic" and "cached" strategy has a compiler behind it —
 * an LLM action that generates the deterministic artifact. The convention
 * regex, the tag alias map, the doc summary — all LLM outputs that then
 * run without LLM calls at request time.
 *
 * The compiler metadata lets the system know:
 *   - When to recompile (signal-driven, not time-driven)
 *   - What prompt produced the current rules (reproducibility)
 *   - How stale the compiled output is
 */
export interface RuleCompiler {
  /** Signal kinds that trigger recompilation (e.g., "correction", "convention"). */
  recompileOn: string[];
  /** Prompt template used to generate the rule. The warm cache is injected as context. */
  compilePrompt: string;
  /** When the current rule was last compiled. */
  lastCompiled: number;
  /**
   * How many triggering signals accumulate before recompilation fires.
   * Default: 1 (recompile on every trigger). Higher values batch.
   * Example: convention guard recompiles after 3 corrections, not every one.
   */
  threshold?: number;
  /** Counter of accumulated triggers since last compile. */
  pendingTriggers?: number;
}

/**
 * Processing strategy — how a domain librarian resolves its advise/guard calls.
 *
 * Two dimensions:
 *   1. EXECUTION — how it runs at request time (programmatic / cached / live)
 *   2. COMPILATION — how the rules get written (LLM action, expressed by RuleCompiler)
 *
 * The lifecycle:
 *   live → system accumulates signals → LLM compiles rules → cached/programmatic
 *   → more signals → LLM recompiles → updated rules
 *
 * "Programmatic" doesn't mean "no LLM" — it means the LLM ran at compile time,
 * not at request time. The compile step IS the LLM action.
 */
export type ProcessingStrategy =
  | {
      kind: "programmatic";
      fn: (input: string, cache: string) => string;
      /** How the function was compiled. Null = hand-written, never recompiled. */
      compiler: RuleCompiler | null;
    }
  | {
      kind: "cached";
      ttl: number;
      invalidateOn: string[];
      /** How the cache content was compiled. */
      compiler: RuleCompiler | null;
    }
  | {
      kind: "live";
      budget: number;
    };

/** Configuration for a domain librarian instance. */
export interface DomainLibrarianConfig {
  /** Domain identifier (e.g., "docs", "convention", "security"). */
  domain: string;
  /** The warm cache layer for this domain. */
  cache: ContextLayer;
  /** Signal bus to emit findings and observations into. */
  signals: SignalBus;
  /** Fast LLM for advise/guard decisions. */
  llm: LLMProvider;
  /** LLM options (should use cheap/fast model). */
  llmOpts?: CompletionOpts;
  /** Tool call types that trigger this domain's guard. Empty = never guard. */
  guardTriggers?: string[];
  /** System prompt for advise mode. */
  advisePrompt?: string;
  /** System prompt for guard mode. */
  guardPrompt?: string;
  /** Processing strategy for advise calls. Default: live (LLM every time). */
  adviseStrategy?: ProcessingStrategy;
  /** Processing strategy for guard calls. Default: live (LLM every time). */
  guardStrategy?: ProcessingStrategy;
  /** If true, guard uses programmatic matching instead of LLM (like Memory domain). */
  programmaticGuard?: boolean;
  /**
   * Programmatic guard function. Called instead of LLM when programmaticGuard=true.
   * Return findings directly — no LLM call needed.
   */
  guardFn?: (observation: ToolObservation, cache: string) => GuardFinding[];
}

// ---------------------------------------------------------------------------
// Domain Librarian
// ---------------------------------------------------------------------------

export class DomainLibrarian {
  readonly domain: string;
  private _cache: ContextLayer;
  private _signals: SignalBus;
  private _llm: LLMProvider;
  private _llmOpts: CompletionOpts;
  private _guardTriggers: Set<string>;
  private _advisePrompt: string;
  private _guardPrompt: string;
  private _programmaticGuard: boolean;
  private _guardFn?: (obs: ToolObservation, cache: string) => GuardFinding[];
  private _adviseStrategy: ProcessingStrategy;
  private _guardStrategy: ProcessingStrategy;

  constructor(config: DomainLibrarianConfig) {
    this.domain = config.domain;
    this._cache = config.cache;
    this._signals = config.signals;
    this._llm = config.llm;
    this._llmOpts = config.llmOpts ?? { maxTokens: 512, temperature: 0 };
    this._guardTriggers = new Set(config.guardTriggers ?? []);
    this._programmaticGuard = config.programmaticGuard ?? false;
    this._guardFn = config.guardFn;

    // Default strategies: live LLM unless programmatic guard is set
    this._adviseStrategy = config.adviseStrategy ?? { kind: "live", budget: 512 };
    this._guardStrategy = config.guardStrategy ??
      (config.programmaticGuard
        ? { kind: "programmatic", fn: () => "", compiler: null }
        : { kind: "live", budget: 512 });

    this._advisePrompt = config.advisePrompt ??
      `You are a ${config.domain} domain advisor. Given a user message and your domain's warm cache, decide what context from your domain the message needs. Respond with JSON: { "layers": string[], "snippets": string[], "confidence": number }`;

    this._guardPrompt = config.guardPrompt ??
      `You are a ${config.domain} domain guard. Given a tool call observation and your domain's warm cache, check if the action violates any rules in your domain. Respond with JSON: { "findings": [{ "severity": "critical"|"advisory", "description": string, "location"?: string, "suggestion"?: string }] }`;
  }

  /** The underlying warm cache layer. */
  get cache(): ContextLayer {
    return this._cache;
  }

  /** Processing strategy for advise calls. */
  get adviseStrategy(): ProcessingStrategy {
    return this._adviseStrategy;
  }

  /** Processing strategy for guard calls. */
  get guardStrategy(): ProcessingStrategy {
    return this._guardStrategy;
  }

  /** Whether this domain's guard should fire for a given tool type. */
  shouldGuard(toolType: string): boolean {
    // Programmatic guards run on everything (free)
    if (this._programmaticGuard) return true;
    return this._guardTriggers.has(toolType);
  }

  // -----------------------------------------------------------------------
  // Advise mode — pre-message context injection
  // -----------------------------------------------------------------------

  /**
   * Advise what context from this domain the message needs.
   * Returns layer IDs to hydrate and optional inline snippets.
   */
  async advise(message: string, threadState?: string): Promise<AdviseResult> {
    const cacheContent = this._cache.content;
    if (!cacheContent) {
      return { layers: [], snippets: [], confidence: 0 };
    }

    const messages: LLMMessage[] = [
      { role: "system", content: this._advisePrompt },
      {
        role: "user",
        content: [
          `## Domain cache (${this.domain})`,
          cacheContent,
          threadState ? `\n## Thread state\n${threadState}` : "",
          `\n## Message\n${message}`,
          `\nRespond with JSON only.`,
        ].join("\n"),
      },
    ];

    try {
      const result = await this._llm.complete(messages, this._llmOpts);
      const parsed = parseJSON<AdviseResult>(result.content);
      return {
        layers: parsed.layers ?? [],
        snippets: parsed.snippets ?? [],
        confidence: parsed.confidence ?? 0.5,
      };
    } catch {
      // LLM failure → degrade gracefully, advise nothing
      return { layers: [], snippets: [], confidence: 0 };
    }
  }

  // -----------------------------------------------------------------------
  // Guard mode — post-action correctness checking
  // -----------------------------------------------------------------------

  /**
   * Guard against a tool call observation.
   * Returns findings (critical or advisory) or empty array for all-clear.
   */
  async guard(observation: ToolObservation, threadState?: string): Promise<GuardResult> {
    // Check trigger gate
    if (!this.shouldGuard(observation.tool)) {
      return { findings: [], ran: false };
    }

    // Programmatic guard — no LLM call
    if (this._programmaticGuard && this._guardFn) {
      const findings = this._guardFn(observation, this._cache.content);
      await this._emitFindings(findings, observation);
      return { findings, ran: true };
    }

    // LLM-based guard
    const cacheContent = this._cache.content;
    if (!cacheContent) {
      return { findings: [], ran: true };
    }

    const messages: LLMMessage[] = [
      { role: "system", content: this._guardPrompt },
      {
        role: "user",
        content: [
          `## Domain cache (${this.domain})`,
          cacheContent,
          threadState ? `\n## Thread state\n${threadState}` : "",
          `\n## Tool observation`,
          `Tool: ${observation.tool}`,
          `Input: ${JSON.stringify(observation.input)}`,
          observation.output ? `Output (truncated): ${observation.output.slice(0, 2000)}` : "",
          observation.filesAffected?.length ? `Files affected: ${observation.filesAffected.join(", ")}` : "",
          `\nRespond with JSON only.`,
        ].join("\n"),
      },
    ];

    try {
      const result = await this._llm.complete(messages, this._llmOpts);
      const parsed = parseJSON<{ findings: GuardFinding[] }>(result.content);
      const findings = parsed.findings ?? [];
      await this._emitFindings(findings, observation);
      return { findings, ran: true };
    } catch {
      return { findings: [], ran: true };
    }
  }

  // -----------------------------------------------------------------------
  // Signal emission
  // -----------------------------------------------------------------------

  private async _emitFindings(findings: GuardFinding[], observation: ToolObservation): Promise<void> {
    for (const finding of findings) {
      const kind = finding.severity === "critical" ? "security_concern" : "correction";
      await this._signals.emit({
        id: `${this.domain}-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind,
        source: `${this.domain}-librarian`,
        content: {
          domain: this.domain,
          severity: finding.severity,
          description: finding.description,
          location: finding.location,
          suggestion: finding.suggestion,
          tool: observation.tool,
        },
        timestamp: Date.now(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// JSON parsing helper — extracts JSON from LLM responses that may include
// markdown code fences or extra text
// ---------------------------------------------------------------------------

function parseJSON<T>(text: string): T {
  // Try raw parse first
  try {
    return JSON.parse(text);
  } catch {
    // Extract from code fence
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) {
      return JSON.parse(match[1]);
    }
    // Try to find a JSON object in the text
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      return JSON.parse(braceMatch[0]);
    }
    throw new Error(`Could not parse JSON from LLM response: ${text.slice(0, 200)}`);
  }
}
