import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { RuntimeEvent, RuntimeEventKind, RuntimeEventStats, TabState, ViewportState } from '../common/types';
import { Events } from '../obs/Events';
import { LlmBrowserError } from '../common/errors';
import { defaultView, normalizeView } from '../device/View';

export interface CreateSessionOptions {
  storageState?: any;
  url?: string;
  viewport?: unknown;
}

export class BrowserCore {
  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Map<string, Page>> = new Map();
  private activeTabs: Map<string, string> = new Map();
  private tabSeq: Map<string, number> = new Map();
  private viewports: Map<string, ViewportState> = new Map();
  private events = new Events();

  async initialize(): Promise<void> {
    const config = ConfigurationManager.getInstance().getConfig().browser;
    this.browser = await chromium.launch({
      headless: config.headless !== false,
      executablePath: config.chromium_path,
      slowMo: (config.slow_mo_ms ?? 0) > 0 ? config.slow_mo_ms : undefined,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
  }

  async createSession(sessionId: string, options: CreateSessionOptions = {}): Promise<void> {
    if (!this.browser) throw new Error('Browser not initialized');
    this.assertCapacity('session');
    
    const config = ConfigurationManager.getInstance().getConfig().browser;
    const viewport = { ...normalizeView(options.viewport, defaultView(config)), mode: 'context' as const };
    const context = await this.browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.device_scale_factor,
      isMobile: viewport.is_mobile,
      hasTouch: viewport.has_touch,
      userAgent: viewport.user_agent ?? config.user_agent,
      ignoreHTTPSErrors: config.ignore_https_errors,
      storageState: options.storageState,
    });
    await context.addInitScript(shadowDomHook);
    
    this.contexts.set(sessionId, context);
    this.pages.set(sessionId, new Map());
    this.viewports.set(sessionId, viewport);
    const page = await context.newPage();
    this.registerPage(sessionId, page, 'tab-1');
    this.activeTabs.set(sessionId, 'tab-1');
    this.tabSeq.set(sessionId, 1);
    context.on('page', (newPage) => {
      const tabId = this.registerPage(sessionId, newPage);
      this.activeTabs.set(sessionId, tabId);
    });
    if (options.url) {
      await page.goto(options.url, { waitUntil: 'load' });
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (context) {
      await context.close();
      this.contexts.delete(sessionId);
      this.pages.delete(sessionId);
      this.activeTabs.delete(sessionId);
      this.tabSeq.delete(sessionId);
      this.viewports.delete(sessionId);
      this.events.clear(sessionId);
    }
  }

  getPage(sessionId: string, tabId?: string): Page {
    const targetTab = tabId ?? this.getActiveTabId(sessionId);
    const page = this.pages.get(sessionId)?.get(targetTab);
    if (!page) throw new Error(`Page for session ${sessionId} not found`);
    return page;
  }

  getActiveTabId(sessionId: string): string {
    const tabId = this.activeTabs.get(sessionId);
    if (!tabId) throw new Error(`Active tab for session ${sessionId} not found`);
    return tabId;
  }

  getContext(sessionId: string): BrowserContext {
    const context = this.contexts.get(sessionId);
    if (!context) throw new Error(`Context for session ${sessionId} not found`);
    return context;
  }

  hasSession(sessionId: string): boolean {
    return this.contexts.has(sessionId) && Boolean(this.pages.get(sessionId)?.size);
  }

  // Check if browser is still alive and connected
  isAlive(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  async storageState(sessionId: string): Promise<any> {
    return this.getContext(sessionId).storageState();
  }

  getViewport(sessionId: string, tabId?: string): ViewportState | undefined {
    const page = this.pages.get(sessionId)?.get(tabId ?? this.activeTabs.get(sessionId) ?? '');
    const size = page?.viewportSize();
    const stored = this.viewports.get(sessionId);
    if (!stored && !size) return undefined;
    return {
      ...(stored ?? {}),
      ...(size ?? {}),
    } as ViewportState;
  }

  stats(): Record<string, number | boolean> {
    const config = ConfigurationManager.getInstance().getConfig();
    const memory = memoryStats();
    return {
      initialized: Boolean(this.browser),
      contexts: this.contexts.size,
      pages: Array.from(this.pages.values()).reduce((total, tabs) => total + tabs.size, 0),
      max_sessions: config.server.max_sessions,
      max_tabs_per_session: config.browser.max_tabs_per_session,
      events: this.events.stats().total,
      rss_mb: memory.rss_mb,
      heap_used_mb: memory.heap_used_mb,
      memory_limit_mb: config.browser.memory_limit_mb,
    };
  }

  listEvents(
    sessionId: string,
    filter: { tab_id?: string; kind?: RuntimeEventKind; limit?: number } = {}
  ): RuntimeEvent[] {
    if (!this.contexts.has(sessionId)) throw new Error(`Session ${sessionId} not found`);
    return this.events.list(sessionId, filter);
  }

  clearEvents(sessionId: string): void {
    if (!this.contexts.has(sessionId)) throw new Error(`Session ${sessionId} not found`);
    this.events.clear(sessionId);
  }

  eventStats(sessionId?: string): RuntimeEventStats {
    return this.events.stats(sessionId);
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    const page = this.getPage(sessionId);
    await page.goto(url, { waitUntil: 'load' });
  }

  async listTabs(sessionId: string): Promise<TabState[]> {
    const tabs = this.pages.get(sessionId);
    if (!tabs) throw new Error(`Session ${sessionId} not found`);
    const active = this.getActiveTabId(sessionId);
    const result: TabState[] = [];
    for (const [tabId, page] of tabs) {
      result.push({
        tab_id: tabId,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: tabId === active,
        viewport: this.getViewport(sessionId, tabId),
      });
    }
    return result;
  }

  async openTab(sessionId: string, url?: string): Promise<TabState> {
    const context = this.getContext(sessionId);
    this.assertCapacity('tab', sessionId);
    const page = await context.newPage();
    const viewport = this.getViewport(sessionId);
    if (viewport) await page.setViewportSize({ width: viewport.width, height: viewport.height }).catch(() => undefined);
    const tabId = this.registerPage(sessionId, page);
    this.activeTabs.set(sessionId, tabId);
    if (url) {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    }
    return this.tabInfo(sessionId, tabId);
  }

  async switchTab(sessionId: string, tabId: string): Promise<TabState> {
    const page = this.getPage(sessionId, tabId);
    this.activeTabs.set(sessionId, tabId);
    await page.bringToFront().catch(() => undefined);
    return this.tabInfo(sessionId, tabId);
  }

  async closeTab(sessionId: string, tabId?: string): Promise<{ closed_tab_id: string; active_tab: TabState }> {
    const targetTab = tabId ?? this.getActiveTabId(sessionId);
    const tabs = this.pages.get(sessionId);
    const page = tabs?.get(targetTab);
    if (!tabs || !page) throw new Error(`Tab ${targetTab} not found`);
    if (tabs.size <= 1) throw new Error('Cannot close last tab');

    tabs.delete(targetTab);
    await page.close().catch(() => undefined);
    if (this.activeTabs.get(sessionId) === targetTab) {
      const nextTab = tabs.keys().next().value;
      if (!nextTab) throw new Error('No tab available after close');
      this.activeTabs.set(sessionId, nextTab);
      await tabs.get(nextTab)?.bringToFront().catch(() => undefined);
    }

    return {
      closed_tab_id: targetTab,
      active_tab: await this.tabInfo(sessionId, this.getActiveTabId(sessionId)),
    };
  }

  async setViewport(sessionId: string, value: unknown): Promise<ViewportState> {
    const base = this.getViewport(sessionId) ?? defaultView(ConfigurationManager.getInstance().getConfig().browser);
    const viewport = { ...normalizeView(value, base), mode: 'page' as const };
    const tabs = this.pages.get(sessionId);
    if (!tabs) throw new Error(`Session ${sessionId} not found`);
    for (const page of tabs.values()) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    }
    this.viewports.set(sessionId, viewport);
    return viewport;
  }

  async close(): Promise<void> {
    for (const sessionId of this.contexts.keys()) {
      await this.closeSession(sessionId);
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private registerPage(sessionId: string, page: Page, preferredTabId?: string): string {
    const tabs = this.pages.get(sessionId);
    if (!tabs) throw new Error(`Session ${sessionId} not found`);
    for (const [tabId, existing] of tabs) {
      if (existing === page) return tabId;
    }

    const tabId = preferredTabId ?? this.nextTabId(sessionId);
    tabs.set(tabId, page);
    this.events.attach(sessionId, tabId, page);
    page.on('close', () => this.detachPage(sessionId, tabId));
    return tabId;
  }

  private detachPage(sessionId: string, tabId: string): void {
    const tabs = this.pages.get(sessionId);
    if (!tabs?.has(tabId)) return;
    tabs.delete(tabId);
    if (this.activeTabs.get(sessionId) === tabId) {
      const nextTab = tabs.keys().next().value;
      if (nextTab) this.activeTabs.set(sessionId, nextTab);
      else this.activeTabs.delete(sessionId);
    }
  }

  private nextTabId(sessionId: string): string {
    const next = (this.tabSeq.get(sessionId) ?? 1) + 1;
    this.tabSeq.set(sessionId, next);
    return `tab-${next}`;
  }

  private async tabInfo(sessionId: string, tabId: string): Promise<TabState> {
    const page = this.getPage(sessionId, tabId);
    return {
      tab_id: tabId,
      url: page.url(),
      title: await page.title().catch(() => ''),
      active: tabId === this.getActiveTabId(sessionId),
      viewport: this.getViewport(sessionId, tabId),
    };
  }

  private assertCapacity(kind: 'session' | 'tab', sessionId?: string): void {
    const config = ConfigurationManager.getInstance().getConfig();
    const memory = memoryStats();
    if (config.browser.memory_limit_mb > 0 && memory.rss_mb > config.browser.memory_limit_mb) {
      throw new LlmBrowserError('RATE_LIMIT_EXCEEDED', 'Runtime memory budget exceeded', {
        rss_mb: memory.rss_mb,
        memory_limit_mb: config.browser.memory_limit_mb,
      });
    }

    if (kind === 'session' && this.contexts.size >= config.server.max_sessions) {
      throw new LlmBrowserError('RATE_LIMIT_EXCEEDED', 'max_sessions limit reached', {
        max_sessions: config.server.max_sessions,
        active_sessions: this.contexts.size,
      });
    }

    if (kind === 'tab' && sessionId) {
      const tabs = this.pages.get(sessionId);
      const maxTabs = config.browser.max_tabs_per_session;
      if (tabs && tabs.size >= maxTabs) {
        throw new LlmBrowserError('RATE_LIMIT_EXCEEDED', 'max_tabs_per_session limit reached', {
          max_tabs_per_session: maxTabs,
          active_tabs: tabs.size,
          session_id: sessionId,
        });
      }
    }
  }
}

function memoryStats(): { rss_mb: number; heap_used_mb: number } {
  const memory = process.memoryUsage();
  return {
    rss_mb: Math.round(memory.rss / 1024 / 1024),
    heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024),
  };
}

function shadowDomHook(): void {
  const key = '__llmBrowserShadowRoots';
  const win = window as any;
  if (win[key]?.installed) return;

  const original = Element.prototype.attachShadow;
  const roots: Array<{ host: Element; root: ShadowRoot; mode: string }> = [];
  Object.defineProperty(win, key, {
    value: {
      installed: true,
      roots,
      rootFor(host: Element) {
        return roots.find((entry) => entry.host === host)?.root;
      },
      modeFor(host: Element) {
        return roots.find((entry) => entry.host === host)?.mode;
      },
    },
    configurable: false,
  });

  Element.prototype.attachShadow = function patchedAttachShadow(init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init);
    roots.push({ host: this, root, mode: init.mode });
    return root;
  };
}
