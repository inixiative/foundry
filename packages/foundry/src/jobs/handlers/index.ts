import { cleanStaleTraces } from "./cleanStaleTraces";
import { type PersistMessagePayload, persistMessage } from "./persistMessage";
import { type PersistSignalPayload, persistSignal } from "./persistSignal";
import { type PersistTracePayload, persistTrace } from "./persistTrace";
import { warmLayers, type WarmLayersPayload } from "./warmLayers";
import type { JobHandler } from "../types";

// ---------------------------------------------------------------------------
// Handler name registry — type-safe payload mappings
// ---------------------------------------------------------------------------

export const JobHandlerName = {
  persistTrace: "persistTrace",
  persistMessage: "persistMessage",
  persistSignal: "persistSignal",
  warmLayers: "warmLayers",
  cleanStaleTraces: "cleanStaleTraces",
} as const;

export type JobHandlerName = (typeof JobHandlerName)[keyof typeof JobHandlerName];

export type { WarmLayersPayload };

export type JobPayloads = {
  persistTrace: PersistTracePayload;
  persistMessage: PersistMessagePayload;
  persistSignal: PersistSignalPayload;
  warmLayers: WarmLayersPayload;
  cleanStaleTraces: undefined;
};

export type JobHandlers = {
  [K in JobHandlerName]: JobHandler<JobPayloads[K]>;
};

export const jobHandlers: JobHandlers = {
  persistTrace,
  persistMessage,
  persistSignal,
  warmLayers,
  cleanStaleTraces,
};

export const isValidHandlerName = (name: string): name is JobHandlerName => name in jobHandlers;
