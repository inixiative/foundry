/**
 * @atlas
 * @kind helper
 * @partOf feature:conversations, primitive:settings
 */
import type { ProjectSettingsConfig } from '../viewer/config';
import { readRepositorySettings, type SettingLayer } from '../viewer/config-resolve';
import {
  type ConversationSettings,
  type ConversationSettingsInput,
  DEFAULT_CONVERSATION_SETTINGS,
} from './types';

/** Where each effective `conversations` value came from: the cascade's layer, or the thread itself. */
export type ConversationSettingSource = SettingLayer | 'thread';

const merge = (
  base: ConversationSettings,
  over: ConversationSettingsInput | undefined,
): ConversationSettings =>
  over
    ? {
        floor: over.floor ?? base.floor,
        maxAgentTurns: over.maxAgentTurns ?? base.maxAgentTurns,
        conch: {
          holdSeconds: over.conch?.holdSeconds ?? base.conch.holdSeconds,
          agentMayPass: over.conch?.agentMayPass ?? base.conch.agentMayPass,
        },
      }
    : base;

/**
 * The cascade (§4.6): default → the repository's `.foundry/project.json` → this machine's project
 * settings → the thread's own overrides. A thread outside any project has only the default and its
 * own overrides. An unreadable repository file contributes nothing (the viewer reports it).
 */
export function resolveConversationSettings(
  project: Pick<ProjectSettingsConfig, 'path' | 'conversations'> | undefined,
  thread: ConversationSettingsInput | undefined,
): { settings: ConversationSettings; floorFrom: ConversationSettingSource } {
  const repository = project ? readRepositorySettings(project.path)?.conversations : undefined;
  const settings = merge(
    merge(merge(DEFAULT_CONVERSATION_SETTINGS, repository), project?.conversations),
    thread,
  );
  const floorFrom: ConversationSettingSource = thread?.floor
    ? 'thread'
    : project?.conversations?.floor
      ? 'settings'
      : repository?.floor
        ? 'repository'
        : 'default';
  return { settings, floorFrom };
}
