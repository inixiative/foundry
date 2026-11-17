/**
 * @atlas
 * @kind helper
 * @partOf feature:viewer
 */
/**
 * The shared look, `@inixiative/config`'s theme (public.css, status.css and the fonts they load),
 * served under `/ui/theme/` from the package at runtime so Foundry and Kingdom never drift apart.
 * The viewer serves it, and so does the supervisor's status page while no release is booted.
 */
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THEME_PATH_PREFIX = '/ui/theme/';

/** The theme's directory, or undefined where the package is not installed. */
export const themeDirectory = (): string | undefined => {
  try {
    return dirname(fileURLToPath(import.meta.resolve('@inixiative/config/theme/public.css')));
  } catch {
    return undefined;
  }
};

/** The theme file a `/ui/theme/…` path names, or undefined for one outside the theme or missing. */
export async function themeFile(themeDir: string, pathname: string): Promise<Response | undefined> {
  const file = resolve(themeDir, pathname.slice(THEME_PATH_PREFIX.length));
  if (!file.startsWith(`${themeDir}${sep}`)) return undefined;
  const body = Bun.file(file);
  if (!(await body.exists())) return undefined;
  return new Response(body, { headers: { 'Content-Type': body.type } });
}
