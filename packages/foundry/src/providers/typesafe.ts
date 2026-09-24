import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { CapabilityGate, GateContext } from "@inixiative/foundry-core";

export type TypeSafeValue = string | number | boolean | null | TypeSafeValue[] | { [key: string]: TypeSafeValue };
export type TypeSafeContent = string | TypeSafeValue[] | { [key: string]: TypeSafeValue };
export type TypeSafeQuestion =
  | { type: "choice"; instructions: TypeSafeContent; criteria: Record<string, TypeSafeContent | null> }
  | { type: "score"; instructions: TypeSafeContent; criteria: TypeSafeContent[] }
  | { type: "noul"; instructions: TypeSafeContent; criteria?: { true?: TypeSafeContent; false?: TypeSafeContent } };
export type TypeSafeQuestions = Record<string, TypeSafeQuestion>;
export type TypeSafeAnswer<Q extends TypeSafeQuestion> =
  Q extends { type: "choice"; criteria: infer C } ? { type: "choice"; choice: keyof C & string; probabilities: Record<keyof C & string, number>; confidence: number }
  : Q extends { type: "score" } ? { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  : { type: "noul"; noul: number };
export interface TypeSafeResult<Q extends TypeSafeQuestions> {
  model: string;
  answers: { [K in keyof Q]: TypeSafeAnswer<Q[K]> };
  usage: { input_tokens: number; output_tokens: number };
}

const content = z.union([z.string(), z.array(z.json()), z.record(z.string(), z.json())]);
const question = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), instructions: content, criteria: z.record(z.string(), content.nullable()).refine(c => Object.keys(c).length >= 1 && Object.keys(c).length <= 255) }),
  z.object({ type: z.literal("score"), instructions: content, criteria: z.array(content).min(2).max(10) }),
  z.object({ type: z.literal("noul"), instructions: content, criteria: z.object({ true: content.optional(), false: content.optional() }).optional() }),
]);
const requestSchema = z.object({ state: content, model: z.string().min(1), questions: z.record(z.string(), question).refine(q => Object.keys(q).length > 0) });
const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.discriminatedUnion("type", [
    z.object({ type: z.literal("choice"), choice: z.string(), probabilities, confidence: probability }),
    z.object({ type: z.literal("score"), score: z.number().nonnegative(), legend: z.record(z.string(), z.string()), probabilities, confidence: probability }),
    z.object({ type: z.literal("noul"), noul: probability }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

export class TypeSafeError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "TypeSafeError"; }
}

export interface TypeSafeClientOptions {
  gate: CapabilityGate;
  /** Name of an environment variable, never the secret itself. */
  apiKeyEnv?: string;
  model?: string;
  /** Deadline covers fetch, response parsing, and retries. Default 10 seconds. */
  timeoutMs?: number;
  /** Retries only 429/529, at most 3. Default 2. */
  maxRetries?: number;
  /** Injectable for isolated tests. */
  environment?: Record<string, string | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Typed decisions, separate from chat completions and native coding sessions. */
export class TypeSafeDecisionClient {
  readonly id = "typesafe-decisions";
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  constructor(private readonly options: TypeSafeClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new TypeSafeError("TypeSafe timeoutMs must be a positive integer");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 3) throw new TypeSafeError("TypeSafe maxRetries must be an integer from 0 to 3");
  }

  async evaluate<const Q extends TypeSafeQuestions>(
    state: TypeSafeContent,
    questions: Q,
    context: GateContext,
    signal?: AbortSignal,
  ): Promise<TypeSafeResult<Q>> {
    const parsedRequest = requestSchema.safeParse({ state, questions, model: this.options.model ?? "jev-latest" });
    if (!parsedRequest.success) throw new TypeSafeError("Invalid TypeSafe decision request");
    const keyName = this.options.apiKeyEnv ?? "TYPESAFE_API_KEY";
    const key = (this.options.environment ?? process.env)[keyName]?.trim();
    if (!key) throw new TypeSafeError(`TypeSafe requires environment variable ${keyName}`);
    await this.options.gate.require("net:api", context);
    await this.options.gate.require("llm:call", context);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const requestBody = JSON.stringify(parsedRequest.data);
    const send = this.options.fetch ?? globalThis.fetch;
    try {
      for (let attempt = 0; ; attempt++) {
        activeSignal.throwIfAborted();
        const response = await send("https://api.typesafe.ai/v1/systemone", {
          method: "POST", redirect: "error", signal: activeSignal,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: requestBody,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (![429, 529].includes(response.status) || attempt >= this.maxRetries) throw new TypeSafeError(`TypeSafe request failed (HTTP ${response.status})`, response.status);
          const retryHeader = response.headers.get("retry-after");
          const seconds = retryHeader == null ? NaN : Number(retryHeader);
          const retryMs = Number.isFinite(seconds) ? seconds * 1000 : retryHeader ? Date.parse(retryHeader) - Date.now() : NaN;
          await sleep(Math.max(250 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0), undefined, { signal: activeSignal });
          continue;
        }
        const parsed = responseSchema.safeParse(await response.json());
        if (!parsed.success) throw new TypeSafeError("Invalid TypeSafe decision response");
        const result = parsed.data;
        if (Object.keys(result.answers).length !== Object.keys(questions).length) throw new TypeSafeError("TypeSafe answer IDs do not match the request");
        for (const [id, q] of Object.entries(questions)) {
          const answer = result.answers[id];
          if (!answer || answer.type !== q.type) throw new TypeSafeError("TypeSafe answer types do not match the request");
          if (answer.type === "noul") continue;
          const expected = q.type === "choice" ? Object.keys(q.criteria) : (q as Extract<TypeSafeQuestion, { type: "score" }>).criteria.map((_, i) => String(i));
          if (Object.keys(answer.probabilities).length !== expected.length || expected.some(k => !(k in answer.probabilities)) || Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.01) throw new TypeSafeError("Invalid TypeSafe probability distribution");
          if (answer.type === "choice" && !expected.includes(answer.choice)) throw new TypeSafeError("TypeSafe selected an unknown choice");
          if (answer.type === "score" && (answer.score > expected.length - 1 || Object.keys(answer.legend).length !== expected.length || expected.some(k => !(k in answer.legend)))) throw new TypeSafeError("Invalid TypeSafe score or legend");
        }
        return result as TypeSafeResult<Q>;
      }
    } catch (error) {
      if (error instanceof TypeSafeError) throw error;
      // Provider bodies and transport errors can contain request data or secrets.
      throw new TypeSafeError(activeSignal.aborted ? "TypeSafe decision cancelled or timed out" : "TypeSafe decision transport failed");
    }
  }
}
