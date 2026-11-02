import './helpers/isolate-archive';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFoundryLogin } from '../src/providers/default-profiles';
import {
  LoginSetup,
  removeLogin,
  type SignInProcess,
  updateLogin,
} from '../src/providers/login-setup';
import { readSetupToken } from '../src/providers/native-authentication';
import { ConfigStore, defaultConfig } from '../src/viewer/config';

const TOKEN = `sk-ant-oat01-${'x'.repeat(40)}`;
let root: string;
let home: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'login-setup-'));
  home = process.env.HOME;
  process.env.HOME = join(root, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
});
afterEach(() => {
  process.env.HOME = home;
  rmSync(root, { recursive: true, force: true });
});

/** `claude setup-token` as it behaves: prints the sign-in page, asks for the code, prints the token. */
function fakeSetupToken() {
  const seen: { argv?: string[]; env?: Record<string, string | undefined>; typed: string[] } = {
    typed: [],
  };
  const spawn = (argv: string[], env: Record<string, string | undefined>) => {
    seen.argv = argv;
    seen.env = env;
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    const say = (text: string) => out.enqueue(new TextEncoder().encode(text));
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        out = c;
        say(
          '\u001b[1mBrowser didn’t open? Use the url below\u001b[0m\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc\nPaste code here if prompted > \n',
        );
      },
    });
    return {
      output: stdout,
      write(text: string) {
        seen.typed.push(text);
        say(`\nYour OAuth token (valid for 1 year):\n${TOKEN}\nStore this token securely.\n`);
        out.close();
        exit(0);
      },
      exited: new Promise<number>((resolve) => {
        exit = resolve;
      }),
      kill() {},
    };
  };
  return { seen, spawn };
}

async function settled(setup: LoginSetup, id: string) {
  for (let i = 0; i < 200; i++) {
    const view = setup.get(id)!;
    if (['done', 'failed', 'cancelled'].includes(view.state)) return view;
    await Bun.sleep(5);
  }
  throw Error('sign-in did not settle');
}

test('Add a Claude login: setup-token in its own home, the code typed in, the token kept private', async () => {
  const store = new ConfigStore(join(root, 'foundry'));
  await store.save(defaultConfig());
  const fake = fakeSetupToken();
  const setup = new LoginSetup({ foundryDir: join(root, 'foundry'), store, spawn: fake.spawn });
  const started = setup.start('claude', 'work');
  await Bun.sleep(10);
  const waiting = setup.get(started.id)!;
  expect(waiting.state).toBe('signing-in');
  expect(waiting.url).toBe('https://claude.ai/oauth/authorize?code=true&client_id=abc');
  expect(waiting.wantsCode).toBe(true);
  expect(fake.seen.argv).toEqual(['claude', 'setup-token']);
  expect(fake.seen.env!.CLAUDE_CONFIG_DIR).toBe(join(root, 'foundry', 'logins', started.id));

  setup.sendCode(started.id, ' the-code ');
  const done = await settled(setup, started.id);
  expect(done.state).toBe('done');
  expect(fake.seen.typed).toEqual(['the-code\r']);
  // The page never sees the token.
  expect(JSON.stringify(done)).not.toContain(TOKEN);
  expect(done.output).toContain('[token captured]');

  const saved = (await store.load()).nativeAuthentication!;
  // No login of this machine's own (~/.claude is absent here): the pool starts with the new one.
  expect(saved).toHaveLength(1);
  const login = saved[0]!;
  expect(login).toMatchObject({ id: started.id, runtime: 'claude', name: 'work' });
  if (login.mode !== 'native-profile') throw Error('expected a native profile');
  expect(statSync(login.tokenFile!).mode & 0o777).toBe(0o600);
  expect(readSetupToken(login)).toBe(TOKEN);
  // A home Foundry made: a main thread on it takes the user's own setup (isFoundryLogin).
  expect(isFoundryLogin(login.profileDirectory)).toBe(true);
  expect(isFoundryLogin(join(process.env.HOME!, '.claude'))).toBe(false);
  // Settings hold the path, never the token.
  expect(readFileSync(join(root, 'foundry', 'settings.json'), 'utf8')).not.toContain(TOKEN);
});

test("the first login added keeps this machine's own login in the pool; rename and remove", async () => {
  mkdirSync(join(process.env.HOME!, '.claude'), { mode: 0o700 });
  const store = new ConfigStore(join(root, 'foundry'));
  await store.save(defaultConfig());
  const setup = new LoginSetup({
    foundryDir: join(root, 'foundry'),
    store,
    spawn: fakeSetupToken().spawn,
  });
  const started = setup.start('claude', 'inixiative');
  await Bun.sleep(10);
  setup.sendCode(started.id, 'code');
  await settled(setup, started.id);
  const saved = (await store.load()).nativeAuthentication!;
  expect(saved.map((s) => s.name ?? 'own')).toEqual(['own', 'inixiative']);

  const own = saved[0]!.id;
  await store.update((draft) => updateLogin(draft, own, { name: 'personal', owner: 'personal' }));
  await store.update((draft) => {
    draft.subscriptionPools = { claude: { pinned: true, preferredLoginId: started.id } };
  });
  // Removing a login clears the settings that name it, and deletes only the home Foundry made.
  let remove: string | undefined;
  await store.update((draft) => {
    remove = removeLogin(draft, started.id, join(root, 'foundry')).remove;
  });
  expect(remove).toBe(
    join(root, 'foundry', 'logins', started.id).replace('/var/', '/private/var/'),
  );
  const after = await store.load();
  expect(after.nativeAuthentication!.map((s) => s.name)).toEqual(['personal']);
  expect(after.subscriptionPools?.claude).toEqual({});
  let ownRemoved: string | undefined;
  await store.update((draft) => {
    ownRemoved = removeLogin(draft, own, join(root, 'foundry')).remove;
  });
  expect(ownRemoved).toBeUndefined();
  expect(existsSync(join(process.env.HOME!, '.claude'))).toBe(true);
});

test('a sign-in that ends without a token fails and leaves nothing behind', async () => {
  const store = new ConfigStore(join(root, 'foundry'));
  await store.save(defaultConfig());
  const spawn = (() => ({
    output: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    write() {},
    exited: Promise.resolve(1),
    kill() {},
  })) satisfies (argv: string[], env: Record<string, string | undefined>) => SignInProcess;
  const setup = new LoginSetup({ foundryDir: join(root, 'foundry'), store, spawn });
  const started = setup.start('claude', 'work');
  const view = await settled(setup, started.id);
  expect(view.state).toBe('failed');
  expect(existsSync(join(root, 'foundry', 'logins', started.id))).toBe(false);
  expect((await store.load()).nativeAuthentication).toBeUndefined();
});
