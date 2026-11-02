import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODEL_REGISTRY,
  MODEL_VENDORS,
  vendorModeProvider,
  vendorOfProvider,
} from '@inixiative/foundry-core';
import {
  enabledProviderIds,
  patchVendorSettings,
  providerContextBudget,
  providerEnabled,
  validateVendorSettings,
  vendorSettingsFromRegistry,
} from '../src/models/vendors';
import { ConfigStore, defaultConfig, validateConfig } from '../src/viewer/config';

test('every registry provider serves exactly one vendor mode, and the five main labs lead', () => {
  for (const id of Object.keys(MODEL_REGISTRY)) {
    const served = MODEL_VENDORS.flatMap((vendor) =>
      (['subscription', 'api'] as const).filter((mode) => vendorModeProvider(vendor, mode) === id),
    );
    expect({ id, modes: served.length }).toEqual({ id, modes: 1 });
  }
  expect(MODEL_VENDORS.slice(0, 5).map((vendor) => vendor.id)).toEqual([
    'anthropic',
    'openai',
    'google',
    'meta',
    'xai',
  ]);
  const rest = MODEL_VENDORS.slice(5).map((vendor) => vendor.label);
  expect(rest).toEqual(rest.toSorted((a, b) => a.localeCompare(b)));
  // A subscription mode exists where a native CLI transport does (Muse Code for Meta); Google and xAI are coming.
  expect(vendorOfProvider('claude-code')).toMatchObject({
    vendor: { id: 'anthropic' },
    mode: 'subscription',
  });
  expect(vendorOfProvider('anthropic')).toMatchObject({ vendor: { id: 'anthropic' }, mode: 'api' });
  expect(vendorOfProvider('codex')).toMatchObject({
    vendor: { id: 'openai' },
    mode: 'subscription',
  });
  expect(vendorOfProvider('muse')).toMatchObject({ vendor: { id: 'meta' }, mode: 'subscription' });
  for (const id of ['google', 'xai'])
    expect(MODEL_VENDORS.find((vendor) => vendor.id === id)!.subscription).toEqual({
      comingSoon: true,
    });
});

test('a provider runs only while its vendor and its mode are both on', () => {
  const config = defaultConfig();
  expect(providerEnabled(config, 'claude-code')).toBe(true);
  config.vendors = patchVendorSettings(config.vendors, { anthropic: { enabled: false } });
  expect(providerEnabled(config, 'claude-code')).toBe(false);
  expect(providerEnabled(config, 'anthropic')).toBe(false);
  // The vendor switch remembers which modes were on.
  expect(config.vendors.anthropic!.subscription!.enabled).toBe(true);
  config.vendors = patchVendorSettings(config.vendors, {
    anthropic: { enabled: true, api: { enabled: false } },
  });
  expect(providerEnabled(config, 'claude-code')).toBe(true);
  expect(providerEnabled(config, 'anthropic')).toBe(false);
  expect(enabledProviderIds(config).slice(0, 3)).toEqual(['claude-code', 'codex', 'openai']);
  expect(providerEnabled(config, 'not-registered')).toBe(false);
});

test('vendor settings refuse unknown vendors, missing modes and a coming-soon subscription', () => {
  const ok = vendorSettingsFromRegistry();
  expect(() => validateVendorSettings(ok)).not.toThrow();
  expect(() => validateVendorSettings({ ...ok, acme: { enabled: true } })).toThrow(
    'vendors.acme is not a known vendor',
  );
  expect(() =>
    validateVendorSettings({ ...ok, deepseek: { enabled: true, subscription: { enabled: true } } }),
  ).toThrow('DeepSeek has no subscription mode');
  expect(() =>
    validateVendorSettings({ ...ok, google: { enabled: true, subscription: { enabled: true } } }),
  ).toThrow('Google (Gemini) subscription mode is coming soon');
  // Recorded off, a coming-soon mode is fine: it is how the row remembers the person's choice.
  expect(() =>
    validateVendorSettings({ ...ok, google: { enabled: true, subscription: { enabled: false } } }),
  ).not.toThrow();
  expect(() =>
    validateVendorSettings({
      ...ok,
      openai: { enabled: true, api: { enabled: true, baseUrl: 'x' } },
    }),
  ).toThrow('vendors.openai.api.baseUrl must be an http(s) URL');
  expect(() =>
    validateVendorSettings({
      ...ok,
      openai: { enabled: true, subscription: { enabled: true, contextBudget: {} } },
    }),
  ).toThrow('contextBudget applies to Claude Code only');
  const config = defaultConfig();
  expect(() => validateConfig({ ...config, providers: {} } as unknown as typeof config)).toThrow(
    'settings key "providers" is now "vendors"',
  );
  expect(() => validateConfig({ ...config, installationName: ' ' })).toThrow(
    'installationName must be 1 to 120 characters',
  );
});
