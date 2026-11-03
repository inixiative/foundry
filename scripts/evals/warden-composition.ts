#!/usr/bin/env bun
/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:composition, feature:evals
 */
/**
 * What a region Warden is actually given, layer by layer, with no model call.
 *
 *   bun scripts/evals/warden-composition.ts --project <id | name> [--region <id>] [--cwd <dir>] \
 *     [--foundry-dir ~/code/inixiative/foundry/.foundry] [--enable] [--json]
 *
 * The thread is built as the daemon builds one (`feedback/chorus-advise.ts`, the daemon's settings
 * read, never written), but every decision call is answered `NO_COMMENT` by a capturing provider, so
 * nothing is spent. For each Warden (or the one `--region` names) it prints the first stage's exact
 * input split into its layers: the charter, the instructions slot by composed part (the region's
 * prompt, the project's Warden brief, any CLAUDE.md / AGENTS.md file), the region's knowledge, and
 * the per-call rest (thread context, moment, protocol), each with its characters and ≈tokens (chars/4).
 * --enable turns the project's chorus on in memory, to measure a project whose chorus is off.
 * --show prints the first Warden's exact system prompt (charter and instructions).
 */
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type {
  CompletionOpts,
  CompletionResult,
  LLMMessage,
  LLMProvider,
  SourceSegment,
} from '../../packages/core/src';
import { FileMemory } from '../../packages/core/src/adapters/file-memory';
import {
  atlasRootOf,
  createSourceResolver,
} from '../../packages/foundry/src/agents/thread-factory';
import { WARDEN_CHARTER } from '../../packages/foundry/src/classify';
import { adviseOnce } from '../../packages/foundry/src/feedback/chorus-advise';
import { resolveSubscriptionPolicy } from '../../packages/foundry/src/providers/subscription-policy';
import { ConfigStore } from '../../packages/foundry/src/viewer/config';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    region: { type: 'string' },
    cwd: { type: 'string' },
    'foundry-dir': { type: 'string' },
    json: { type: 'boolean' },
    enable: { type: 'boolean' },
    show: { type: 'boolean' },
  },
  strict: true,
});
if (!values.project) {
  console.error(
    'usage: warden-composition.ts --project <id | name> [--region <id>] [--cwd <dir>] [--json]',
  );
  process.exit(2);
}

const foundryDir = resolve(
  values['foundry-dir'] ?? join(homedir(), 'code', 'inixiative', 'foundry', '.foundry'),
);
const saved = structuredClone(await new ConfigStore(foundryDir).load());
const entry = Object.entries(saved.projects ?? {}).find(
  ([id, p]) =>
    id === values.project ||
    p.label === values.project ||
    basename(p.path ?? '') === values.project,
);
if (!entry) throw Error(`--project ${values.project} is not registered in ${foundryDir}`);
const [projectId, project] = entry;
if (!project.path) throw Error(`project ${projectId} has no path`);
// In memory only: measure a project whose chorus is off as it would compose when turned on.
if (values.enable) project.chorus = { ...project.chorus, enabled: true };
const subscription = resolveSubscriptionPolicy(saved, { startup: true, cwd: tmpdir() });
if (!subscription) throw Error('warden-composition reads the subscription-resolved settings');
const config = subscription.config;

/** Answers every call NO_COMMENT; nothing leaves the machine. */
const silent: LLMProvider = {
  id: 'capture',
  complete: async (_messages: LLMMessage[], _opts?: CompletionOpts): Promise<CompletionResult> => ({
    content: 'NO_COMMENT',
    model: 'capture',
  }),
};
const memory = new FileMemory(join(foundryDir, 'memory'));
await memory.load();
const advice = await adviseOnce({
  config,
  projectId,
  cwd: resolve(values.cwd ?? project.path),
  message: 'Measuring composition only.',
  decisions: silent,
  stageHost: () => silent,
  resolveSource: createSourceResolver({ memory }),
  atlasRoot: atlasRootOf(config),
  warn: () => {},
});

const tokens = (chars: number) => Math.round(chars / 4);
const sizeOf = (segments: readonly SourceSegment[]) => {
  const parts = new Map<string, number>();
  for (const s of segments) {
    const subject = typeof s === 'string' ? '(unattributed)' : s.subject;
    const text = typeof s === 'string' ? s : s.text;
    parts.set(subject, (parts.get(subject) ?? 0) + text.length);
  }
  return [...parts].map(([subject, chars]) => ({ subject, chars, tokens: tokens(chars) }));
};

const rows = advice.decisions
  .filter((d) => !values.region || d.domain === values.region)
  .flatMap((d) => {
    const request = d.request;
    if (!request || !('messages' in request)) return [];
    const [system, user] = request.messages;
    const composition = request.composition;
    const instructions = sizeOf(composition?.instructions ?? []);
    const knowledge = composition?.domainKnowledge ?? [];
    const knowledgeChars = knowledge.reduce(
      (n, s) => n + (typeof s === 'string' ? s.length : s.text.length),
      0,
    );
    const charter = composition?.charter?.text ?? WARDEN_CHARTER;
    const systemChars = system?.content.length ?? 0;
    const userChars = user?.content.length ?? 0;
    return [
      {
        region: d.domain,
        system: { chars: systemChars, tokens: tokens(systemChars) },
        charter: {
          subject: composition?.charter?.subject ?? 'charter:warden',
          chars: charter.length,
          tokens: tokens(charter.length),
        },
        instructions,
        knowledge: {
          chars: knowledgeChars,
          tokens: tokens(knowledgeChars),
          parts: sizeOf(knowledge),
        },
        perCall: {
          chars: Math.max(0, userChars - knowledgeChars),
          tokens: tokens(Math.max(0, userChars - knowledgeChars)),
        },
        total: { chars: systemChars + userChars, tokens: tokens(systemChars + userChars) },
      },
    ];
  });

if (values.show) {
  const first = advice.decisions.find((d) => !values.region || d.domain === values.region);
  const request = first?.request;
  if (request && 'messages' in request) console.log(request.messages[0]?.content);
} else if (values.json)
  console.log(JSON.stringify({ projectId, label: project.label, rows }, null, 2));
else {
  console.log(`${project.label ?? projectId}: ${rows.length} Warden(s)`);
  for (const row of rows.slice(0, values.region ? 1 : 3)) {
    console.log(`\n${row.region}  total ≈${row.total.tokens} tok (system ${row.system.tokens})`);
    console.log(`  charter       ${row.charter.subject}  ≈${row.charter.tokens} tok`);
    for (const part of row.instructions)
      console.log(`  instructions  ${part.subject}  ≈${part.tokens} tok`);
    for (const part of row.knowledge.parts)
      console.log(`  knowledge     ${part.subject}  ≈${part.tokens} tok`);
    console.log(`  per call      ≈${row.perCall.tokens} tok (thread context, moment, protocol)`);
  }
  const ladder = rows.filter((r) =>
    [...r.instructions, ...r.knowledge.parts].some((p) =>
      /CLAUDE(\.local)?\.md|AGENTS\.md/.test(p.subject),
    ),
  );
  console.log(
    `\nWardens whose instructions carry a CLAUDE.md / AGENTS.md file: ${ladder.length} of ${rows.length}`,
  );
}
process.exit(0);
