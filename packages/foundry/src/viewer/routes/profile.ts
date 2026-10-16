import type { Hono } from 'hono';
import { defaultInstallationName, installationNameOf } from '../../providers/kingdom-cli';
import type { ConfigStore } from '../config';

/** Settings → Profile: this Foundry's name. Who the operator is comes from Kingdom (/api/kingdom/status). */
export function registerProfileRoutes(app: Hono, configStore: ConfigStore) {
  app.get('/api/profile', async (c) => {
    const config = await configStore.load();
    return c.json({
      installationName: installationNameOf(config),
      defaultName: defaultInstallationName(),
      custom: config.installationName !== undefined,
    });
  });
}
