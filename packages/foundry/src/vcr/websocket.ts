/**
 * @atlas
 * @kind adapter
 * @partOf primitive:vcr
 */
// Foundry's WebSocket cassette seam delegating directly to @inixiative/vcr/websocket.
import {
  createVcrWebSocketFactory,
  type SocketFrame,
  type SocketLike,
  type SocketTranscript,
  type VcrSocketFactory,
  type WebSocketCassetteOptions,
} from '@inixiative/vcr/websocket';
import type { VCR } from './vcr';

export type { SocketFrame, SocketLike, SocketTranscript };
export type SocketFactory = VcrSocketFactory;

export const webSocketCassettes = (
  vcr: VCR,
  method: string,
  options?: WebSocketCassetteOptions,
): SocketFactory => createVcrWebSocketFactory(vcr.recorder, method, options);
