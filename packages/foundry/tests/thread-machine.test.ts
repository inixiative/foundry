import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStack, Thread, type ThreadMachine } from '@inixiative/foundry-core';
import { enrollLocalDevice, readLocalDevice } from '../src/devices/local-inventory';
import { ViewerThreadDirectory } from '../src/viewer/thread-directory';

test('every thread the directory holds records the machine it runs on, once; a recorded one is kept', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'thread-machine-')), 'device.json');
  const device = enrollLocalDevice('Aron MacBook', path);
  const machine = (): ThreadMachine | undefined => {
    const d = readLocalDevice(path);
    return d ? { deviceId: d.id, deviceName: d.name, installationName: 'Foundry' } : undefined;
  };
  const main = new Thread('main', new ContextStack(), { description: '' });
  const directory = new ViewerThreadDirectory(main, undefined, undefined, machine);
  const here = { deviceId: device.id, deviceName: 'Aron MacBook', installationName: 'Foundry' };
  expect(main.meta.machine).toEqual(here);

  const created = new Thread('t', new ContextStack(), { description: '' });
  directory.add(created);
  expect(created.meta.machine).toEqual(here);

  const elsewhere = { deviceId: '00000000-0000-4000-8000-000000000000', deviceName: 'Other' };
  directory.restore([
    {
      id: 'r',
      meta: {
        description: '',
        tags: [],
        status: 'idle',
        createdAt: 1,
        lastActiveAt: 1,
        machine: elsewhere,
      },
    },
  ]);
  expect(directory.get('r')?.meta.machine).toEqual(elsewhere);
  directory.restore([
    {
      id: 'old',
      meta: { description: '', tags: [], status: 'idle', createdAt: 1, lastActiveAt: 1 },
    },
  ]);
  expect(directory.get('old')?.meta.machine).toEqual(here);
});

test('no device identity yet: nothing is stamped', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'thread-machine-')), 'device.json');
  const machine = () => {
    const d = readLocalDevice(path);
    return d ? { deviceId: d.id, deviceName: d.name } : undefined;
  };
  const main = new Thread('main', new ContextStack(), { description: '' });
  new ViewerThreadDirectory(main, undefined, undefined, machine);
  expect(main.meta.machine).toBeUndefined();
});
