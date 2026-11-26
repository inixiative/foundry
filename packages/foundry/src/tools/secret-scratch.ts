/**
 * @atlas
 * @kind adapter
 * @partOf feature:secrets, primitive:tools
 */
import type {
  ApiRequest,
  ApiResponse,
  ApiTool,
  OwnershipScope,
  ToolResult,
} from '@inixiative/foundry-core';
import {
  parseScratchRef,
  type ScratchSource,
  SecretScratchError,
  scratchTarget,
} from '@inixiative/secret-scratch';
import { z } from 'zod';
import {
  FOUNDRY_HOLDER,
  isKeychainHolder,
  isKeychainName,
  KeychainError,
} from '../secrets/keychain';
import type { SecretScratch } from '../secrets/scratch';

/**
 * The scratch pad's tools on Foundry's MCP bridge (FEAT-005): `secret_scratch` (list, env, write,
 * consume) and `secret_pipe`. Every answer names references and paths only; no value ever comes back.
 * The thread and its working directory come from the bridge, never from the agent's arguments.
 */

const ref = z
  .string()
  .trim()
  .min(3)
  .max(300)
  .describe('†<message>.<n> in this thread, or †<thread>/<message>.<n> for another thread');
const consume = z
  .boolean()
  .optional()
  .describe('Remove the secret from the pad after this use (on its last use)');
const filePath = z.string().trim().min(1).max(1_000);
const name = z
  .string()
  .trim()
  .refine(isKeychainName, 'letters, digits, dot, dash or underscore, at most 100')
  .describe('A keychain entry: a secret the person kept in Foundry, held by foundry');
const holder = z
  .string()
  .trim()
  .refine(isKeychainHolder, 'foundry, or provider:<id>, memory:<id>, mcp:<id>, integration:<id>');

export const secretScratchSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('list'),
    thread: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Another thread whose pad to list; omit for this one'),
    all: z.boolean().optional().describe('List every pad on this machine'),
  }),
  z.strictObject({
    action: z.literal('env'),
    ref: ref.optional(),
    name: name.optional(),
    path: filePath.describe('The env file, relative to the thread working directory'),
    key: z.string().trim().min(1).max(200),
    consume,
  }),
  z.strictObject({
    action: z.literal('write'),
    ref: ref.optional(),
    name: name.optional(),
    path: filePath,
    mode: z.enum(['replace', 'append']).optional(),
    consume,
  }),
  z.strictObject({ action: z.literal('consume'), ref }),
  z.strictObject({
    action: z.literal('keep'),
    ref,
    name,
    holder: holder.optional(),
    replace: z.boolean().optional(),
  }),
]);

/** The same arguments as one flat shape, as an MCP tool declares them; `secretScratchSchema` checks each action. */
export const secretScratchShape = {
  action: z.enum(['list', 'env', 'write', 'consume', 'keep']),
  ref: ref.optional(),
  name: name
    .optional()
    .describe('env or write: a keychain entry instead of ref; keep: the entry to save it as'),
  holder: holder
    .optional()
    .describe(
      'keep: who may read it, foundry (default) or one connector such as provider:anthropic',
    ),
  replace: z.boolean().optional().describe('keep: overwrite an entry of that name'),
  path: filePath
    .optional()
    .describe('env or write: the file, relative to the thread working directory'),
  key: z.string().trim().min(1).max(200).optional().describe('env: the variable name'),
  mode: z.enum(['replace', 'append']).optional().describe('write: replace (default) or append'),
  consume,
  thread: z.string().trim().min(1).max(200).optional().describe('list: another thread'),
  all: z.boolean().optional().describe('list: every pad on this machine'),
};

export const secretPipeSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe('Shell command that reads the value on stdin; its output is thrown away'),
  ref: ref.optional(),
  envFile: filePath.optional().describe('Read the value from this env file instead of a reference'),
  name: name.optional(),
  key: z.string().trim().min(1).max(200).optional(),
  consume,
});

export const SECRET_SCRATCH_DESCRIPTION =
  "Use a secret the person handed you as $$word, which reached you as a reference like †<message>.<n>. You never see the value and never return it: use it. env sets KEY to the value in an env file (the normal path); write puts it in a file (replace, or append on its own line); consume removes it from the pad; list shows what is pending (references and the message each came from, never values), in this thread, another thread of this project, or all of this project's, and the keychain's entry names. keep saves a secret into Foundry's keychain (the machine's own) under a name, so it outlives the thread: held by foundry it is usable by name (env or write with name instead of ref) in any later turn of the owner's or a schedule of his; held by a connector (provider:anthropic) only that connector reads it. Pass consume: true on the last use. env and write only reach files inside the thread's working directory, outside version-control and agent configuration. A file this tool writes to is then off limits: do not read, search or print it; use it through secret_pipe. Works only in a turn the owner's own message opened.";

export const SECRET_PIPE_DESCRIPTION =
  'Run a shell command with a secret on its stdin: from an env file key (envFile + key, the normal path after secret_scratch env), a reference (ref), or a keychain entry (name). Its output is thrown away; only the exit code comes back. A failed command keeps the secret in the pad. Example: command "gh secret set API_TOKEN", envFile ".env.local", key "API_TOKEN".';

export { scratchTarget };

export class SecretScratchTool implements ApiTool {
  readonly id = 'secrets';
  readonly kind = 'api' as const;
  readonly capability = 'net:api' as const;
  constructor(
    private readonly resolve: () => SecretScratch | null,
    private readonly scope: OwnershipScope = {},
  ) {}
  scoped(scope: OwnershipScope): SecretScratchTool {
    return new SecretScratchTool(this.resolve, scope);
  }
  /** Whether the thread's project has the scratch pad on. */
  enabled(projectId: string | undefined): boolean {
    return this.resolve()?.enabled(projectId) ?? false;
  }
  /** `url` is `secret_scratch` or `secret_pipe`; `body` is its arguments plus the bridge's `cwd`. */
  async request<T = unknown>(req: ApiRequest): Promise<ToolResult<ApiResponse<T>>> {
    const started = performance.now();
    try {
      const threadId = this.scope.threadId;
      if (!threadId) throw Error('This tool runs only inside a thread');
      const secrets = this.resolve();
      if (!secrets?.enabled(this.scope.projectId))
        throw Error('The scratch pad is off for this project (secrets.scratchPad).');
      const { cwd, ...args } = (req.body ?? {}) as { cwd?: string } & Record<string, unknown>;
      const summary =
        req.url === 'secret_pipe'
          ? await this.pipe(secrets, threadId, cwd, args)
          : await this.scratch(secrets, threadId, cwd, args);
      return {
        ok: true,
        summary,
        data: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: { result: summary } as T,
          durationMs: Math.round(performance.now() - started),
        },
      };
    } catch (error) {
      // Only the pad's own errors and validation are shown: they name references and paths, never values.
      const summary =
        error instanceof SecretScratchError ||
        error instanceof KeychainError ||
        error instanceof z.ZodError
          ? error instanceof z.ZodError
            ? `Not done: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
            : error.message
          : error instanceof Error && !(error as NodeJS.ErrnoException).code
            ? error.message
            : 'The scratch pad operation failed.';
      return { ok: false, summary, error: summary };
    }
  }

  /**
   * Where a use reads its value: a pad reference (the pad's own gate), or a keychain entry, held by
   * foundry and used in a turn of the owner's word.
   */
  private async source(
    secrets: SecretScratch,
    threadId: string,
    given: { ref?: string; name?: string; envFile?: string; key?: string; consume?: boolean },
  ): Promise<ScratchSource> {
    const chosen = [given.ref, given.name, given.envFile].filter((v) => v !== undefined);
    if (chosen.length !== 1 || (given.envFile !== undefined) !== (given.key !== undefined))
      throw new SecretScratchError('Give one of ref, name, or envFile and key.');
    if (given.name !== undefined) {
      if (given.consume)
        throw new SecretScratchError(
          'consume is for a scratch-pad reference; a keychain entry stays until the person removes it.',
        );
      const refused = secrets.keychainRefusal(threadId);
      if (refused) throw new SecretScratchError(refused);
      return { value: await secrets.keychain!.read(given.name, FOUNDRY_HOLDER) };
    }
    const refused = secrets.refusal(
      threadId,
      given.ref !== undefined ? parseScratchRef(given.ref, threadId).thread : threadId,
    );
    if (refused) throw new SecretScratchError(refused);
    return given.ref !== undefined
      ? { ref: given.ref }
      : { envFile: given.envFile!, key: given.key! };
  }

  private async scratch(
    secrets: SecretScratch,
    threadId: string,
    cwd: string | undefined,
    raw: unknown,
  ): Promise<string> {
    const args = secretScratchSchema.parse(raw);
    const { pad } = secrets;
    switch (args.action) {
      case 'list': {
        const asked = args.all ? undefined : (args.thread ?? threadId);
        if (asked && asked !== threadId) {
          const refused = secrets.refusal(threadId, asked);
          if (refused) throw new SecretScratchError(refused);
        }
        const visible = new Set(secrets.visibleThreads(threadId));
        const pads = (asked ? pad.list(asked) : pad.list()).filter((p) => visible.has(p.thread));
        const kept = secrets.keychain?.list() ?? [];
        const keychain = kept.length
          ? `Keychain: ${kept
              .map((entry) =>
                entry.holder === FOUNDRY_HOLDER
                  ? entry.name
                  : `${entry.name} (held by ${entry.holder}, not yours to use)`,
              )
              .join(', ')}`
          : undefined;
        if (!pads.length)
          return [
            args.all ? 'No scratch pad holds anything.' : 'Nothing is pending in that pad.',
            keychain,
          ]
            .filter(Boolean)
            .join('\n');
        return [
          ...pads.map(
            (p) =>
              `Thread ${p.thread}${p.thread === threadId ? ' (this thread)' : ''}:\n${p.daggers
                .map(
                  (d) =>
                    `  †${d.message} (${d.at}, "${d.excerpt}"): ${d.positions
                      .map((n) =>
                        p.thread === threadId
                          ? `†${d.message}.${n}`
                          : `†${p.thread}/${d.message}.${n}`,
                      )
                      .join(', ')}`,
                )
                .join('\n')}`,
          ),
          ...(keychain ? [keychain] : []),
        ].join('\n');
      }
      case 'env': {
        const source = await this.source(secrets, threadId, {
          ref: args.ref,
          name: args.name,
          consume: args.consume,
        });
        pad.env(source, threadId, scratchTarget(cwd, args.path), args.key, {
          consume: args.consume,
        });
        return `${args.key} is set in ${args.path}${args.consume && args.ref ? '; the secret is consumed' : ''}.`;
      }
      case 'write': {
        const source = await this.source(secrets, threadId, {
          ref: args.ref,
          name: args.name,
          consume: args.consume,
        });
        pad.write(source, threadId, scratchTarget(cwd, args.path), {
          consume: args.consume,
          ...(args.mode ? { mode: args.mode } : {}),
        });
        return `Written to ${args.path}${args.consume && args.ref ? '; the secret is consumed' : ''}.`;
      }
      case 'consume': {
        const refused = secrets.refusal(threadId, parseScratchRef(args.ref, threadId).thread);
        if (refused) throw new SecretScratchError(refused);
        pad.consume(args.ref, threadId);
        return `${args.ref} is consumed.`;
      }
      case 'keep': {
        const refused = secrets.refusal(threadId, parseScratchRef(args.ref, threadId).thread);
        if (refused) throw new SecretScratchError(refused);
        const keychain = secrets.keychain;
        if (!keychain) throw new SecretScratchError('This Foundry has no keychain.');
        const holder = args.holder ?? FOUNDRY_HOLDER;
        const held = keychain.entry(args.name);
        // Who holds an entry is the person's to change, in Settings; an agent never takes one over.
        if (held && held.holder !== holder)
          throw new SecretScratchError(
            `${args.name} is held by ${held.holder}; only the person changes that, in Settings → Keychain.`,
          );
        const entry = await pad.use(
          args.ref,
          threadId,
          (value) =>
            keychain.store(args.name, value, {
              holder,
              from: 'pad',
              actor: { kind: 'agent', id: threadId },
              replace: args.replace,
            }),
          { consume: true },
        );
        return `${args.ref} is kept in the keychain as ${entry.name}, held by ${entry.holder}; it is gone from the pad.`;
      }
    }
  }

  private async pipe(
    secrets: SecretScratch,
    threadId: string,
    cwd: string | undefined,
    raw: unknown,
  ): Promise<string> {
    const args = secretPipeSchema.parse(raw);
    const source = await this.source(secrets, threadId, args);
    const { exitCode } = await secrets.pad.pipe(source, threadId, args.command, {
      cwd,
      consume: args.consume,
    });
    return exitCode === 0
      ? `The command exited 0 (output withheld)${args.consume && args.ref ? '; the secret is consumed' : ''}.`
      : `The command exited ${exitCode} (output withheld); nothing was consumed.`;
  }

  get<T = unknown>(url: string) {
    return this.request<T>({ url, method: 'GET' });
  }
  post<T = unknown>(url: string, body: unknown) {
    return this.request<T>({ url, body, method: 'POST' });
  }
  put<T = unknown>(url: string, body: unknown) {
    return this.request<T>({ url, body, method: 'PUT' });
  }
  delete<T = unknown>(url: string) {
    return this.request<T>({ url, method: 'DELETE' });
  }
}
