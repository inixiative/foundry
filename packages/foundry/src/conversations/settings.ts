/**
 * @atlas
 * @kind helper
 * @partOf feature:conversations, primitive:settings
 */
import type { ProjectSettingsConfig } from '../viewer/config';
import { readRepositorySettings, type SettingLayer, settingLayer } from '../viewer/config-resolve';
import {
  type ConversationSettings,
  type ConversationSettingsInput,
  DEFAULT_CONVERSATION_SETTINGS,
  SHARED_CONVERSATION_DEFAULTS,
} from './types';

/** Where each effective `conversations` value came from: the cascade's layer, or the thread itself. */
export type ConversationSettingSource = SettingLayer | 'thread' | 'shared';

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
        agents: over.agents ?? base.agents,
        commissionHours: over.commissionHours ?? base.commissionHours,
      }
    : base;

/**
 * The cascade (§4.6): default (or the shared defaults, once the thread has a member) → the
 * repository's `.foundry/project.json` → this machine's project settings → the thread's own overrides. A thread outside any project has only the default and its
 * own overrides. An unreadable repository file contributes nothing (the viewer reports it).
 */
export function resolveConversationSettings(
  project: Pick<ProjectSettingsConfig, 'path' | 'conversations'> | undefined,
  thread: ConversationSettingsInput | undefined,
  shared = false,
): { settings: ConversationSettings; floorFrom: ConversationSettingSource } {
  const repository = project ? readRepositorySettings(project.path)?.conversations : undefined;
  const base = shared ? SHARED_CONVERSATION_DEFAULTS : DEFAULT_CONVERSATION_SETTINGS;
  const settings = merge(merge(merge(base, repository), project?.conversations), thread);
  const floorFrom: ConversationSettingSource = thread?.floor
    ? 'thread'
    : project?.conversations?.floor
      ? 'settings'
      : repository?.floor
        ? 'repository'
        : shared
          ? 'shared'
          : 'default';
  return { settings, floorFrom };
}

/** Where each field of a project's effective `conversations` setting comes from (the settings view). */
export function conversationSettingSources(
  project: Pick<ProjectSettingsConfig, 'path' | 'conversations'>,
): Record<'floor' | 'maxAgentTurns' | 'holdSeconds' | 'agentMayPass', SettingLayer> {
  const repository = readRepositorySettings(project.path)?.conversations;
  const mine = project.conversations;
  const from = settingLayer;
  return {
    floor: from(mine?.floor !== undefined, repository?.floor !== undefined),
    maxAgentTurns: from(mine?.maxAgentTurns !== undefined, repository?.maxAgentTurns !== undefined),
    holdSeconds: from(
      mine?.conch?.holdSeconds !== undefined,
      repository?.conch?.holdSeconds !== undefined,
    ),
    agentMayPass: from(
      mine?.conch?.agentMayPass !== undefined,
      repository?.conch?.agentMayPass !== undefined,
    ),
  };
}
