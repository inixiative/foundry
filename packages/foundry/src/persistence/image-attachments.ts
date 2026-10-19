/**
 * @atlas
 * @kind service
 * @partOf primitive:journal
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageInput, ImageMediaType } from '@inixiative/foundry-core';

/** Largest image accepted, after any downscale the sender does (the Messages API's own limit). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Most images one message may carry. */
export const IMAGES_PER_MESSAGE = 10;

const EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const ID = /^img_([0-9a-f]{64})$/;

/** A stored image as a message records it: identity, type and size, never the bytes. */
export type ImageAttachment = Omit<ImageInput, 'data'>;

export class ImageAttachmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 | 415,
  ) {
    super(message);
  }
}

/** The image type the bytes themselves declare (their signature), whatever a header claimed. */
export function imageMediaType(bytes: Uint8Array): ImageMediaType | null {
  const starts = (offset: number, ...signature: number[]) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39))
    return 'image/gif';
  if (starts(0, 0x52, 0x49, 0x46, 0x46) && starts(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/**
 * Images sent with messages, stored once each under the config directory by content hash
 * (`<configDir>/attachments/images/<sha256>.<ext>`). The journal records only their identity.
 */
export class ImageAttachmentStore {
  constructor(readonly directory: string) {}

  /** Store an image (idempotent by content); refused when too large or not png/jpeg/gif/webp. */
  async put(bytes: Uint8Array): Promise<ImageAttachment> {
    if (bytes.byteLength === 0) throw new ImageAttachmentError('The image is empty', 400);
    if (bytes.byteLength > IMAGE_MAX_BYTES)
      throw new ImageAttachmentError(
        `The image is ${megabytes(bytes.byteLength)} (${bytes.byteLength} bytes); the limit is ${IMAGE_MAX_BYTES / 1024 / 1024} MB`,
        413,
      );
    const mediaType = imageMediaType(bytes);
    if (!mediaType)
      throw new ImageAttachmentError('Only PNG, JPEG, GIF and WebP images are accepted', 415);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = join(this.directory, `${hash}.${EXTENSIONS[mediaType]}`);
    if (!(await exists(file))) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const partial = `${file}.${process.pid}.${Date.now()}.partial`;
      await writeFile(partial, bytes, { mode: 0o600 });
      await chmod(partial, 0o600);
      await rename(partial, file);
    }
    return { id: `img_${hash}`, mediaType, bytes: bytes.byteLength };
  }

  /** A stored image and its bytes, or null when the id names none. */
  async get(id: string): Promise<{ attachment: ImageAttachment; bytes: Buffer } | null> {
    const hash = ID.exec(id)?.[1];
    if (!hash) return null;
    for (const [mediaType, extension] of Object.entries(EXTENSIONS) as [ImageMediaType, string][]) {
      const bytes = await readFile(join(this.directory, `${hash}.${extension}`)).catch(() => null);
      if (bytes) return { attachment: { id, mediaType, bytes: bytes.byteLength }, bytes };
    }
    return null;
  }

  /** A message's image ids as the images its turn sends, in order; refused when any is unknown. */
  async resolve(ids: unknown): Promise<ImageInput[]> {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))
      throw new ImageAttachmentError('images must be an array of image ids', 400);
    if (ids.length > IMAGES_PER_MESSAGE)
      throw new ImageAttachmentError(
        `A message carries at most ${IMAGES_PER_MESSAGE} images (got ${ids.length})`,
        400,
      );
    return Promise.all(
      ids.map(async (id) => {
        const stored = await this.get(id);
        if (!stored) throw new ImageAttachmentError(`Image not found: ${id}`, 400);
        return { ...stored.attachment, data: stored.bytes.toString('base64') };
      }),
    );
  }
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
