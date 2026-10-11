/**
 * `@inixiative/foundry/client`: what a local client of the daemon needs, and nothing that runs a
 * turn. foundry-acp imports only this; so does any other process that drives Foundry turns
 * through the daemon's API (the viewer's own routes and data streams).
 */

export type { TurnTerminal } from '../viewer/data-streams';
export type { LiveActivity, StreamBufferSnapshot, TurnAppend } from '../viewer/stream-buffer';
export { DAEMON_LABEL, daemonPlistPath, startDaemon } from './daemon';
export {
  DataStreamClient,
  type DataStreamClientOptions,
  type StreamHandlers,
} from './data-stream-client';
export {
  FoundryClient,
  type FoundryEndpoint,
  FoundryHttpError,
  type ThreadJSON,
} from './foundry-client';
export {
  type AcpLaunch,
  acpLaunchPath,
  defaultAcpLaunchPath,
  newAcpCapability,
  readAcpLaunch,
  writeAcpLaunch,
} from './launch';
