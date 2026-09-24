// Recorded counterparts of subscription-transport.ts: the same observation surface
// (launches, writes, statusChecks, live/peak), backed by cassettes of the real CLIs.
import { join } from "node:path";
import { nativeTextEnvironment } from "../../src/providers/native-text-environment";
import { VCR, ProcessCassettes, cliVersion, fetchVersion, type Frame, type Launch } from "../../src/vcr";

export const FIXTURES_DIR = join(import.meta.dir, "../fixtures/vcr");

/** What the live tier runs on. The observed Claude model is the alias's canonical name; a change is a finding. */
export const LIVE = {
  claudeModel: "haiku",
  claudeObservedModel: "claude-haiku-4-5-20251001",
  codexModel: "gpt-6-luna",
  kingdomUrl: process.env.FOUNDRY_VCR_KINGDOM_URL ?? "http://127.0.0.1:8200",
} as const;

/** Makes a live model's answer checkable: every live prompt asks for this exact reply. */
export const ANSWER = "accepted-private-answer";
export const answerPrompt = (label = "private-input") => `${label}. Reply with exactly ${ANSWER} and nothing else.`;
/** Decision roles run under Foundry's decision context: a real classification whose answer is unambiguous. */
export const decisionMessages = (input = "private-input") => [
  { role: "system" as const, content: 'Classify the user message. Respond with JSON only, exactly {"category":"feature"}, {"category":"bug"} or {"category":"question"}.' },
  { role: "user" as const, content: `${input}: add a dark mode toggle to the settings page` },
];
export const DECIDED = /"category"\s*:\s*"feature"/;

const vcrs: VCR[] = [];
/** Call from `afterAll` in every file that records: cassettes finish writing after the process exits. */
export const settleRecordings = async () => { await Promise.all(vcrs.map(vcr => vcr.settled())); };
const made = (vcr: VCR) => { vcrs.push(vcr); return vcr; };

export const claudeVcr = () => made(new VCR(join(FIXTURES_DIR, "claude"), { service: "claude", cli: "claude", version: () => cliVersion("claude") }));
export const codexVcr = () => made(new VCR(join(FIXTURES_DIR, "codex"), { service: "codex", cli: "codex", version: () => cliVersion("codex") }));
export const kingdomVcr = () => made(new VCR(join(FIXTURES_DIR, "kingdom"), { service: "kingdom", version: () => fetchVersion(`${LIVE.kingdomUrl}/openapi/docs`) }));

/** `claude auth status --json` prints the account (email, org); keep only what Foundry reads. Output that does
 * not parse is withheld whole (fail closed), never kept as text. */
export const claudeStatusOnly = (frames: Frame[]): Frame[] => {
  const stdout = frames.filter(frame => frame.stream === "stdout").map(frame => frame.data).join("\n");
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    return [{ after: 0, stream: "stdout", data: JSON.stringify({ loggedIn: status.loggedIn, authMethod: status.authMethod }) }];
  } catch { return [{ after: 0, stream: "stdout", data: "VCR: unparseable auth status withheld" }]; }
};
/** `codex login status` reports the login method on stderr; nothing else is kept. */
export const codexLoginOnly = (frames: Frame[]): Frame[] =>
  frames.filter(frame => /^(Logged in using|Not logged in)/.test(frame.data)).map(frame => ({ ...frame, data: frame.data.replace(/ - .*/, "") }));

type Names = { decision?: string[]; status?: string[] };
const queueAll = (vcr: VCR, method: string, names: string[] = []) => { for (const name of names) vcr.queue(method, name); };

/** Claude text decisions: `claude auth status --json`, then one stream-json process per call. */
export function recordedClaudeTransport(names: Names, vcr = claudeVcr()) {
  queueAll(vcr, "decision", names.decision); queueAll(vcr, "auth-status", names.status);
  const decisions = new ProcessCassettes(vcr, "decision");
  const status = new ProcessCassettes(vcr, "auth-status", { argv: ["claude", "auth", "status", "--json"], sanitize: claudeStatusOnly, recordOnce: true, model: () => undefined, env: () => nativeTextEnvironment(process.env) });
  return { vcr, launches: decisions.launches as Launch[], get writes() { return decisions.writes; }, get statusChecks() { return status.launches.length; },
    spawn: decisions.spawn, statusSpawn: status.statusSpawn };
}

/** Codex decisions: `codex login status`, then one `codex exec --json` process per call. */
export function recordedCodexTransport(names: Names, vcr = codexVcr()) {
  queueAll(vcr, "decision", names.decision); queueAll(vcr, "login-status", names.status);
  const decisions = new ProcessCassettes(vcr, "decision", { model: LIVE.codexModel });
  const status = new ProcessCassettes(vcr, "login-status", { argv: ["codex", "login", "status"], sanitize: codexLoginOnly, recordOnce: true, model: () => undefined, env: () => nativeTextEnvironment(process.env) });
  let live = 0, peak = 0;
  return { vcr, launches: decisions.launches, get statusChecks() { return status.launches.length; }, get live() { return live; }, get peak() { return peak; },
    statusSpawn: status.statusSpawn,
    spawn: (argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) => {
      const child = decisions.spawn(argv, options);
      live++; peak = Math.max(peak, live);
      void child.exited.then(() => { live--; });
      return child;
    } };
}

/** Replay proves it matches live: record stores the live conclusion, replay compares against it. */
export async function sameAsLive<T>(vcr: VCR, name: string, value: T): Promise<{ live: T; now: T }> {
  const live = await vcr.queue("outcome", name).outcome("outcome", value);
  return { live, now: JSON.parse(JSON.stringify(value)) as T };
}
