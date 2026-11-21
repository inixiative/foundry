/**
 * @atlas
 * @kind helper
 * @partOf feature:viewer
 */
/**
 * The shared look, `@inixiative/config`'s theme (public.css, status.css and the fonts they load),
 * served under `/ui/theme/` from the package at runtime so Foundry and Kingdom never drift apart,
 * plus user-owned custom UI assets under `<configDir>/ui/` served strictly under `/ui/custom/`.
 * The viewer serves both; the supervisor's status page serves `/ui/theme/` only while no release is booted.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THEME_PATH_PREFIX = '/ui/theme/';
export const CUSTOM_UI_PATH_PREFIX = '/ui/custom/';

/** Valid slug for named custom themes and local UI extension ids. */
export const CUSTOM_UI_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Explicit allowlist for `/ui/custom/*` files.
 * `.svg` is intentionally excluded because inline/standalone SVG can execute scripts on the viewer origin.
 */
export const CUSTOM_UI_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const NO_CUSTOM_THEME_CSS = '/* no custom theme */\n';

export interface ContainedFileOptions {
  /** Allow symlinks inside the root (true for package-managed `/ui/theme/*`, false for user `/ui/custom/*`). */
  allowSymlinks: boolean;
  /** Require `stat.nlink === 1` so hardlinks cannot alias outside files. */
  requireSingleLink: boolean;
  /** Reject any path segment starting with `.`. */
  rejectDotfiles?: boolean;
  /** Extension-to-Content-Type allowlist; when omitted, uses Bun.file's detected MIME type. */
  contentTypes?: Readonly<Record<string, string>>;
  /** Set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. */
  strictHeaders?: boolean;
  /** Optional raw request URL to reject percent-encoded traversal sequences before router decoding. */
  rawUrl?: string;
}

const ENCODED_TRAVERSAL = /%2e|%2f|%5c|%00/i;

function rawPathnameOf(rawUrl: string): string {
  const withoutScheme = rawUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  const end = withoutScheme.search(/[?#]/);
  return end === -1 ? withoutScheme : withoutScheme.slice(0, end);
}

async function isRegularContainedFile(filePath: string, rootReal: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return false;
    const real = await realpath(filePath);
    return real.startsWith(`${rootReal}${sep}`);
  } catch {
    return false;
  }
}

/**
 * Serve a single file strictly contained under `rootDir`.
 * Parameterized so `/ui/theme/*` keeps Bun/Linux symlink & hardlink compatibility while
 * `/ui/custom/*` enforces non-symlink, single-link, dotfile-free, allowlisted serving.
 */
export async function serveContainedFile(
  rootDir: string,
  relativePath: string,
  options: ContainedFileOptions,
): Promise<Response | undefined> {
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\')) return undefined;
  if (relativePath.startsWith('/')) return undefined;
  if (options.rawUrl) {
    const rawPath = rawPathnameOf(options.rawUrl);
    if (
      rawPath.includes('\0') ||
      rawPath.includes('\\') ||
      rawPath.includes('..') ||
      ENCODED_TRAVERSAL.test(rawPath)
    ) {
      return undefined;
    }
  }
  if (ENCODED_TRAVERSAL.test(relativePath)) return undefined;

  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return undefined;
    if (options.rejectDotfiles && segment.startsWith('.')) return undefined;
  }

  let contentType: string | undefined;
  if (options.contentTypes) {
    const ext = extname(relativePath).toLowerCase();
    contentType = options.contentTypes[ext];
    if (!contentType) return undefined;
  }

  if (options.allowSymlinks && !options.requireSingleLink) {
    const resolvedRoot = resolve(rootDir);
    const file = resolve(resolvedRoot, relativePath);
    if (!file.startsWith(`${resolvedRoot}${sep}`)) return undefined;
    const body = Bun.file(file);
    if (!(await body.exists())) return undefined;
    const headers: Record<string, string> = { 'Content-Type': contentType ?? body.type };
    if (options.strictHeaders) {
      headers['X-Content-Type-Options'] = 'nosniff';
      headers['Cache-Control'] = 'no-store';
    }
    return new Response(body, { headers });
  }

  let rootReal: string;
  try {
    rootReal = await realpath(resolve(rootDir));
  } catch {
    return undefined;
  }

  const candidate = resolve(rootReal, relativePath);
  if (!candidate.startsWith(`${rootReal}${sep}`)) return undefined;

  // Walk every segment below `rootReal` with `lstat` so intermediate directory symlinks are rejected too.
  let current = rootReal;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(current);
    } catch {
      return undefined;
    }
    if (!options.allowSymlinks && st.isSymbolicLink()) return undefined;
    if (i < segments.length - 1 && !st.isDirectory()) return undefined;
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const flags = options.allowSymlinks
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(candidate, flags);
  } catch {
    return undefined;
  }

  try {
    const st = await handle.stat();
    if (!st.isFile()) return undefined;
    if (options.requireSingleLink && st.nlink !== 1) return undefined;
    const real = await realpath(candidate);
    if (!real.startsWith(`${rootReal}${sep}`)) return undefined;
    const bytes = await handle.readFile();
    const headers: Record<string, string> = {
      'Content-Type': contentType ?? Bun.file(candidate).type,
    };
    if (options.strictHeaders) {
      headers['X-Content-Type-Options'] = 'nosniff';
      headers['Cache-Control'] = 'no-store';
    }
    return new Response(bytes, { status: 200, headers });
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

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
  if (!pathname.startsWith(THEME_PATH_PREFIX)) return undefined;
  return serveContainedFile(themeDir, pathname.slice(THEME_PATH_PREFIX.length), {
    allowSymlinks: true,
    requireSingleLink: false,
  });
}

/**
 * Strictly contained user asset under `<configDir>/ui/` for `/ui/custom/*`.
 * Rejects path traversal, dotfiles, symlinks, hardlinks, non-regular files, and non-allowlisted extensions.
 */
export async function customUiFile(
  configDir: string,
  pathname: string,
  rawUrl?: string,
): Promise<Response | undefined> {
  if (!pathname.startsWith(CUSTOM_UI_PATH_PREFIX)) return undefined;
  return serveContainedFile(
    resolve(configDir, 'ui'),
    pathname.slice(CUSTOM_UI_PATH_PREFIX.length),
    {
      allowSymlinks: false,
      requireSingleLink: true,
      rejectDotfiles: true,
      contentTypes: CUSTOM_UI_CONTENT_TYPES,
      strictHeaders: true,
      rawUrl,
    },
  );
}

/**
 * Resolve `/ui/custom/theme.css`: named theme `<configDir>/ui/themes/<slug>.css` when configured,
 * else `<configDir>/ui/theme.css`, else a `200 OK` placeholder CSS so the browser logs zero 404s.
 */
export async function customThemeCss(
  configDir: string,
  themeName?: string | null,
): Promise<Response> {
  if (typeof themeName === 'string' && CUSTOM_UI_SLUG.test(themeName)) {
    const named = await customUiFile(configDir, `${CUSTOM_UI_PATH_PREFIX}themes/${themeName}.css`);
    if (named) return named;
  }
  const fallback = await customUiFile(configDir, `${CUSTOM_UI_PATH_PREFIX}theme.css`);
  if (fallback) return fallback;
  return new Response(NO_CUSTOM_THEME_CSS, {
    status: 200,
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

export interface CustomUiManifest {
  themes: string[];
  extensions: string[];
  extensionEntries: Record<string, string>;
  hasDefaultTheme: boolean;
}

/** Discover valid local themes and extensions under `<configDir>/ui/`. */
export async function discoverCustomUi(configDir: string): Promise<CustomUiManifest> {
  const empty: CustomUiManifest = {
    themes: [],
    extensions: [],
    extensionEntries: {},
    hasDefaultTheme: false,
  };
  let rootReal: string;
  try {
    rootReal = await realpath(resolve(configDir, 'ui'));
  } catch {
    return empty;
  }

  const hasDefaultTheme = await isRegularContainedFile(join(rootReal, 'theme.css'), rootReal);

  const themes: string[] = [];
  const themesDir = join(rootReal, 'themes');
  try {
    const dirStat = await lstat(themesDir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      for (const entry of await readdir(themesDir)) {
        if (!entry.endsWith('.css')) continue;
        const slug = entry.slice(0, -'.css'.length);
        if (!CUSTOM_UI_SLUG.test(slug)) continue;
        if (await isRegularContainedFile(join(themesDir, entry), rootReal)) themes.push(slug);
      }
    }
  } catch {
    // No themes directory yet.
  }

  const extensionEntries: Record<string, string> = {};
  const extDir = join(rootReal, 'extensions');
  try {
    const dirStat = await lstat(extDir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      for (const entry of await readdir(extDir)) {
        if (entry.startsWith('.')) continue;
        const full = join(extDir, entry);
        let st: Awaited<ReturnType<typeof lstat>>;
        try {
          st = await lstat(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isFile() && entry.endsWith('.js')) {
          const slug = entry.slice(0, -'.js'.length);
          if (!CUSTOM_UI_SLUG.test(slug)) continue;
          if (await isRegularContainedFile(full, rootReal)) {
            extensionEntries[slug] = `${CUSTOM_UI_PATH_PREFIX}extensions/${slug}.js`;
          }
        } else if (st.isDirectory() && CUSTOM_UI_SLUG.test(entry)) {
          const indexFile = join(full, 'index.js');
          if (!(entry in extensionEntries) && (await isRegularContainedFile(indexFile, rootReal))) {
            extensionEntries[entry] = `${CUSTOM_UI_PATH_PREFIX}extensions/${entry}/index.js`;
          }
        }
      }
    }
  } catch {
    // No extensions directory yet.
  }

  themes.sort();
  const extensions = Object.keys(extensionEntries).sort();
  return { themes, extensions, extensionEntries, hasDefaultTheme };
}
