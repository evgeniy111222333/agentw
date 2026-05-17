import { Browser, chromium, Page } from 'playwright';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';
import { globalSemCache } from '../../src/cache/Sem';
import { SemanticLayer } from '../../src/layer4_semantic/SemanticLayer';

jest.setTimeout(30000);

describe('Semantic cache', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  });

  beforeEach(async () => {
    const config = ConfigurationManager.getInstance().getConfig();
    ConfigurationManager.getInstance().updateConfig({
      semantic: {
        ...config.semantic,
        cache_enabled: true,
        cache_ttl_ms: 30000,
        cache_max_entries: 20,
      },
    });
    globalSemCache.clear();
    page = await browser!.newPage({ viewport: { width: 1280, height: 720 } });
    await page.setContent(cacheHtml());
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
    globalSemCache.clear();
  });

  afterAll(async () => {
    await browser?.close();
    browser = undefined;
  });

  it('reuses unchanged semantic snapshots and invalidates after DOM changes', async () => {
    let authCalls = 0;
    const layer = new SemanticLayer({
      authTracker: {
        inspect: jest.fn(async () => {
          authCalls += 1;
          return {
            authenticated: authCalls > 1,
            confidence: 1,
            method: authCalls > 1 ? 'cookie' : undefined,
            indicators: [`auth-call-${authCalls}`],
            cookies: [],
            updated_at: `2026-05-18T00:00:0${authCalls}.000Z`,
          };
        }),
      } as any,
    });
    const session = {
      session_id: 'cache-session',
      tab_id: 'tab-1',
      tabs_count: 1,
      history_length: 0,
      cookies_count: 0,
    };

    const first = await layer.createSnapshot(page!, { session });
    const second = await layer.createSnapshot(page!, { session, previousSnapshot: first });
    await page!.locator('#change').click();
    const third = await layer.createSnapshot(page!, { session, previousSnapshot: second });

    expect(first.meta?.cache_status).toBe('miss');
    expect(second.meta?.cache_status).toBe('hit');
    expect(second.snapshot_id).not.toBe(first.snapshot_id);
    expect(first.auth?.indicators).toContain('auth-call-1');
    expect(second.auth?.indicators).toContain('auth-call-2');
    expect(third.meta?.cache_status).toBe('miss');
    expect(third.elements.find((element) => element.id === 'status')?.text).toBe('changed');
    expect(globalSemCache.stats()).toEqual(expect.objectContaining({
      hits: 1,
      misses: 2,
    }));
  });
});

function cacheHtml(): string {
  return `<!doctype html>
<html>
  <head><title>Cache</title></head>
  <body>
    <main>
      <h1>Cache</h1>
      <p id="status">stable</p>
      <button id="change" onclick="document.getElementById('status').textContent = 'changed'">Change</button>
    </main>
  </body>
</html>`;
}
