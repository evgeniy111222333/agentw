import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { ConfigurationManager } from '../config/ConfigurationManager';

export class BrowserCore {
  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();

  async initialize(): Promise<void> {
    const config = ConfigurationManager.getInstance().getConfig().browser;
    this.browser = await chromium.launch({
      headless: true,
      executablePath: config.chromium_path,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  }

  async createSession(sessionId: string): Promise<void> {
    if (!this.browser) throw new Error('Browser not initialized');
    
    const config = ConfigurationManager.getInstance().getConfig().browser;
    const context = await this.browser.newContext({
      viewport: config.viewport,
      userAgent: config.user_agent,
      ignoreHTTPSErrors: config.ignore_https_errors,
    });
    
    this.contexts.set(sessionId, context);
    const page = await context.newPage();
    this.pages.set(sessionId, page);
  }

  async closeSession(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (context) {
      await context.close();
      this.contexts.delete(sessionId);
      this.pages.delete(sessionId);
    }
  }

  getPage(sessionId: string): Page {
    const page = this.pages.get(sessionId);
    if (!page) throw new Error(`Page for session ${sessionId} not found`);
    return page;
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    const page = this.getPage(sessionId);
    await page.goto(url, { waitUntil: 'load' });
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
}
