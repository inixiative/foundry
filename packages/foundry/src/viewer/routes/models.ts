import type { Hono } from 'hono';
import { z } from 'zod';
import { registryModel, resolveDecisionModel, subscriptionWorker } from '../../models/registry';
import {
  resolveSubscriptionPolicy,
  SUBSCRIPTION_DECISIONS,
} from '../../providers/subscription-policy';
import type { ConfigStore, FoundryConfig } from '../config';

const choiceSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();

/** The default model and the decision model this configuration runs, as provider + model ids. */
export function modelSelection(config: FoundryConfig) {
  const apiTokens = config.apiTokens === true;
  let decision: { provider: string; model: string } | null = null;
  let issue: string | undefined;
  if (apiTokens) decision = resolveDecisionModel(config);
  else
    try {
      const subscription = resolveSubscriptionPolicy(config)!;
      decision = {
        provider: subscription.decision.runtime === 'codex' ? 'codex' : 'claude-code',
        model: subscription.policy.model,
      };
    } catch (error) {
      issue = (error as Error).message;
    }
  // Decision roles: every enabled agent that is not an executor. A fresh install has none.
  const decisionRoles = Object.values(config.agents)
    .filter((agent) => agent.enabled !== false && agent.kind !== 'executor')
    .map((agent) => agent.id);
  return {
    apiTokens,
    default: { provider: config.defaults.provider, model: config.defaults.model },
    decision,
    decisionRoles,
    ...(issue ? { issue } : {}),
  };
}

/**
 * Settings → Providers: which model is the default (the main thread's) and which runs decision
 * roles. Each choice is one validated settings edit, so a refused choice changes nothing.
 */
export function registerModelRoutes(app: Hono, configStore: ConfigStore) {
  const choose = (
    path: string,
    apply: (draft: FoundryConfig, choice: z.infer<typeof choiceSchema>) => void,
  ) =>
    app.post(path, async (c) => {
      const parsed = choiceSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Choose a provider and a model.' }, 400);
      const { provider, model } = parsed.data;
      if (!registryModel(provider, model))
        return c.json({ error: `${model} is not a ${provider} model` }, 400);
      try {
        await configStore.load();
        await configStore.update((draft) => apply(draft, parsed.data));
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
      return c.json(modelSelection(configStore.config));
    });

  app.get('/api/models/selection', async (c) => {
    await configStore.load();
    return c.json(modelSelection(configStore.config));
  });

  choose('/api/models/default', (draft, { provider, model }) => {
    draft.defaults.provider = provider;
    draft.defaults.model = model;
  });

  choose('/api/models/decision', (draft, { provider, model }) => {
    if (subscriptionWorker(provider)) {
      // A subscription login runs decisions: Claude (in its own sessions, or in-session) or Codex.
      const current = draft.subscriptionOnly?.decisionRuntime;
      const decisionRuntime =
        provider === 'codex'
          ? 'codex'
          : current === 'claude-in-session'
            ? 'claude-in-session'
            : 'claude';
      draft.subscriptionOnly = { ...draft.subscriptionOnly, decisionRuntime, model };
      draft.defaults.classifierProvider = SUBSCRIPTION_DECISIONS;
      draft.defaults.classifierModel = model;
      return;
    }
    if (draft.apiTokens !== true)
      throw Error(
        `${provider} runs decisions through its API: turn on API keys (apiTokens) first, or choose a subscription model`,
      );
    draft.defaults.classifierProvider = provider;
    draft.defaults.classifierModel = model;
  });
}
