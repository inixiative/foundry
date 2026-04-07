// ---------------------------------------------------------------------------
// LLM Judge — lightweight quality scorer for experiment outputs
// ---------------------------------------------------------------------------

import type { LLMProvider } from "@inixiative/foundry-core";

export interface JudgeResult {
  readonly score: number; // 0-10
  readonly reasoning: string;
}

export interface JudgeConfig {
  provider: LLMProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const JUDGE_PROMPT = `You are a strict but fair output quality judge for an AI agent pipeline.

You will be given:
1. The original user input
2. The agent's output
3. A quality rubric describing what a good response looks like

Score the output from 0 to 10:
- 0-2: Completely wrong, irrelevant, or harmful
- 3-4: Partially addresses the input but missing key aspects
- 5-6: Adequate response, addresses main points but has gaps
- 7-8: Good response, covers the rubric criteria well
- 9-10: Excellent response, fully satisfies the rubric with clear reasoning

Respond with ONLY a JSON object:
{"score": <number 0-10>, "reasoning": "<brief explanation of the score>"}`;

/**
 * Lightweight LLM judge that scores agent output against a rubric.
 * Uses a cheap model (haiku-tier) at temperature 0 for consistency.
 */
export class Judge {
  private _provider: LLMProvider;
  private _model: string;
  private _temperature: number;
  private _maxTokens: number;

  constructor(config: JudgeConfig) {
    this._provider = config.provider;
    this._model = config.model || "claude-haiku-4-5-20251001";
    this._temperature = config.temperature ?? 0;
    this._maxTokens = config.maxTokens ?? 256;
  }

  async score(
    input: string,
    output: string,
    rubric: string,
  ): Promise<JudgeResult> {
    try {
      const result = await this._provider.complete(
        [
          { role: "system", content: JUDGE_PROMPT },
          {
            role: "user",
            content: `## Original Input\n${input}\n\n## Agent Output\n${output}\n\n## Quality Rubric\n${rubric}`,
          },
        ],
        {
          model: this._model,
          temperature: this._temperature,
          maxTokens: this._maxTokens,
        },
      );

      return this._parseResult(result.content);
    } catch (err) {
      return {
        score: 0,
        reasoning: `Judge error: ${(err as Error).message}`,
      };
    }
  }

  private _parseResult(text: string): JudgeResult {
    // Try to extract JSON from the response
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text;

    try {
      const parsed = JSON.parse(raw.trim());
      const score = typeof parsed.score === "number"
        ? Math.max(0, Math.min(10, parsed.score))
        : 0;
      return {
        score,
        reasoning: parsed.reasoning || "No reasoning provided",
      };
    } catch {
      // Try to find JSON in the text
      const braced = raw.match(/\{[\s\S]*\}/);
      if (braced) {
        try {
          const parsed = JSON.parse(braced[0]);
          const score = typeof parsed.score === "number"
            ? Math.max(0, Math.min(10, parsed.score))
            : 0;
          return { score, reasoning: parsed.reasoning || "No reasoning" };
        } catch { /* fall through */ }
      }
      return { score: 0, reasoning: `Failed to parse judge response: ${text.slice(0, 100)}` };
    }
  }
}
