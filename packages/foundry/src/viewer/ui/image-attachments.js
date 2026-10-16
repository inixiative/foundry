/**
 * Images in the composer: what is accepted, the downscale before upload, and the upload itself.
 * The server checks the same limits and sniffs the type from the bytes; these checks only give
 * the sender a clear answer before anything is sent.
 */

import { authFetch } from './store.js';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGES_PER_MESSAGE = 10;
/** Longest edge kept: screenshots stay legible, and the model would scale anything larger itself. */
export const IMAGE_MAX_EDGE = 2560;

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The image files among dropped or pasted items, in order. */
export function imageFiles(list) {
  return [...(list ?? [])]
    .map((item) => (typeof item.getAsFile === 'function' ? item.getAsFile() : item))
    .filter((file) => file && typeof file.type === 'string' && file.type.startsWith('image/'));
}

const encode = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));

/**
 * The image as it will be sent: unchanged when within the limits, otherwise drawn smaller (longest
 * edge IMAGE_MAX_EDGE), and re-encoded as JPEG if it is still over the byte limit. A GIF is only
 * redrawn when it is too large, since a redraw keeps its first frame.
 */
export async function prepareImage(file) {
  if (!IMAGE_TYPES.includes(file.type))
    throw new Error(`${file.name || 'image'}: only PNG, JPEG, GIF and WebP images can be sent`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || 'image'}: the image could not be read`);
  }
  const edge = Math.max(bitmap.width, bitmap.height);
  const oversized = file.size > IMAGE_MAX_BYTES;
  if (!oversized && (edge <= IMAGE_MAX_EDGE || file.type === 'image/gif')) {
    bitmap.close?.();
    return file;
  }
  const scale = Math.min(1, IMAGE_MAX_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const type = file.type === 'image/gif' ? 'image/png' : file.type;
  let blob = await encode(canvas, type, 0.92);
  if (!blob || blob.size > IMAGE_MAX_BYTES) blob = await encode(canvas, 'image/jpeg', 0.85);
  if (!blob || blob.size > IMAGE_MAX_BYTES)
    throw new Error(
      `${file.name || 'image'}: still ${megabytes(blob?.size ?? file.size)} after downscaling; the limit is ${megabytes(IMAGE_MAX_BYTES)}`,
    );
  return blob;
}

/** Store the image on the server; resolves to its reference `{ id, mediaType, bytes, url }`. */
export async function uploadImage(blob) {
  const res = await authFetch('/api/attachments/images', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `upload failed (${res.status})`);
  return body;
}

/** Where a stored image is shown from. */
export const imageUrl = (id) => `/api/attachments/images/${encodeURIComponent(id)}`;
