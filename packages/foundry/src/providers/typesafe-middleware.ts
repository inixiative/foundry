import type { DispatchContext, Middleware } from "@inixiative/foundry-core";
import { TypeSafeDecisionClient, type TypeSafeContent, type TypeSafeQuestions, type TypeSafeResult } from "./typesafe";

export interface TypeSafeMiddlewareOptions<Q extends TypeSafeQuestions> {
  client: TypeSafeDecisionClient;
  questions: Q;
  /** Explicitly select the minimum state this middleware needs. */
  state: (context: DispatchContext) => TypeSafeContent | Promise<TypeSafeContent>;
  annotationKey?: string;
  /** Compose policy/routing in code; low confidence handling belongs here. */
  onDecision?: (result: TypeSafeResult<Q>, context: DispatchContext) => void | Promise<void>;
}

/** Register explicitly with MiddlewareChain.use/useWhen; failures stop dispatch. */
export function createTypeSafeMiddleware<const Q extends TypeSafeQuestions>(options: TypeSafeMiddlewareOptions<Q>): Middleware {
  return async (context, next) => {
    if (!context.threadId) throw new Error("TypeSafe middleware requires a threadId for capability checks");
    const result = await options.client.evaluate(await options.state(context), options.questions, {
      agentId: context.agentId, threadId: context.threadId,
      detail: "TypeSafe middleware decision",
      meta: { projectId: context.projectId, dispatchId: context.dispatchId },
    });
    context.annotations[options.annotationKey ?? "typesafe"] = result;
    await options.onDecision?.(result, context);
    return next();
  };
}
