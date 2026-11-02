// Recorded counterparts of subscription-transport.ts: the same observation surface
// (launches, writes, statusChecks, live/peak), backed by cassettes of the real CLIs.
import { join } from 'node:path';
import type { MuseConnect } from '@inixiative/agent-session';
import { Connection, type DuplexTransport } from '@muse-code/sdk';
import { nativeTextEnvironment } from '../../src/providers/native-text-environment';
import {
  cliVersion,
  type Frame,
  fetchVersion,
  type Launch,
  ProcessCassettes,
  VCR,
} from '../../src/vcr';

export const FIXTURES_DIR = join(import.meta.dir, '../fixtures/vcr');

/** What the live tier runs on. The observed Claude model is the alias's canonical name; a change is a finding. */
export const LIVE = {
  claudeModel: 'haiku',
  claudeObservedModel: 'claude-haiku-5-5',
  codexModel: 'gpt-5.6-luna',
  /** Muse Code's default (and only Everyday Usage) model; every live Muse turn runs at low effort. */
  museModel: 'muse-wonder-1.0',
  kingdomUrl: process.env.FOUNDRY_VCR_KINGDOM_URL ?? 'http://127.0.0.1:8200',
} as const;

/** Makes a live model's answer checkable: every live prompt asks for this exact reply. */
export const ANSWER = 'accepted-private-answer';
export const answerPrompt = (label = 'private-input') =>
  `${label}. Reply with exactly ${ANSWER} and nothing else.`;
/** Decision roles run under Foundry's decision context: a real classification whose answer is unambiguous. */
export const decisionMessages = (input = 'private-input') => [
  {
    role: 'system' as const,
    content:
      'Classify the user message. Respond with JSON only, exactly {"category":"feature"}, {"category":"bug"} or {"category":"question"}.',
  },
  { role: 'user' as const, content: `${input}: add a dark mode toggle to the settings page` },
];
export const DECIDED = /"category"\s*:\s*"feature"/;

const vcrs: VCR[] = [];
/** Call from `afterAll` in every file that records: cassettes finish writing after the process exits. */
export const settleRecordings = async () => {
  await Promise.all(vcrs.map((vcr) => vcr.settled()));
};
const made = (vcr: VCR) => {
  vcrs.push(vcr);
  return vcr;
};

export const claudeVcr = () =>
  made(
    new VCR(join(FIXTURES_DIR, 'claude'), {
      service: 'claude',
      cli: 'claude',
      version: () => cliVersion('claude'),
    }),
  );
export const codexVcr = () =>
  made(
    new VCR(join(FIXTURES_DIR, 'codex'), {
      service: 'codex',
      cli: 'codex',
      version: () => cliVersion('codex'),
    }),
  );
export const museVcr = () =>
  made(
    new VCR(join(FIXTURES_DIR, 'muse'), {
      service: 'muse',
      cli: 'muse',
      version: () => cliVersion('muse'),
    }),
  );
export const kingdomVcr = () =>
  made(
    new VCR(join(FIXTURES_DIR, 'kingdom'), {
      service: 'kingdom',
      version: () => fetchVersion(`${LIVE.kingdomUrl}/openapi/docs`),
    }),
  );

/** `claude auth status --json` prints the account (email, org); keep only what Foundry reads. Output that does
 * not parse is withheld whole (fail closed), never kept as text. */
export const claudeStatusOnly = (frames: Frame[]): Frame[] => {
  const stdout = frames
    .filter((frame) => frame.stream === 'stdout')
    .map((frame) => frame.data)
    .join('\n');
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    return [
      {
        after: 0,
        stream: 'stdout',
        data: JSON.stringify({ loggedIn: status.loggedIn, authMethod: status.authMethod }),
      },
    ];
  } catch {
    return [{ after: 0, stream: 'stdout', data: 'VCR: unparseable auth status withheld' }];
  }
};
type Names = { decision?: string[]; status?: string[] };
const queueAll = (vcr: VCR, method: string, names: string[] = []) => {
  for (const name of names) vcr.queue(method, name);
};

/** Claude text decisions: `claude auth status --json`, then one stream-json process per call. */
export function recordedClaudeTransport(names: Names, vcr = claudeVcr()) {
  queueAll(vcr, 'decision', names.decision);
  queueAll(vcr, 'auth-status', names.status);
  const decisions = new ProcessCassettes(vcr, 'decision');
  const status = new ProcessCassettes(vcr, 'auth-status', {
    argv: ['claude', 'auth', 'status', '--json'],
    sanitize: claudeStatusOnly,
    recordOnce: true,
    model: () => undefined,
    env: () => nativeTextEnvironment(process.env),
  });
  return {
    vcr,
    launches: decisions.launches as Launch[],
    get writes() {
      return decisions.writes;
    },
    get statusChecks() {
      return status.launches.length;
    },
    spawn: decisions.spawn,
    statusSpawn: status.statusSpawn,
  };
}

/** `codex login status` reports the login method on stderr; keep only that line, withhold anything else. */
export const codexLoginOnly = (frames: Frame[]): Frame[] => {
  const line = frames
    .map((frame) => frame.data.trim())
    .find((data) => /^(Logged in using (ChatGPT|an API key)|Not logged in)$/.test(data));
  return [
    {
      after: 0,
      stream: 'stderr',
      data: line ?? 'VCR: unrecognized login status withheld',
    },
  ];
};

/** The Codex worker's subscription gate: the real `codex login status` on the account's login. */
export function recordedCodexStatus(names: string[], vcr = codexVcr()) {
  queueAll(vcr, 'login-status', names);
  const status = new ProcessCassettes(vcr, 'login-status', {
    argv: ['codex', 'login', 'status'],
    sanitize: codexLoginOnly,
    recordOnce: true,
    model: () => undefined,
    env: () => nativeTextEnvironment(process.env),
  });
  return {
    vcr,
    get statusChecks() {
      return status.launches.length;
    },
    statusSpawn: status.statusSpawn,
  };
}

/** Primed Codex decisions: one warm `codex app-server` (JSON-RPC) serves every role's session. */
export function recordedAppServerTransport(names: string[], vcr = codexVcr()) {
  queueAll(vcr, 'primed', names);
  const server = new ProcessCassettes(vcr, 'primed', { model: LIVE.codexModel });
  return { vcr, launches: server.launches, spawn: server.spawn };
}

/** Replay proves it matches live: record stores the live conclusion, replay compares against it. */
export async function sameAsLive<T>(
  vcr: VCR,
  name: string,
  value: T,
): Promise<{ live: T; now: T }> {
  const live = await vcr.queue('outcome', name).outcome('outcome', value);
  return { live, now: JSON.parse(JSON.stringify(value)) as T };
}

/**
 * `muse serve` as a cassette: agent-session's MuseSession takes a `connect` in place of the SDK's
 * owned spawn, so this runs the same handshake (initialize, then `initialized`) over a recorded
 * process. Command ids come from a counter, because replay compares every stdin line with the
 * recording; one connection per launch keeps them unique within a live session.
 */
/** `usage/changed` names the plan by an opaque numeric id; the cassette keeps the windows, not the id. */
export const museUsageTierHidden = (frames: Frame[]): Frame[] =>
  frames.map((frame) => {
    if (!frame.data.includes('"usage/changed"')) return frame;
    try {
      const value = JSON.parse(frame.data) as { params?: Record<string, unknown> };
      if (value.params && 'tier' in value.params) value.params.tier = '{{tier}}';
      return { ...frame, data: JSON.stringify(value) };
    } catch {
      return frame;
    }
  });

export function recordedMuseConnect(names: string[], vcr = museVcr()) {
  for (const name of names) vcr.queue('serve', name);
  const server = new ProcessCassettes(vcr, 'serve', {
    model: LIVE.museModel,
    sanitize: museUsageTierHidden,
  });
  const connect: MuseConnect = async (launch) => {
    const child = server.spawn([launch.museBin, ...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
    });
    const transport: DuplexTransport = {
      incoming: lines(child.stdout),
      async write(chunk) {
        child.stdin.write(chunk);
        child.stdin.flush();
      },
      // The connection closes on the host's EOF. A live host exits on stdin EOF; a cassette ends
      // only when killed, so the recording is killed too and both runs end the same way.
      close() {
        child.stdin.end();
        child.kill();
      },
    };
    let minted = 0;
    const connection = new Connection(transport, {
      mintCommandId: () => `01a19a00-0000-7000-8000-${(++minted).toString(16).padStart(12, '0')}`,
    });
    // The host's answer is the SDK's InitializeResult; MuseSession checks its version and schema.
    const answer: unknown = await connection.request('initialize', { ...launch.initialize });
    const initializeResult = answer as Awaited<ReturnType<MuseConnect>>['initializeResult'];
    connection.notify('initialized');
    const exited = child.exited;
    return {
      connection,
      initializeResult,
      exited,
      close: async () => {
        await connection.close().catch(() => undefined);
        return exited;
      },
    };
  };
  return { vcr, connect, launches: server.launches };
}

/** The child's stdout as text chunks; the connection does its own newline framing. */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) yield decoder.decode(chunk, { stream: true });
}

/** `muse usage --json` names the plan and its windows; keep only the tier Foundry reads (signed in or not). */
export const museTierOnly = (frames: Frame[]): Frame[] => {
  const stdout = frames
    .filter((frame) => frame.stream === 'stdout')
    .map((frame) => frame.data)
    .join('\n');
  try {
    const tier = (JSON.parse(stdout) as { allowance?: { tier?: unknown } }).allowance?.tier;
    return [
      {
        after: 0,
        stream: 'stdout',
        data: JSON.stringify({ allowance: typeof tier === 'string' ? { tier } : null }),
      },
    ];
  } catch {
    return [{ after: 0, stream: 'stdout', data: 'VCR: unparseable usage withheld' }];
  }
};

/** The Muse worker's subscription gate: the real `muse usage --json` (no model turn) on the account's login. */
export function recordedMuseStatus(names: string[], vcr = museVcr()) {
  for (const name of names) vcr.queue('usage', name);
  const status = new ProcessCassettes(vcr, 'usage', {
    argv: ['muse', 'usage', '--json'],
    sanitize: museTierOnly,
    recordOnce: true,
    model: () => undefined,
    env: () => ({ ...nativeTextEnvironment(process.env), MUSE_NO_AUTO_UPDATE: '1' }),
  });
  return {
    vcr,
    get statusChecks() {
      return status.launches.length;
    },
    statusSpawn: status.statusSpawn,
  };
}
