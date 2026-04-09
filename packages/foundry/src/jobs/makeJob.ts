import type { JobHandler } from "./types";

export const makeJob = <TPayload = void>(handler: JobHandler<TPayload>): JobHandler<TPayload> => handler;
