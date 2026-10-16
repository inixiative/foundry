import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureThread } from '../src/archives/capture';
import { IMAGE_MAX_BYTES } from '../src/persistence/image-attachments';
import { liveWatchFixture, until } from './helpers/live-watch-fixture';

/** A 1x1 PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = () => Buffer.from(PNG, 'base64');

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function fixture(options: { imageInput?: boolean } = {}) {
  const dir = await mkdtemp(resolve('.foundry/qa/images-'));
  const f = await liveWatchFixture(dir, options);
  closers.push(() => f.close());
  const upload = async (body: Uint8Array, type = 'image/png') =>
    f.viewer.app.request('/api/attachments/images', {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });
  return { dir, f, upload };
}

test('an uploaded image is stored once by content under the config directory and served back', async () => {
  const { dir, f, upload } = await fixture();
  const res = await upload(png());
  expect(res.status).toBe(201);
  const stored = (await res.json()) as {
    id: string;
    mediaType: string;
    bytes: number;
    url: string;
  };
  expect(stored).toMatchObject({ mediaType: 'image/png', bytes: png().byteLength });
  expect(stored.id).toMatch(/^img_[0-9a-f]{64}$/);
  expect(stored.url).toBe(`/api/attachments/images/${stored.id}`);
  expect(existsSync(join(dir, 'attachments', 'images', `${stored.id.slice(4)}.png`))).toBe(true);
  // The same bytes are the same image.
  expect(((await (await upload(png())).json()) as { id: string }).id).toBe(stored.id);

  const served = await f.viewer.app.request(stored.url);
  expect(served.status).toBe(200);
  expect(served.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await served.arrayBuffer()).equals(png())).toBe(true);
  expect((await f.viewer.app.request('/api/attachments/images/img_nope')).status).toBe(404);
});

test('uploads are refused with a clear reason: not an image, too large, empty', async () => {
  const { upload } = await fixture();
  const text = await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  expect(text.status).toBe(415);
  expect(((await text.json()) as { error: string }).error).toBe(
    'Only PNG, JPEG, GIF and WebP images are accepted',
  );
  const large = new Uint8Array(IMAGE_MAX_BYTES + 1);
  large.set(png());
  const big = await upload(large);
  expect(big.status).toBe(413);
  expect(((await big.json()) as { error: string }).error).toBe(
    `The image is 5.00 MB (${IMAGE_MAX_BYTES + 1} bytes); the limit is 5 MB`,
  );
  expect((await upload(new Uint8Array())).status).toBe(400);
});

test('a message with images reaches the native session in the same turn; the journal keeps only references', async () => {
  const { f, upload } = await fixture();
  const stored = (await (await upload(png())).json()) as { id: string };
  const turn = f.send('with-image', true, { message: 'What is in this?', images: [stored.id] });
  expect((await turn.response).status).toBe(202);
  await until(() => f.attempts.length === 1, 'turn dispatched');
  expect(f.attempts[0].images).toEqual([{ mediaType: 'image/png', data: PNG }]);
  expect(f.attempts[0].prompt).toContain('What is in this?');
  f.attempts[0].finish();
  expect(await turn.done).toMatchObject({ type: 'done' });

  const store = f.viewer.localStore!;
  const user = store.messages(f.thread.id).find((m) => m.actor === 'user')!;
  expect(user.content).toBe('What is in this?');
  expect(user.meta?.images).toEqual([
    { id: stored.id, mediaType: 'image/png', bytes: png().byteLength },
  ]);
  // No copy of the bytes in the journal: messages, trace, injection evidence.
  const detail = await (
    await f.viewer.app.request(`/api/threads/${f.thread.id}/turns/with-image/detail`)
  ).text();
  expect(detail).toContain(stored.id);
  expect(detail).not.toContain(PNG);
  expect(JSON.stringify(store.archiveRecords(f.thread.id))).not.toContain(PNG);

  // The history index carries the references the viewer shows thumbnails from.
  const history = (await (
    await f.viewer.app.request(`/api/threads/${f.thread.id}/history`)
  ).json()) as { messages: Array<{ actor: string; meta?: { images?: unknown } }> };
  expect(history.messages.find((m) => m.actor === 'user')?.meta?.images).toEqual(user.meta?.images);

  // Archive capture names the image in the user's entry and carries no bytes.
  const snapshot = captureThread(store, crypto.randomUUID(), f.thread.id);
  const entry = snapshot.entries.find((e) => e.kind === 'user')!;
  expect(entry.text).toBe(
    `What is in this?\n\n[image ${stored.id} (image/png, ${png().byteLength} bytes)]`,
  );
  expect(JSON.stringify(snapshot)).not.toContain(PNG);
});

test('an image alone is a message', async () => {
  const { f, upload } = await fixture();
  const stored = (await (await upload(png())).json()) as { id: string };
  const turn = f.send('image-only', true, { message: '', images: [stored.id] });
  expect((await turn.response).status).toBe(202);
  await until(() => f.attempts.length === 1, 'turn dispatched');
  expect(f.attempts[0].images).toHaveLength(1);
  f.attempts[0].finish();
  expect(await turn.done).toMatchObject({ type: 'done' });
});

test('a send naming an unknown image, or too many, is refused before a turn is accepted', async () => {
  const { f, upload } = await fixture();
  const unknown = f.send('unknown-image', false, { images: [`img_${'0'.repeat(64)}`] });
  expect((await unknown.response).status).toBe(400);
  expect(await unknown.done).toEqual({ error: `Image not found: img_${'0'.repeat(64)}` });
  const stored = (await (await upload(png())).json()) as { id: string };
  const many = f.send('too-many', false, { images: Array(11).fill(stored.id) });
  expect((await many.response).status).toBe(400);
  expect(await many.done).toEqual({ error: 'A message carries at most 10 images (got 11)' });
  expect(f.viewer.localStore!.turn('unknown-image')).toBeUndefined();
  expect(f.attempts).toHaveLength(0);
});

test('a session whose transport takes no images fails the turn without sending anything', async () => {
  const { f, upload } = await fixture({ imageInput: false });
  const stored = (await (await upload(png())).json()) as { id: string };
  const turn = f.send('no-images', true, { images: [stored.id] });
  expect((await turn.response).status).toBe(202);
  const terminal = (await turn.done) as { type: string; error?: string };
  expect(terminal.type).toBe('error');
  expect(terminal.error).toContain('session does not accept images; nothing was sent');
  expect(f.attempts).toHaveLength(0);
});
