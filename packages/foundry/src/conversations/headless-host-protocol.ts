/**
 * @atlas
 * @kind type
 * @partOf feature:conversations
 */
import { z } from 'zod';

/**
 * The headless host (`headless-host.ts`): Foundry's real conversation host in its own process, paired
 * with a Kingdom, its models answered by the process that started it. This is its IPC contract, the
 * only part a consumer (Kingdom's end-to-end tests) imports, so its type graph stays zod-only.
 */

/** What the parent passes in `FOUNDRY_HEADLESS_HOST` (JSON). */
/** Started with its own HOME, a directory inside the one holding `configDir` (it refuses any other): it runs as its own machine. */
export const headlessHostOptionsSchema = z.strictObject({
  /** The Kingdom API origin to pair with (once per directory) and serve conversations through. */
  url: z.string().url(),
  /** The Foundry configuration directory; reused across restarts. */
  configDir: z.string().min(1),
  /** The installation name shown in Kingdom's review. */
  name: z.string().min(1).max(120).default('Headless Foundry'),
  /**
   * A repository to register as the host's project (absolute path), as `start.ts` registers its
   * directory: its committed `.foundry/` (regions, `project.json` with the chorus and `conversations`
   * settings) gives the project's region Wardens. Threads opened with `cwd` there belong to it.
   */
  project: z.string().min(1).optional(),
});
export type HeadlessHostOptions = z.input<typeof headlessHostOptionsSchema>;

/** Child → parent. */
export const headlessHostEventSchema = z.discriminatedUnion('type', [
  /** Pairing waits for a person to approve this review code in Kingdom. */
  z.strictObject({ type: z.literal('review'), reviewCode: z.string() }),
  /** Paired and serving: the Foundry integration Kingdom created for it. */
  z.strictObject({ type: z.literal('ready'), integrationId: z.string() }),
  /**
   * A model call the parent answers. `agent` is the main thread's executor (it sees the turn's user
   * message, member notes labelled as data, Warden chimes); `warden` is the chorus.
   */
  z.strictObject({
    type: z.literal('model'),
    callId: z.string(),
    role: z.enum(['agent', 'warden']),
    threadId: z.string().nullable(),
    text: z.string(),
  }),
  z.strictObject({
    type: z.literal('reply'),
    requestId: z.string(),
    status: z.number().int(),
    body: z.unknown(),
  }),
  z.strictObject({ type: z.literal('failed'), error: z.string() }),
]);
export type HeadlessHostEvent = z.infer<typeof headlessHostEventSchema>;

/** Parent → child. */
export const headlessHostCommandSchema = z.discriminatedUnion('type', [
  /**
   * The answer to a model call. `sends` are the agent's `send_to_member` calls, dispatched through
   * the tool registry the native MCP bridge uses, before the turn's answer is returned.
   */
  z.strictObject({
    type: z.literal('model'),
    callId: z.string(),
    content: z.string(),
    sends: z.array(z.strictObject({ member: z.string(), text: z.string() })).default([]),
  }),
  /** One request to the viewer's HTTP API (what the owner's dashboard calls). */
  z.strictObject({
    type: z.literal('http'),
    requestId: z.string(),
    method: z.enum(['GET', 'POST']),
    path: z.string().startsWith('/'),
    body: z.unknown().optional(),
  }),
  /** The wrapper's state for a thread, read in process (`HeadlessThreadState`). */
  z.strictObject({ type: z.literal('inspect'), requestId: z.string(), threadId: z.string() }),
  z.strictObject({ type: z.literal('stop') }),
]);
export type HeadlessHostCommand = z.input<typeof headlessHostCommandSchema>;

export const headlessThreadStateSchema = z.strictObject({
  summary: z
    .strictObject({
      unread: z.number(),
      paused: z.boolean(),
      held: z.number(),
      members: z.number(),
    })
    .nullable(),
  members: z.array(
    z.strictObject({ id: z.string(), displayName: z.string(), listed: z.boolean() }),
  ),
  /** The journal's `member-post` rows, oldest first. */
  posts: z.array(z.strictObject({ signetId: z.string(), text: z.string(), delivery: z.string() })),
  /** Advice rows the chorus journalled on a member note (`trigger: consumed`). */
  consumedAdvice: z.number(),
  /** `member-post` rows in what Archive capture sends for the thread. */
  archivedPosts: z.number(),
  /** Held items (sends and posts) awaiting the owner, by the id the answer route takes. */
  heldIds: z.array(z.string()),
  /** Every `send_to_member` the agent made on this thread, with the tool's answer. */
  sends: z.array(z.strictObject({ member: z.string(), text: z.string(), answer: z.string() })),
});
export type HeadlessThreadState = z.infer<typeof headlessThreadStateSchema>;

export const headlessHostEnv = 'FOUNDRY_HEADLESS_HOST';
