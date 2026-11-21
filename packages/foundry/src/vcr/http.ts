/**
 * @atlas
 * @kind adapter
 * @partOf primitive:vcr
 */
// Foundry's fetch cassette seam delegating directly to @inixiative/vcr/http.
import {
  createVcrFetch,
  type HttpCassette,
  type HttpCassetteOptions,
  type RecordedHttpRequest,
} from '@inixiative/vcr/http';
import type { VCR } from './vcr';

export type RecordedRequest = RecordedHttpRequest;
export type HttpFixture<T = unknown> = HttpCassette<T>;

export const httpCassettes = (
  vcr: VCR,
  method: string,
  options?: HttpCassetteOptions,
): typeof fetch => createVcrFetch(vcr.recorder, method, options);
