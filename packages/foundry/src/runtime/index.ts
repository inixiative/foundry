/** Public seam for a Foundry paired with Kingdom: the runtime connection and the Signet client. */

export {
  type KingdomInstallation,
  KingdomRuntimeConnection,
  type KingdomRuntimeSettings,
  kingdomRuntimeSchema,
  type RuntimeIdentity,
  type RuntimeOwner,
} from '../providers/kingdom-runtime-connection';
export { SignetClient, SignetHttpError } from '../providers/signet-client';
