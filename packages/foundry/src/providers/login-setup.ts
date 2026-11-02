/**
 * @atlas
 * @kind service
 * @partOf feature:nativeAuth
 */
/**
 * Adding a subscription login from Settings › Providers (Aron, 2026-11-02: "Let's get all my subs
 * set up"). "Add a Claude login" runs `claude setup-token` (Anthropic's own sign-in: inference only,
 * one year) in a fresh private home under Foundry's directory; the person finishes it in the browser
 * the CLI opens, or pastes the code it shows back into Settings. The token goes only into a private
 * file in that home (0600), never into settings, a log or a response: settings hold its path. "Add a
 * Codex login" runs `codex login` in a fresh `CODEX_HOME` the same way. The CLI's output reaches the
 * page with any token masked (`maskedOutput`, the Kingdom login's).
 *
 * The first login added to a runtime keeps this machine's own login (`~/.claude`) in the pool, so
 * adding a second subscription never drops the first; it can be named or removed like any other.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile, writePrivateJson } from '../client/private-file';
import type { ConfigStore, FoundryConfig } from '../viewer/config';
import { defaultProfileSource, type NativeProfileSource } from './default-profiles';
import { maskedOutput } from './kingdom-subscription-login';
import { withoutCompetingCredentials } from './native-authentication';
import { assertProfile } from './private-profile';
import type { PooledRuntime } from './subscription-policy';

export type SetupState = 'starting' | 'signing-in' | 'saving' | 'done' | 'failed' | 'cancelled';

export interface LoginSetupView {
  id: string;
  runtime: PooledRuntime;
  name: string;
  state: SetupState;
  /** The sign-in page the CLI printed (it also tries to open it). */
  url?: string;
  /** The CLI is asking for the code the sign-in page shows. */
  wantsCode: boolean;
  /** The CLI's output, tokens masked, last few lines. */
  output: string;
  error?: string;
  /** The login it made, once saved. */
  loginId?: string;
}

/** A sign-in command on a terminal of its own: what it prints, what is typed into it, how it ends. */
export interface SignInProcess {
  output: ReadableStream<Uint8Array>;
  write(text: string): void;
  exited: Promise<number>;
  kill(): void;
}

interface Running {
  view: LoginSetupView;
  directory: string;
  child?: SignInProcess;
  endedAt?: number;
}

/**
 * Runs the sign-in on Bun's own pseudo-terminal: `claude setup-token` is an interactive screen that
 * needs one, and a typed code goes in as keystrokes. Wide, so a printed token stays on one line.
 */
function onTerminal(argv: string[], env: Record<string, string | undefined>): SignInProcess {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  const close = () => {
    if (!open) return;
    open = false;
    stream.close();
  };
  const child = Bun.spawn(argv, {
    env,
    terminal: {
      cols: 4000,
      rows: 40,
      data: (_terminal, data) => {
        if (open) stream.enqueue(new Uint8Array(data));
      },
      exit: close,
    },
  });
  const exited = child.exited.then((code) => {
    // The terminal closes on its own EOF; a process gone first closes the stream too.
    setTimeout(close, 200);
    return code;
  });
  return {
    output,
    write: (text) => child.terminal?.write(text),
    exited,
    kill: () => child.kill(),
  };
}

const OUTPUT_KEEP = 4_000;
const KEEP_FINISHED_MS = 10 * 60_000;
/** A sign-in page the CLI prints: Anthropic's or OpenAI's authorize page. */
const SIGN_IN_URL = /https:\/\/[^\s"'<>]*(?:oauth|authorize|auth\.openai\.com)[^\s"'<>]*/i;
const ASKS_FOR_CODE = /paste (?:the )?code|enter (?:the )?code|authorization code/i;
const NAME = /^[^\r\n\0]{1,40}$/;
const SETUP_TOKEN_FILE = 'setup-token.json';

export interface LoginSetupOptions {
  foundryDir: string;
  store: ConfigStore;
  /** Test seam: runs the sign-in command in `env` on a terminal. */
  spawn?: (argv: string[], env: Record<string, string | undefined>) => SignInProcess;
  /** Called when a login is added, renamed or removed. */
  changed?: () => void;
}

/** Each sign-in in progress, and the logins it saved. */
export class LoginSetup {
  private running = new Map<string, Running>();
  constructor(private options: LoginSetupOptions) {}

  get(id: string): LoginSetupView | undefined {
    this.prune();
    return this.running.get(id)?.view;
  }

  list(): LoginSetupView[] {
    this.prune();
    return [...this.running.values()].map((r) => r.view);
  }

  start(runtime: PooledRuntime, name: string): LoginSetupView {
    const label = name.trim();
    if (!NAME.test(label)) throw Error('Name the login in 1 to 40 characters');
    if (runtime !== 'claude' && runtime !== 'codex')
      throw Error('Only Claude and Codex logins can be added here');
    if ([...this.running.values()].some((r) => r.view.state === 'signing-in'))
      throw Error('Finish or cancel the sign-in in progress first');
    const id = crypto.randomUUID();
    const root = join(this.options.foundryDir, 'logins');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = join(root, id);
    mkdirSync(directory, { mode: 0o700 });
    const view: LoginSetupView = {
      id,
      runtime,
      name: label,
      state: 'starting',
      wantsCode: false,
      output: '',
    };
    const running: Running = { view, directory };
    this.running.set(id, running);
    void this.run(running).catch((error: unknown) => this.fail(running, error));
    return view;
  }

  /** The code the sign-in page shows, typed into the CLI. */
  sendCode(id: string, code: string): void {
    const running = this.running.get(id);
    if (!running?.child || running.view.state !== 'signing-in')
      throw Error('No sign-in is waiting');
    const text = code.trim();
    if (!text || /[\r\n\0]/.test(text) || text.length > 2_000) throw Error('That is not a code');
    running.child.write(`${text}\r`);
    running.view.wantsCode = false;
  }

  cancel(id: string): void {
    const running = this.running.get(id);
    if (!running) return;
    if (running.view.state === 'done') return;
    running.view.state = 'cancelled';
    running.endedAt = Date.now();
    try {
      running.child?.kill();
    } catch {
      /* Already gone. */
    }
    rmSync(running.directory, { recursive: true, force: true });
  }

  private async run(running: Running) {
    const { view, directory } = running;
    const env = withoutCompetingCredentials(process.env);
    const argv = view.runtime === 'claude' ? ['claude', 'setup-token'] : ['codex', 'login'];
    if (view.runtime === 'codex')
      writePrivateFile(join(directory, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    const childEnv = {
      ...env,
      ...(view.runtime === 'claude' ? { CLAUDE_CONFIG_DIR: directory } : { CODEX_HOME: directory }),
    };
    const child = (this.options.spawn ?? onTerminal)(argv, childEnv);
    running.child = child;
    view.state = 'signing-in';
    const show = (text: string) => {
      view.output = (view.output + text).slice(-OUTPUT_KEEP);
      view.url ??= view.output.match(SIGN_IN_URL)?.[0];
      if (ASKS_FOR_CODE.test(text)) view.wantsCode = true;
    };
    const token = await maskedOutput(child.output, show);
    const code = await child.exited;
    if ((view.state as SetupState) === 'cancelled') return;
    if (code !== 0)
      throw Error(
        view.runtime === 'claude'
          ? 'claude setup-token did not finish'
          : 'codex login did not finish',
      );
    view.state = 'saving';
    const real = realpathSync(directory);
    const login: NativeProfileSource = {
      id: view.id,
      integrationId: crypto.randomUUID(),
      runtime: view.runtime,
      mode: 'native-profile',
      profileDirectory: real,
      name: view.name,
    } as NativeProfileSource;
    if (view.runtime === 'claude') {
      if (!token) throw Error('claude setup-token did not print a token');
      const tokenFile = join(real, SETUP_TOKEN_FILE);
      writePrivateJson(tokenFile, { token });
      login.tokenFile = tokenFile;
    } else if (!existsSync(join(real, 'auth.json')))
      throw Error('codex login left no ChatGPT login');
    await this.options.store.update((draft) => addLogin(draft, login));
    view.loginId = login.id;
    view.state = 'done';
    view.wantsCode = false;
    running.endedAt = Date.now();
    running.child = undefined;
    this.options.changed?.();
  }

  private fail(running: Running, error: unknown) {
    if (running.view.state === 'cancelled') return;
    running.view.state = 'failed';
    running.view.error = (error as Error).message;
    running.endedAt = Date.now();
    try {
      running.child?.kill();
    } catch {
      /* Already gone. */
    }
    running.child = undefined;
    rmSync(running.directory, { recursive: true, force: true });
  }

  private prune() {
    const now = Date.now();
    for (const [id, running] of this.running)
      if (running.endedAt && now - running.endedAt > KEEP_FINISHED_MS) this.running.delete(id);
  }
}

/**
 * Adds a login to settings. The first one of its runtime brings this machine's own login along when
 * it is there, so the pool keeps the subscription that was already running.
 */
export function addLogin(draft: FoundryConfig, login: NativeProfileSource): void {
  draft.nativeAuthentication ??= [];
  const sources = draft.nativeAuthentication;
  const ofRuntime = sources.filter(
    (s) => s.runtime === login.runtime && s.mode === 'native-profile',
  );
  if (!ofRuntime.length) {
    const own = defaultProfileSource(login.runtime);
    try {
      assertProfile(own.profileDirectory, own.runtime);
      if (!sources.some((s) => s.id === own.id)) sources.push(own);
    } catch {
      /* No login of its own here: the pool starts with the new one. */
    }
  }
  sources.push(login);
}

/** Renames a login (the label only: its native sessions and history stay where they are). */
export function renameLogin(draft: FoundryConfig, id: string, name: string): void {
  const label = name.trim();
  if (!NAME.test(label)) throw Error('Name the login in 1 to 40 characters');
  const login = draft.nativeAuthentication?.find((s) => s.id === id);
  if (!login) throw Error('No such login');
  login.name = label;
}

/**
 * Removes a login from settings and every setting that names it. A home Foundry made for it is
 * deleted with its token; this machine's own login location is only forgotten, never touched.
 */
export function removeLogin(
  draft: FoundryConfig,
  id: string,
  foundryDir: string,
): { remove?: string } {
  const login = draft.nativeAuthentication?.find((s) => s.id === id);
  if (!login) throw Error('No such login');
  if (draft.subscriptionOnly?.decisionSourceId === id)
    throw Error(
      'Wardens run on this login (subscriptionOnly.decisionSourceId); choose another first',
    );
  draft.nativeAuthentication = draft.nativeAuthentication!.filter((s) => s.id !== id);
  if (!draft.nativeAuthentication.length) delete draft.nativeAuthentication;
  if (draft.defaults.nativeAuthenticationId === id) delete draft.defaults.nativeAuthenticationId;
  const unprefer = (pools: FoundryConfig['subscriptionPools']) => {
    for (const pool of Object.values(pools ?? {}))
      if (pool?.preferredLoginId === id) {
        delete pool.preferredLoginId;
        if (pool.routing === 'pinned') delete pool.routing;
      }
  };
  unprefer(draft.subscriptionPools);
  for (const project of Object.values(draft.projects ?? {})) unprefer(project.subscriptionPools);
  const made = join(realpathSafe(join(foundryDir, 'logins')), id);
  return login.mode === 'native-profile' && realpathSafe(login.profileDirectory) === made
    ? { remove: made }
    : {};
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
