/**
 * Local services before launch. Starts the docker-compose.yml services that this
 * Foundry's environment points at on this machine; a service configured
 * elsewhere, or not configured, is left alone.
 */
import { $ } from 'bun';

const SERVICE_BY_ENV = {
  DATABASE_URL: 'postgres',
  REDIS_URL: 'redis',
  MUNINN_URL: 'muninndb',
} as const;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Fixed so volumes and container names hold whichever checkout runs the daemon. */
const COMPOSE_PROJECT = 'foundry';
const DOCKER_START_TIMEOUT_MS = 120_000;

export const localServices = (env: Record<string, string | undefined>): string[] =>
  Object.entries(SERVICE_BY_ENV)
    .filter(([key]) => {
      try {
        return LOCAL_HOSTS.has(new URL(env[key] ?? '').hostname);
      } catch {
        return false;
      }
    })
    .map(([, service]) => service);

const dockerRunning = async () => (await $`docker info`.nothrow().quiet()).exitCode === 0;

const startDocker = async (): Promise<boolean> => {
  if (await dockerRunning()) return true;
  if (process.platform !== 'darwin') return false;
  await $`open -ga Docker`.nothrow().quiet();
  const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(2_000);
    if (await dockerRunning()) return true;
  }
  return false;
};

export interface ServicesResult {
  started: string[];
  detail?: string;
}

export const ensureServices = async (
  repoRoot: string,
  env = process.env,
): Promise<ServicesResult> => {
  const services = localServices(env);
  if (!services.length) return { started: [] };
  if (!(await startDocker()))
    return { started: [], detail: 'Docker is not running and could not be started' };
  const up =
    await $`docker compose --project-name ${COMPOSE_PROJECT} --project-directory ${repoRoot} up -d --wait ${services}`
      .nothrow()
      .quiet();
  return up.exitCode === 0
    ? { started: services }
    : { started: [], detail: up.stderr.toString().trim() };
};
