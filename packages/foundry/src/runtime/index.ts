/** Public seam for a Foundry paired with Kingdom: the runtime connection and the Signet client. */

export { SignetClient, SignetHttpError } from '@inixiative/signet';
export {
  type KingdomInstallation,
  KingdomRuntimeConnection,
  type KingdomRuntimeSettings,
  kingdomRuntimeSchema,
  type RuntimeIdentity,
  type RuntimeOwner,
} from '../providers/kingdom-runtime-connection';
