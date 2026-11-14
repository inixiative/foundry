/**
 * @atlas
 * @kind constant
 * @partOf feature:threads
 */

import type { ThreadScope } from '../prompts/instruction-settings';
import type { ReadinessNativeCli } from '../readiness';
import type { FoundryConfig } from '../viewer/config';

/**
 * The scope briefs: what a thread in one of Foundry's own scopes is for (Aron, 2026-11-14: "Forge
 * Master and Feedback should just be threads … with their own sort of system prompts or scopes").
 * The scope is the thread's role (`forge-master`, `feedback`); its brief is held once as a standing
 * layer, beside the session briefing, and re-read each turn so a changed configuration reaches the
 * thread as a replacing version, while an unchanged one is not sent again.
 */
export const SCOPE_BRIEF_LAYER = 'scope-brief';

/** The Forge Master's standing brief: Foundry self-help, with this install's configuration. */
export function forgeMasterBrief(config: FoundryConfig, nativeClis?: ReadinessNativeCli[]): string {
  const names = (record: Record<string, unknown> | undefined) => Object.keys(record ?? {});
  const list = (ids: string[]) => `${ids.length}: ${ids.join(', ') || 'none'}`;
  return [
    '# Forge Master',
    '',
    "This thread is the Forge Master: the person's helper for customizing and understanding their own Foundry install. It runs in the Foundry repository with the full tool surface, so investigate (read the settings, the code and the docs, run `bun run doctor`) before you answer.",
    '',
    "Settings live in `.foundry/settings.json` and are edited from the viewer's Settings pages; every committed change is a row in `.foundry/audit.jsonl`. When you suggest a change, name the key and show the JSON patch. Prefer the viewer for edits the person makes; edit files yourself only when asked.",
    '',
    '## This install',
    `- Default executor: ${config.defaults.provider}/${config.defaults.model}`,
    `- Classifier: ${config.defaults.classifierProvider ?? config.defaults.provider}/${config.defaults.classifierModel ?? config.defaults.model}`,
    `- Agents (${list(names(config.agents))})`,
    `- Layers (${list(names(config.layers))})`,
    `- Projects (${list(names(config.projects))})`,
    ...(nativeClis ? ['', ...nativeCliStatus(nativeClis)] : []),
  ].join('\n');
}

/** What `bun run doctor` reports as `nativeClis`, located again when the brief is read. */
function nativeCliStatus(nativeClis: ReadinessNativeCli[]): string[] {
  return [
    '## Native runtime CLIs',
    "Located by the resolver `bun run setup`, `bun run doctor` and the daemon installer share (on PATH, else the newest working install, app bundles such as /Applications/Codex.app included). One found off PATH is already on this running Foundry's PATH.",
    ...nativeClis.map((native) => {
      const runs = native.provider ?? 'decisions';
      return native.binary
        ? `- ${native.cli} (${runs}): ${native.binary}${native.version ? ` ${native.version}` : ''}`
        : `- ${native.cli} (${runs}): NOT FOUND${native.used ? ', and this Foundry launches it' : ''}`;
    }),
    'When one is missing, tell the person to install it or disable its provider (show the settings patch). A LaunchAgent install that refused for a missing CLI takes `bun run daemon:install` again once the doctor finds it.',
  ];
}

/** The Feedback thread's standing brief: work through the feedback inbox with the person. */
export const FEEDBACK_BRIEF = `# Feedback

This thread is a Feedback thread: you work through Foundry's feedback inbox with the person. Each item is a piece of feedback they gave while working (\`/feedback\`, \`/correction\`, or captured from a turn), with its statement, its origin thread and turn, where it was routed (a Warden or a thread role), and its status. The viewer shows the inbox beside this thread.

- **Read before you suggest.** \`feedback_inbox\` lists items (filter by project or status), \`feedback_item\` reads one in full with its routing, tuning and recurrences. Read an item's origin (\`foundry_threads\`, the journal) when the statement alone is unclear.
- **Work it with the person.** Say what the item asks for, whether it recurs, and where the fix belongs: the doc or region that owns it, a role file, a Warden brief. Propose the change; make it when they agree.
- **Keep the inbox true.** \`feedback_status\` archives items that are dealt with or dropped and reopens archived ones. Answering an item's tuning prompts stays the person's, in the inbox.`;

/** The brief a scope's thread holds; the forge brief reads the live configuration. */
export function scopeBrief(
  scope: ThreadScope,
  config: FoundryConfig,
  nativeClis?: ReadinessNativeCli[],
): string {
  return scope === 'forge' ? forgeMasterBrief(config, nativeClis) : FEEDBACK_BRIEF;
}
