/** Public seam for a Foundry paired with Kingdom: the Installation connection and the Signet client. */

export { SignetClient, SignetHttpError } from '@inixiative/signet';
export {
  KingdomInstallationConnection,
  type KingdomInstallationOptions,
  type KingdomIntegration,
  kingdomIntegrationSchema,
} from '../providers/kingdom-installation-connection';
