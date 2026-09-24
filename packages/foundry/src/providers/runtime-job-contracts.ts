import { z } from "zod";

/** Generic job envelope. Kinds are open; each registered handler validates its own payload. */
export const runtimeJobSchema = z.looseObject({
  id: z.string().uuid(), installationId: z.string().uuid(), kind: z.string().min(1).max(64),
  status: z.enum(["claimed", "awaitingApproval", "running"]), expiresAt: z.string().datetime(),
});
export const jobStateSchema = z.object({
  phase: z.enum(["requesting", "awaitingApproval", "ready", "executing", "finished", "failed"]),
  requestId: z.string().uuid().optional(), deviceCode: z.string().optional(), signetId: z.string().uuid().optional(),
  outcome: z.object({ allowedReads: z.number(), forbiddenDocumentDenied: z.boolean(), searchDenied: z.boolean(), afterCloseDenied: z.boolean(),
    allergies: z.array(z.enum(["penicillin", "latex"])), error: z.enum(["execution_unavailable", "approval_declined", "authorization_changed", "interrupted"]).optional(),
  }).optional(),
});
export type RuntimeJob = z.infer<typeof runtimeJobSchema>;
export type RuntimeJobState = z.infer<typeof jobStateSchema>;
