// ---------------------------------------------------------------------------
// PlaywrightBrowser — BrowserTool adapter wrapping Playwright
// ---------------------------------------------------------------------------
//
// Provides a typed, capability-gated browser interface for Foundry agents.
// Wraps Playwright's Page API with structured inputs/outputs so agents
// get JSON results instead of raw HTML.
//
// Playwright is a peer dependency — install it separately:
//   bun add playwright
//
// Usage:
//   const browser = new PlaywrightBrowser({ headless: true });
//   await browser.launch();
//   registry.register(browser, "Navigate and interact with web pages");
//
//   // Agent uses it:
//   const result = await browser.navigate("https://example.com");
//   const snap = await browser.snapshot();
//   const data = await browser.evaluate("document.title");
// ---------------------------------------------------------------------------

import type {
  BrowserTool,
  ToolResult,
  PageSnapshot,
  PageElement,
  NavigateOpts,
} from "@inixiative/foundry-core";

export interface PlaywrightBrowserConfig {
  /** Run headless. Default: true. */
  headless?: boolean;
  /** Browser type: chromium, firefox, webkit. Default: chromium. */
  browserType?: "chromium" | "firefox" | "webkit";
  /** Viewport size. */
  viewport?: { width: number; height: number };
  /** User agent string override. */
  userAgent?: string;
  /** Allowed URL patterns (glob). Empty = allow all. */
  allowedUrls?: string[];
  /** Blocked URL patterns (glob). Takes precedence. */
  blockedUrls?: string[];
  /** Max navigations per session (prevent runaway). Default: 50. */
  maxNavigations?: number;
  /** Default timeout in ms. Default: 30000. */
  timeout?: number;
  /** Reuse browser context for shared auth state. */
  contextId?: string;
}

// Playwright types — declared loosely so we don't force the import
// at compile time. Playwright is resolved at runtime.
type PwBrowser = { newContext: (opts?: any) => Promise<any>; close: () => Promise<void> };
type PwContext = { newPage: () => Promise<any>; close: () => Promise<void> };
type PwPage = {
  goto: (url: string, opts?: any) => Promise<any>;
  title: () => Promise<string>;
  url: () => string;
  click: (selector: string, opts?: any) => Promise<void>;
  fill: (selector: string, value: string, opts?: any) => Promise<void>;
  selectOption: (selector: string, value: string, opts?: any) => Promise<any>;
  evaluate: <T>(fn: string | ((...args: any[]) => T), ...args: any[]) => Promise<T>;
  screenshot: (opts?: any) => Promise<Buffer>;
  waitForSelector: (selector: string, opts?: any) => Promise<any>;
  accessibility: { snapshot: (opts?: any) => Promise<any> };
  close: () => Promise<void>;
};

/** Shared browser contexts for session sharing across agents. */
const sharedContexts = new Map<string, PwContext>();

export class PlaywrightBrowser implements BrowserTool {
  readonly id: string;
  readonly kind = "browser" as const;
  readonly capabilities = {
    navigate: "browser:navigate" as const,
    interact: "browser:interact" as const,
    execute: "browser:execute" as const,
    screenshot: "browser:screenshot" as const,
  };

  private _config: Required<PlaywrightBrowserConfig>;
  private _browser: PwBrowser | null = null;
  private _context: PwContext | null = null;
  private _page: PwPage | null = null;
  private _navCount = 0;

  constructor(config?: PlaywrightBrowserConfig & { id?: string }) {
    this.id = config?.id ?? "browser";
    this._config = {
      headless: config?.headless ?? true,
      browserType: config?.browserType ?? "chromium",
      viewport: config?.viewport ?? { width: 1280, height: 720 },
      userAgent: config?.userAgent ?? "",
      allowedUrls: config?.allowedUrls ?? [],
      blockedUrls: config?.blockedUrls ?? [],
      maxNavigations: config?.maxNavigations ?? 50,
      timeout: config?.timeout ?? 30_000,
      contextId: config?.contextId ?? "",
    };
  }

  /** Launch the browser. Must be called before any operations. */
  async launch(): Promise<void> {
    // Dynamic import — Playwright is a peer dep
    let pw: any;
    try {
      // Dynamic import — playwright is a peer dependency
      // @ts-expect-error - peer dep may not be installed
      pw = await import("playwright");
    } catch {
      throw new Error(
        "Playwright is not installed. Install it with: bun add playwright"
      );
    }

    const launcher = pw[this._config.browserType] ?? pw.chromium;
    this._browser = await launcher.launch({
      headless: this._config.headless,
    });

    // Reuse shared context if configured
    if (this._config.contextId && sharedContexts.has(this._config.contextId)) {
      this._context = sharedContexts.get(this._config.contextId)!;
    } else {
      const contextOpts: any = {
        viewport: this._config.viewport,
      };
      if (this._config.userAgent) {
        contextOpts.userAgent = this._config.userAgent;
      }
      this._context = await this._browser!.newContext(contextOpts);
      if (this._config.contextId) {
        sharedContexts.set(this._config.contextId, this._context!);
      }
    }

    this._page = await this._context!.newPage();
    this._navCount = 0;
  }

  // ---- BrowserTool interface ----

  async navigate(
    url: string,
    opts?: NavigateOpts
  ): Promise<ToolResult<{ url: string; title: string }>> {
    const page = this._ensurePage();

    if (!this._isUrlAllowed(url)) {
      return { ok: false, summary: `URL blocked by policy: ${url}`, error: "URL not in allowedUrls or is in blockedUrls" };
    }

    if (this._navCount >= this._config.maxNavigations) {
      return { ok: false, summary: `Navigation limit reached (${this._config.maxNavigations})`, error: "maxNavigations exceeded" };
    }

    try {
      await page.goto(url, {
        timeout: opts?.timeout ?? this._config.timeout,
        waitUntil: "domcontentloaded",
      });
      this._navCount++;

      if (opts?.waitFor) {
        await page.waitForSelector(opts.waitFor, {
          timeout: opts.timeout ?? this._config.timeout,
        });
      }

      const title = await page.title();
      const finalUrl = page.url();

      return {
        ok: true,
        data: { url: finalUrl, title },
        summary: `Navigated to ${finalUrl} — "${title}"`,
      };
    } catch (err) {
      return {
        ok: false,
        summary: `Failed to navigate to ${url}`,
        error: (err as Error).message,
      };
    }
  }

  async snapshot(): Promise<ToolResult<PageSnapshot>> {
    const page = this._ensurePage();
    try {
      const tree = await page.accessibility.snapshot({ interestingOnly: true });
      const url = page.url();
      const title = await page.title();

      const elements = tree ? this._flattenTree(tree) : [];
      const summary = `Page snapshot: "${title}" (${url}) — ${elements.length} elements`;
      const estimatedTokens = Math.ceil(summary.length / 4) + elements.length * 10;

      return {
        ok: true,
        data: { url, title, elements, estimatedTokens },
        summary,
        estimatedTokens,
      };
    } catch (err) {
      return { ok: false, summary: "Failed to get page snapshot", error: (err as Error).message };
    }
  }

  async click(ref: string): Promise<ToolResult<void>> {
    const page = this._ensurePage();
    try {
      await page.click(ref, { timeout: this._config.timeout });
      return { ok: true, summary: `Clicked: ${ref}` };
    } catch (err) {
      return { ok: false, summary: `Failed to click: ${ref}`, error: (err as Error).message };
    }
  }

  async fill(ref: string, value: string): Promise<ToolResult<void>> {
    const page = this._ensurePage();
    try {
      await page.fill(ref, value, { timeout: this._config.timeout });
      return { ok: true, summary: `Filled "${ref}" with value` };
    } catch (err) {
      return { ok: false, summary: `Failed to fill: ${ref}`, error: (err as Error).message };
    }
  }

  async select(ref: string, value: string): Promise<ToolResult<void>> {
    const page = this._ensurePage();
    try {
      await page.selectOption(ref, value, { timeout: this._config.timeout });
      return { ok: true, summary: `Selected "${value}" in ${ref}` };
    } catch (err) {
      return { ok: false, summary: `Failed to select in: ${ref}`, error: (err as Error).message };
    }
  }

  async evaluate<T = unknown>(script: string): Promise<ToolResult<T>> {
    const page = this._ensurePage();
    try {
      const result = await page.evaluate<T>(script);
      const summary = typeof result === "object"
        ? `JS executed — returned ${JSON.stringify(result).length} chars of data`
        : `JS executed — returned: ${String(result).slice(0, 100)}`;
      return { ok: true, data: result, summary };
    } catch (err) {
      return { ok: false, summary: "JS execution failed", error: (err as Error).message };
    }
  }

  async screenshot(): Promise<ToolResult<{ base64: string; mimeType: string }>> {
    const page = this._ensurePage();
    try {
      const buffer = await page.screenshot({ type: "png", fullPage: false });
      const base64 = buffer.toString("base64");
      return {
        ok: true,
        data: { base64, mimeType: "image/png" },
        summary: `Screenshot captured (${Math.round(buffer.length / 1024)}KB)`,
      };
    } catch (err) {
      return { ok: false, summary: "Screenshot failed", error: (err as Error).message };
    }
  }

  async currentUrl(): Promise<string> {
    const page = this._ensurePage();
    return page.url();
  }

  async close(): Promise<void> {
    if (this._page) {
      await this._page.close().catch(() => {});
      this._page = null;
    }
    // Only close context if not shared
    if (this._context && !this._config.contextId) {
      await this._context.close().catch(() => {});
      this._context = null;
    }
    if (this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
    }
  }

  // ---- Internals ----

  private _ensurePage(): PwPage {
    if (!this._page) {
      throw new Error("Browser not launched. Call launch() first.");
    }
    return this._page;
  }

  private _isUrlAllowed(url: string): boolean {
    const { allowedUrls, blockedUrls } = this._config;

    // Check blocked first (takes precedence)
    if (blockedUrls.length > 0) {
      for (const pattern of blockedUrls) {
        if (this._matchGlob(url, pattern)) return false;
      }
    }

    // If allowed list is empty, allow all
    if (allowedUrls.length === 0) return true;

    // Check against allowed patterns
    for (const pattern of allowedUrls) {
      if (this._matchGlob(url, pattern)) return true;
    }
    return false;
  }

  private _matchGlob(url: string, pattern: string): boolean {
    // Simple glob matching: * matches any chars except /, ** matches anything
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<GLOBSTAR>>>/g, ".*");
    return new RegExp(`^${regex}$`).test(url);
  }

  private _flattenTree(node: any, depth = 0): PageElement[] {
    const elements: PageElement[] = [];
    if (!node) return elements;

    const el: PageElement = {
      role: node.role || "unknown",
      name: node.name || "",
    };
    if (node.value) el.value = node.value;

    elements.push(el);

    if (node.children) {
      for (const child of node.children) {
        elements.push(...this._flattenTree(child, depth + 1));
      }
    }

    return elements;
  }
}
