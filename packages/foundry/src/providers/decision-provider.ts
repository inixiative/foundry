import { OpenAIProvider } from "./openai";

export const DECISION_MODEL = "gpt-5.6-luna";

export function createDecisionProvider(enabled: boolean, apiKey: string | undefined): OpenAIProvider {
  if (!enabled || !apiKey?.trim()) {
    throw new Error("Foundry decisions require enabled OpenAI access and OPENAI_API_KEY for GPT-5.6 Luna; the worker model will not be used as a fallback.");
  }
  return new OpenAIProvider({ apiKey, defaultModel: DECISION_MODEL }, "openai-decisions");
}
