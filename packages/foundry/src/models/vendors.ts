/**
 * @atlas
 * @kind config
 * @partOf primitive:modelRegistry
 */
/**
 * Vendor settings: one entry per vendor (Anthropic, OpenAI, Google, ...), each with a subscription
 * mode and an API mode, either or both on. The registry's providers stay the transports: a vendor's
 * subscription mode is served by its native CLI provider (claude-code, codex) and its API mode by
 * its API provider (anthropic, openai, gemini, ...), so `providerEnabled` answers for a provider id
 * the way `providers[id].enabled` used to.
 *
 * Settings saved before vendors carry `providers` (one entry per transport); `migrateProviderSettings`
 * turns them into vendors on load, and the next save writes the vendor shape.
 */

import {
  MODEL_REGISTRY,
  MODEL_VENDORS,
  type ModelVendor,
  type ProviderMode,
  vendorModeProvider,
  vendorOfProvider,
} from '@inixiative/foundry-core';
import type { ClaudeContextBudget } from '../providers/claude-context-budget';

export interface VendorSubscriptionSettings {
  enabled: boolean;
  /** Claude Code native compaction policy (Anthropic only); defaults to 200k / 80%. */
  contextBudget?: ClaudeContextBudget | false;
}
export interface VendorApiSettings {
  enabled: boolean;
  /** API root override for a proxy, a mainland endpoint or a local port; absent: the registry's. */
  baseUrl?: string;
}
export interface VendorSettings {
  /** The vendor's own switch. Off turns every mode off and remembers which modes were on. */
  enabled: boolean;
  subscription?: VendorSubscriptionSettings;
  api?: VendorApiSettings;
}
export type VendorSettingsMap = Record<string, VendorSettings>;

/** What `vendors` replaced: one entry per transport provider. Read only to migrate it. */
export interface LegacyProviderSettings {
  enabled?: boolean;
  baseUrl?: string;
  contextBudget?: ClaudeContextBudget | false;
}

type VendorConfig = { vendors?: VendorSettingsMap };

const vendorById = new Map(MODEL_VENDORS.map((vendor) => [vendor.id, vendor]));

/** Whether a vendor's mode can run at all: a transport exists for it. */
export function modeAvailable(vendor: ModelVendor, mode: ProviderMode): boolean {
  return !!vendorModeProvider(vendor, mode);
}

/** Every vendor at its registry default: a mode is on when its provider is enabled by default. */
export function vendorSettingsFromRegistry(): VendorSettingsMap {
  return Object.fromEntries(
    MODEL_VENDORS.map((vendor) => {
      const settings: VendorSettings = { enabled: false };
      for (const mode of ['subscription', 'api'] as const) {
        const provider = vendorModeProvider(vendor, mode);
        if (!provider) continue;
        const enabled = MODEL_REGISTRY[provider]?.enabledByDefault ?? false;
        settings[mode] = { enabled };
        if (enabled) settings.enabled = true;
      }
      return [vendor.id, settings];
    }),
  );
}

/** Saved vendor settings over the registry defaults, mode by mode; unknown vendors are kept for validation to refuse. */
export function mergeVendorSettings(
  defaults: VendorSettingsMap,
  saved: VendorSettingsMap | undefined,
): VendorSettingsMap {
  const merged: VendorSettingsMap = {};
  for (const [id, base] of Object.entries(defaults)) {
    const own = saved?.[id];
    merged[id] = {
      ...base,
      ...own,
      enabled: own?.enabled ?? base.enabled,
      ...(base.subscription || own?.subscription
        ? {
            subscription: {
              ...base.subscription,
              ...own?.subscription,
            } as VendorSubscriptionSettings,
          }
        : {}),
      ...(base.api || own?.api ? { api: { ...base.api, ...own?.api } as VendorApiSettings } : {}),
    };
  }
  for (const [id, own] of Object.entries(saved ?? {})) if (!(id in merged)) merged[id] = own;
  return merged;
}

/**
 * Pre-vendor `providers` settings as vendors. A mode takes its provider's `enabled`; a vendor is on
 * when any of its modes is. A `baseUrl` equal to the registry's root was a seeded copy, not an
 * override, and is dropped. Providers outside the registry ran nothing and are reported as dropped.
 */
export function migrateProviderSettings(providers: Record<string, LegacyProviderSettings>): {
  vendors: VendorSettingsMap;
  dropped: string[];
} {
  const vendors = vendorSettingsFromRegistry();
  const dropped: string[] = [];
  for (const [id, saved] of Object.entries(providers)) {
    const served = vendorOfProvider(id);
    if (!served) {
      dropped.push(id);
      continue;
    }
    const vendor = vendors[served.vendor.id]!;
    if (served.mode === 'subscription') {
      vendor.subscription = {
        enabled: saved?.enabled ?? vendor.subscription?.enabled ?? false,
        ...(saved?.contextBudget !== undefined ? { contextBudget: saved.contextBudget } : {}),
      };
    } else {
      const root = MODEL_REGISTRY[id]?.apiRoot;
      const baseUrl = saved?.baseUrl?.trim();
      vendor.api = {
        enabled: saved?.enabled ?? vendor.api?.enabled ?? false,
        ...(baseUrl && baseUrl !== root ? { baseUrl } : {}),
      };
    }
  }
  for (const vendor of Object.values(vendors))
    vendor.enabled = !!(vendor.subscription?.enabled || vendor.api?.enabled);
  return { vendors, dropped };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Refuses unknown vendors, a mode the vendor does not have, a coming-soon mode switched on, and malformed fields. */
export function validateVendorSettings(vendors: unknown): void {
  if (!isRecord(vendors)) throw Error('vendors must be an object keyed by vendor id');
  for (const [id, settings] of Object.entries(vendors)) {
    const vendor = vendorById.get(id);
    const at = `vendors.${id}`;
    if (!vendor)
      throw Error(`${at} is not a known vendor (${MODEL_VENDORS.map((v) => v.id).join(', ')})`);
    if (!isRecord(settings)) throw Error(`${at} must be { enabled, subscription?, api? }`);
    for (const key of Object.keys(settings))
      if (!['enabled', 'subscription', 'api'].includes(key))
        throw Error(`${at}.${key} is not a vendor setting (enabled, subscription, api)`);
    if (typeof settings.enabled !== 'boolean') throw Error(`${at}.enabled must be true or false`);
    for (const mode of ['subscription', 'api'] as const) {
      const value = settings[mode];
      if (value === undefined) continue;
      if (!isRecord(value)) throw Error(`${at}.${mode} must be { enabled, ... }`);
      if (!vendor[mode]) throw Error(`${vendor.label} has no ${mode} mode`);
      if (typeof value.enabled !== 'boolean')
        throw Error(`${at}.${mode}.enabled must be true or false`);
      const allowed =
        mode === 'subscription' ? ['enabled', 'contextBudget'] : ['enabled', 'baseUrl'];
      for (const key of Object.keys(value))
        if (!allowed.includes(key))
          throw Error(`${at}.${mode}.${key} is not a ${mode} setting (${allowed.join(', ')})`);
      if (mode === 'subscription' && value.enabled && !modeAvailable(vendor, mode))
        throw Error(
          `${vendor.label} subscription mode is coming soon: Foundry has no transport for it yet`,
        );
      if (mode === 'subscription' && value.contextBudget !== undefined) {
        if (vendorModeProvider(vendor, mode) !== 'claude-code')
          throw Error(`${at}.subscription.contextBudget applies to Claude Code only`);
        if (value.contextBudget !== false && !isRecord(value.contextBudget))
          throw Error(
            `${at}.subscription.contextBudget must be { maxTokens?, compactAt? } or false`,
          );
      }
      if (mode === 'api' && value.baseUrl !== undefined) {
        let url: URL | undefined;
        try {
          url = typeof value.baseUrl === 'string' ? new URL(value.baseUrl) : undefined;
        } catch {}
        if (!url || !['http:', 'https:'].includes(url.protocol))
          throw Error(`${at}.api.baseUrl must be an http(s) URL`);
      }
    }
  }
}

/** The vendor-mode settings behind a registry provider, or undefined when it is not registered. */
function modeSettings(config: VendorConfig, providerId: string) {
  const served = vendorOfProvider(providerId);
  if (!served) return undefined;
  const vendor = config.vendors?.[served.vendor.id];
  return { vendor, mode: vendor?.[served.mode] };
}

/** Whether a registry provider is on: its vendor is on and so is the mode it serves. */
export function providerEnabled(config: VendorConfig, providerId: string): boolean {
  const settings = modeSettings(config, providerId);
  return !!(settings?.vendor?.enabled && settings.mode?.enabled);
}

/** Every registry provider that is on, in vendor order. */
export function enabledProviderIds(config: VendorConfig): string[] {
  return MODEL_VENDORS.flatMap((vendor) =>
    (['subscription', 'api'] as const).flatMap((mode) => {
      const provider = vendorModeProvider(vendor, mode);
      return provider && providerEnabled(config, provider) ? [provider] : [];
    }),
  );
}

/** The user's API root override for a provider; undefined means the registry's own root. */
export function providerBaseUrl(config: VendorConfig, providerId: string): string | undefined {
  const mode = modeSettings(config, providerId)?.mode as VendorApiSettings | undefined;
  return mode?.baseUrl;
}

/** Claude Code's native compaction policy, from the Anthropic subscription mode. */
export function providerContextBudget(
  config: VendorConfig,
  providerId: string,
): ClaudeContextBudget | false | undefined {
  const mode = modeSettings(config, providerId)?.mode as VendorSubscriptionSettings | undefined;
  return mode?.contextBudget;
}

/** A settings patch over vendors: each named vendor's fields and modes merge over what is saved. */
export function patchVendorSettings(
  current: VendorSettingsMap,
  patch: Record<string, unknown>,
): VendorSettingsMap {
  const next = structuredClone(current);
  for (const [id, change] of Object.entries(patch)) {
    if (!isRecord(change)) {
      next[id] = change as unknown as VendorSettings;
      continue;
    }
    const base = next[id] ?? ({ enabled: false } as VendorSettings);
    const merged: VendorSettings = { ...base, ...(change as Partial<VendorSettings>) };
    for (const mode of ['subscription', 'api'] as const)
      if (isRecord(change[mode])) {
        // A null field clears it (an API root override back to the registry's).
        const fields = Object.entries({ ...base[mode], ...change[mode] }).filter(
          ([, value]) => value !== null,
        );
        merged[mode] = Object.fromEntries(fields) as never;
      }
    next[id] = merged;
  }
  return next;
}
