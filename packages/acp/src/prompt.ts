import type { ContentBlock } from '@agentclientprotocol/sdk';

/**
 * One Foundry turn payload from an ACP prompt: text verbatim, a resource link as an `@` reference
 * the native agent can open, embedded resource text fenced under its URI. Images travel beside the
 * text (`promptImages`); audio is not advertised and is named rather than dropped silently.
 */
export function promptText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'resource_link':
        parts.push(`@${linkPath(block.uri)}`);
        break;
      case 'resource': {
        const resource = block.resource;
        if ('text' in resource)
          parts.push(`<resource uri="${resource.uri}">\n${resource.text}\n</resource>`);
        else parts.push(`@${linkPath(resource.uri)}`);
        break;
      }
      case 'image':
        break;
      default:
        parts.push(`[${block.type} content omitted]`);
    }
  }
  return parts.join('\n\n');
}

/** The prompt's images, in order, as their bytes: sent with the turn beside its text. */
export function promptImages(blocks: readonly ContentBlock[]): Uint8Array[] {
  return blocks.flatMap((block) =>
    block.type === 'image' ? [new Uint8Array(Buffer.from(block.data, 'base64'))] : [],
  );
}

/** A `file://` URI as its path; any other URI as given. */
function linkPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
}
