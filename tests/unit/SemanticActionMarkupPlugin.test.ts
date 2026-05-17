import { chromium, Browser, Page } from 'playwright';
import { SemanticLayer } from '../../src/layer4_semantic/SemanticLayer';

jest.setTimeout(30000);

describe('SemanticActionMarkupPlugin', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  });

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('adds SAM data-attribute and script actions to semantic snapshots', async () => {
    await page.setContent(`<!doctype html>
      <html>
        <head><title>SAM test</title></head>
        <body>
          <button
            id="buy"
            data-semantic-action="add_to_cart"
            data-semantic-label="Add premium plan"
            data-semantic-params='{"sku":"premium"}'
          >Buy</button>
          <script type="application/llm-actions+json">
            {"actions":[{"action":"checkout","label":"Checkout now","selector":"#buy","execution":{"action":"click"}}]}
          </script>
        </body>
      </html>`);

    const snapshot = await new SemanticLayer().createSnapshot(page, {
      session: {
        session_id: 'session-1',
        tab_id: 'tab-1',
        tabs_count: 1,
        history_length: 0,
        cookies_count: 0,
      },
    });

    expect(snapshot.available_actions).toContainEqual(expect.objectContaining({
      action: 'add_to_cart',
      target: 'buy',
      label: 'Add premium plan',
      source: expect.objectContaining({ standard: 'SAM' }),
      execution: expect.objectContaining({ action: 'click', target: 'buy' }),
      params: expect.objectContaining({ sku: 'premium' }),
    }));
    expect(snapshot.available_actions).toContainEqual(expect.objectContaining({
      action: 'checkout',
      target: 'buy',
      execution: expect.objectContaining({ action: 'click', target: 'buy' }),
    }));
    expect(snapshot.meta?.plugin_contributions?.actions).toBeGreaterThanOrEqual(2);
  });
});
