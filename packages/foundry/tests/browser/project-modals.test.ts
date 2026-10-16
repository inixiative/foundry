import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
  TokenTracker,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../../src/agents/project';
import { startViewer } from '../../src/viewer/server';
import { type ReleaseStep, releaseAll } from '../helpers/release-all';

// The setup wizard, Add project and Rename project are closable modals; a project's menu renames and archives it.
const { chromium } = createRequire(import.meta.url)(
  process.env.FOUNDRY_QA_PLAYWRIGHT ?? 'playwright',
);

async function open(cleanup: ReleaseStep[]) {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-project-modals-'));
  cleanup.push(['dir', () => rmSync(dir, { recursive: true, force: true })]);
  const viewer = await startViewer({
    port: 0,
    configDir: dir,
    localStore: null,
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    tokenTracker: new TokenTracker(),
    projectRegistry: new ProjectRegistry(),
  });
  cleanup.unshift(['viewer', () => viewer.server.stop(true)]);
  const browser = await chromium.launch({ headless: true });
  cleanup.unshift(['browser', () => browser.close()]);
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  return { dir, origin: `http://127.0.0.1:${viewer.server.port}`, page, errors };
}

test('the setup wizard closes with X or Escape, and a failed save stays on an editable step', async () => {
  const cleanup: ReleaseStep[] = [];
  try {
    const { origin, page, errors } = await open(cleanup);
    const wizard = page.getByRole('dialog', { name: 'Setup' });

    await page.goto(origin);
    await wizard.waitFor();
    await page.keyboard.press('Escape');
    await wizard.waitFor({ state: 'detached' });

    await page.reload();
    await wizard.waitFor();
    await wizard.getByRole('button', { name: 'Close' }).click();
    await wizard.waitFor({ state: 'detached' });

    await page.reload();
    await page.route('**/api/settings/defaults', (route: any) =>
      route.fulfill({ status: 400, json: { error: 'defaults refused' } }),
    );
    await wizard.getByRole('button', { name: 'Get Started' }).click();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Finish Setup' }).click();
    await wizard.locator('.wizard-error', { hasText: 'defaults refused' }).waitFor();
    expect(await wizard.getByText("You're all set").count()).toBe(0);

    await page.unroute('**/api/settings/defaults');
    await wizard.getByRole('button', { name: 'Finish Setup' }).click();
    await wizard.getByText("You're all set").waitFor();
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);

test('Add project is a modal; a project menu renames, archives and unarchives it', async () => {
  const cleanup: ReleaseStep[] = [];
  try {
    const { dir, origin, page, errors } = await open(cleanup);
    await fetch(`${origin}/api/setup/complete`, { method: 'POST' });
    await page.goto(origin);

    const add = page.getByRole('dialog', { name: 'Add project' });
    await page.getByTitle('Add project').click();
    await add.waitFor();
    const pathFocused = () =>
      page.waitForFunction(() => document.activeElement?.id === 'proj-add-path');
    await pathFocused();
    await page.keyboard.press('Escape');
    await add.waitFor({ state: 'detached' });

    await page.getByTitle('Add project').click();
    await pathFocused();
    await page.keyboard.type(dir);
    await add.getByLabel('Label').fill('Scratch');
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await add.waitFor({ state: 'detached' });
    const item = (label: string) => page.locator('.proj-list .proj-item', { hasText: label });
    await item('Scratch').waitFor();

    await page.locator('.proj-item', { hasText: 'Global' }).click();
    const menu = async (label: string, action: string) => {
      await item(label).hover();
      await item(label).getByRole('button', { name: 'Project actions' }).click();
      await page.getByRole('menuitem', { name: action }).click();
    };

    await menu('Scratch', 'Rename');
    const rename = page.getByRole('dialog', { name: 'Rename project' });
    await rename.getByLabel('Label').fill('Renamed');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await item('Renamed').waitFor();

    await menu('Renamed', 'Archive');
    await item('Renamed').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Show archived (1)' }).click();
    await item('Renamed').waitFor();
    await menu('Renamed', 'Unarchive');
    await page.getByRole('button', { name: 'Hide archived' }).waitFor({ state: 'detached' });
    await item('Renamed').waitFor();
    expect(errors).toEqual([]);
  } finally {
    expect(await releaseAll(cleanup)).toEqual([]);
  }
}, 60_000);
