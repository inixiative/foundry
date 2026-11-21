/**
 * @atlas
 * @kind adapter
 * @partOf primitive:vcr
 */
// Foundry's stdio process cassette seam over @inixiative/vcr/process: adds Foundry's live
// account environment resolution, Claude stream-json control protocol ID remapping, and
// observed-model extraction for Claude and Codex app-server recordings.
import { lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVcrProcessSpawner,
  type ProcessFrame,
  type ProcessLaunch,
  type ProcessLineProtocol,
  type ProcessLineProtocolSession,
  type ProcessSpawnOptions,
  type ProcessTranscript,
  type RecordedProcess,
  type VcrProcessSpawner,
} from '@inixiative/vcr/process';
import { writeCredentialHome } from '../providers/private-profile';
import { accountHome } from './scrub';
import type { VCR } from './vcr';

export type Frame = ProcessFrame;
export type Launch = Omit<ProcessLaunch, 'argv'> & { argv: string[] };
export type SpawnOptions = ProcessSpawnOptions;
export type { ProcessTranscript, RecordedProcess };

type Options = {
  /** Status probes that Foundry spawns without argv (`statusSpawn(selection)`) name the command here. */
  argv?: readonly string[];
  /** Reduces raw output to what Foundry reads (auth status prints the account); generic scrubbing follows. */
  sanitize?: (frames: Frame[]) => Frame[];
  /** Environment for `statusSpawn` probes; the providers compose theirs from an allowlist. */
  env?: () => Record<string, string | undefined>;
  /** Record at most once per live run and replay that recording afterwards (status probes many tests share). */
  recordOnce?: boolean;
  /** Model the recording ran on, stamped into the cassette. */
  model?: string | ((transcript: ProcessTranscript) => string | undefined);
};

const credentialHome = (home: string): boolean => {
  try {
    return lstatSync(join(home, 'auth.json')).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The account's own login, whatever temporary profile, HOME or XDG_CONFIG_HOME (Muse Code) a test
 * composed for Foundry. A composed private Codex home stays private: it runs live on a copy of its
 * config with the account's login linked in. */
export function liveEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const live: Record<string, string | undefined> = { ...env, HOME: accountHome() };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) {
    const value = live[key];
    if (
      value &&
      (value.startsWith(tmpdir()) ||
        value.startsWith('/private/var/') ||
        value.startsWith('/var/folders/'))
    ) {
      delete live[key];
      if (key === 'CODEX_HOME' && credentialHome(value)) {
        writeCredentialHome(
          `${value}-live`,
          join(accountHome(), '.codex'),
          readFileSync(join(value, 'config.toml'), 'utf8'),
        );
        live.CODEX_HOME = `${value}-live`;
      }
    }
  }
  if (process.env.FOUNDRY_VCR_PATH) live.PATH = process.env.FOUNDRY_VCR_PATH;
  return live;
}

/** The model a CLI reported: Claude's init `model`, app-server's thread `model`. */
export function observedModel(transcript: ProcessTranscript): string | undefined {
  for (const frame of transcript.frames) {
    try {
      const event = JSON.parse(frame.data) as Record<string, unknown>;
      if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
        return event.model;
      }
      const result = event.result as Record<string, unknown> | undefined;
      if (result && typeof result.model === 'string' && result.thread) return result.model;
    } catch {
      /* Not JSON. */
    }
  }
  return undefined;
}

type JsonRpcRecord = {
  id?: string | number;
  method?: string;
  type?: string;
  request_id?: string;
  response?: { request_id?: string };
  request?: { subtype?: string; hooks?: unknown; callback_id?: string };
  uuid?: unknown;
  command_uuid?: unknown;
};

const parseJsonLine = (line: string): JsonRpcRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRpcRecord)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The client's own request id: JSON-RPC `id`, or a Claude control request's `request_id`. */
const clientRequestId = (value: JsonRpcRecord | undefined): string | number | undefined =>
  value?.method !== undefined && value.id !== undefined
    ? value.id
    : value?.type === 'control_request' && typeof value.request_id === 'string'
      ? value.request_id
      : undefined;

/** Hook callback ids a Claude control `initialize` registers: the client's choice, like request ids. */
const hookCallbackIds = (value: JsonRpcRecord | undefined): string[] => {
  const req = value?.request;
  if (value?.type !== 'control_request' || req?.subtype !== 'initialize') return [];
  return (
    JSON.stringify(req.hooks ?? {})
      .match(/"hookCallbackIds":\[([^\]]*)\]/g)
      ?.flatMap((group) =>
        [...group.matchAll(/"([^"]+)"/g)]
          .map((match) => match[1])
          .filter((item): item is string => typeof item === 'string')
          .slice(1),
      ) ?? []
  );
};

/** The uuid a Claude user message carries: the client's choice, echoed back in `command_lifecycle` frames. */
const promptUuid = (value: JsonRpcRecord | undefined): string | undefined =>
  value?.type === 'user' && typeof value.uuid === 'string' ? value.uuid : undefined;

/** Line protocol extending JSON-RPC with Claude stream-json control requests, hook callback IDs, and prompt UUIDs. */
export const claudeLineProtocol: ProcessLineProtocol = {
  createSession(): ProcessLineProtocolSession {
    const ids = new Map<string, string | number>();
    const hooks = new Map<string, string>();
    const prompts = new Map<string, string>();

    return {
      comparableStdinLine(line: string): string {
        const value = parseJsonLine(line);
        if (value && promptUuid(value) !== undefined) {
          const { uuid: _uuid, ...rest } = value;
          return JSON.stringify(rest);
        }
        if (!value || clientRequestId(value) === undefined) return line.trim();
        const { id: _id, request_id: _requestId, ...rest } = value;
        let comparable = JSON.stringify(rest);
        for (const callback of hookCallbackIds(value)) {
          comparable = comparable.replaceAll(`"${callback}"`, '"<hook>"');
        }
        return comparable;
      },
      observeStdinPair(recordedLine: string, liveLine: string): void {
        const recorded = parseJsonLine(recordedLine);
        const live = parseJsonLine(liveLine);
        const recordedId = clientRequestId(recorded);
        const liveId = clientRequestId(live);
        if (recordedId !== undefined && liveId !== undefined) {
          ids.set(String(recordedId), liveId);
        }
        const recordedPrompt = promptUuid(recorded);
        const livePrompt = promptUuid(live);
        if (recordedPrompt !== undefined && livePrompt !== undefined) {
          prompts.set(recordedPrompt, livePrompt);
        }
        const recordedHooks = hookCallbackIds(recorded);
        const liveHooks = hookCallbackIds(live);
        for (let i = 0; i < recordedHooks.length; i++) {
          const rec = recordedHooks[i];
          const cur = liveHooks[i];
          if (rec && cur) hooks.set(rec, cur);
        }
      },
      remapOutputLine(line: string): string {
        const value = parseJsonLine(line);
        if (!value) return line;
        if (
          value.type === 'command_lifecycle' &&
          typeof value.command_uuid === 'string' &&
          prompts.has(value.command_uuid)
        ) {
          return JSON.stringify({ ...value, command_uuid: prompts.get(value.command_uuid) });
        }
        const callback = value.request;
        if (
          value.type === 'control_request' &&
          callback?.subtype === 'hook_callback' &&
          typeof callback.callback_id === 'string' &&
          hooks.has(callback.callback_id)
        ) {
          return JSON.stringify({
            ...value,
            request: { ...callback, callback_id: hooks.get(callback.callback_id) },
          });
        }
        const controlId =
          value.type === 'control_response' ? value.response?.request_id : undefined;
        if (controlId !== undefined && ids.has(controlId)) {
          return JSON.stringify({
            ...value,
            response: { ...value.response, request_id: ids.get(controlId) },
          });
        }
        if (value.method !== undefined || value.id === undefined || !ids.has(String(value.id))) {
          return line;
        }
        return JSON.stringify({ ...value, id: ids.get(String(value.id)) });
      },
    };
  },
};

/** A spawn seam backed by queued cassettes: `vcr.queue(method, name)` once per expected launch. */
export class ProcessCassettes {
  private readonly spawner: VcrProcessSpawner;

  constructor(vcr: VCR, method: string, options: Options = {}) {
    this.spawner = createVcrProcessSpawner(vcr.recorder, method, {
      argv: options.argv,
      sanitizeFrames: options.sanitize,
      probeEnv: options.env,
      transformLiveEnv: liveEnvironment,
      recordOnce: options.recordOnce,
      model: typeof options.model === 'function' ? options.model : (options.model ?? observedModel),
      lineProtocol: claudeLineProtocol,
    });
  }

  get launches(): Launch[] {
    return this.spawner.launches as Launch[];
  }

  get writes(): number {
    return this.spawner.writes;
  }

  spawn = (argv: readonly string[], options: SpawnOptions): RecordedProcess =>
    this.spawner.spawn(argv, options);

  /** `statusSpawn(selection)`: the command and environment are fixed by the cassette, so they come from options. */
  statusSpawn = (_selection?: unknown): RecordedProcess => this.spawner.spawnProbe();
}
