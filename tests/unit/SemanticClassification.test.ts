import { Browser, chromium, Page } from 'playwright';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';
import { ActionExecutor } from '../../src/layer2_action_execution/ActionExecutor';
import { SemanticLayer } from '../../src/layer4_semantic/SemanticLayer';

jest.setTimeout(30000);

describe('semantic classification and multimedia extraction', () => {
  const configManager = ConfigurationManager.getInstance();
  const originalSemantic = { ...configManager.getConfig().semantic };
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  });

  beforeEach(async () => {
    configManager.updateConfig({
      semantic: {
        ...configManager.getConfig().semantic,
        cache_enabled: false,
        max_elements: 500,
        max_elements_hard_limit: 1000,
      },
    });
    page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  afterAll(async () => {
    configManager.updateConfig({ semantic: originalSemantic });
    await browser?.close();
    browser = undefined;
  });

  it('extracts div-soup components, rich attributes, and media metadata', async () => {
    await page!.setContent(`<!doctype html>
      <html>
        <head>
          <title>Semantic Fixtures</title>
          <style>
            .product-card { width: 320px; border: 1px solid #ddd; padding: 12px; border-radius: 8px; }
            .skeleton { width: 180px; height: 24px; display: block; background: #eee; }
            .rating { width: 160px; }
            canvas { width: 400px; height: 160px; }
          </style>
        </head>
        <body>
          <nav id="crumbs" aria-label="Breadcrumb">
            <a href="/home">Home</a><a href="/catalog">Catalog</a><span aria-current="page">Plan</span>
          </nav>
          <nav id="pager" class="pagination" data-current="2" data-total-pages="4">
            <a href="?p=1">1</a><a aria-current="page" href="?p=2">2</a><a href="?p=3">Next</a>
          </nav>
          <main>
            <div id="plan-card" class="product-card" data-title="Pro Plan" data-subtitle="$29 per month">
              <img id="plan-img" src="plan.webp" alt="Pro plan dashboard" width="80" height="60">
              <h2>Pro Plan</h2>
              <p>$29 per month</p>
              <button id="buy" class="btn btn-primary">Buy now</button>
            </div>
            <details id="faq" class="accordion-item" open><summary>Billing</summary><p>Monthly billing.</p></details>
            <div id="hero-carousel" class="carousel"><div class="slide active">One</div><div class="slide">Two</div><button>Next</button></div>
            <div id="stars" class="rating" aria-label="4.5 out of 5 stars">★★★★☆</div>
            <ol id="checkout-steps" class="checkout steps"><li>Cart</li><li aria-current="step">Payment</li><li>Done</li></ol>
            <div id="loading-row" class="skeleton shimmer" aria-label="Loading row"></div>
            <textarea id="notes" name="notes" placeholder="Internal notes" maxlength="500" rows="4"></textarea>
            <select id="country" name="country">
              <optgroup label="Europe"><option value="ua" selected>Ukraine</option></optgroup>
              <optgroup label="Asia"><option value="jp">Japan</option></optgroup>
            </select>
            <table id="usage" data-total-rows="25" data-page="1" data-per-page="10" data-total-pages="3">
              <caption>Usage</caption>
              <thead><tr><th aria-sort="ascending">Date</th><th>Requests</th></tr></thead>
              <tbody><tr><td>2026-05-18</td><td>1200</td></tr></tbody>
            </table>
            <canvas id="revenue" data-chart-type="line" data-chart-data="Revenue grew from 12 to 45"></canvas>
            <svg id="svg-chart" class="chart" width="220" height="120" viewBox="0 0 220 120"><title>Retention</title><desc>Retention by cohort</desc><text x="10" y="20">Week 1 92%</text></svg>
            <svg id="decorative-icon" aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="4"></circle></svg>
            <img id="decorative-img" alt="" width="20" height="20" src="dot.png">
            <video id="demo-video" title="Demo video" controls poster="poster.jpg"><source src="demo.mp4" type="video/mp4"><track kind="captions" src="demo.vtt" label="English"></video>
            <audio id="podcast" title="Podcast" controls><source src="episode.mp3" type="audio/mpeg"><track kind="captions" src="episode.vtt" label="Transcript"></audio>
            <button id="delete" class="btn danger" aria-busy="true" title="Deletes plan">Delete plan</button>
          </main>
        </body>
      </html>`);

    const snap = await new SemanticLayer().createSnapshot(page!, {
      session: {
        session_id: 'semantic-fixtures',
        tab_id: 'tab-1',
        tabs_count: 1,
        history_length: 0,
        cookies_count: 0,
      },
    });

    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'plan-card',
      type: 'card',
      title: 'Pro Plan',
      subtitle: '$29 per month',
      image_id: 'plan-img',
      actions: expect.arrayContaining(['buy']),
      classification: expect.objectContaining({ level: 'heuristic' }),
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'crumbs',
      type: 'breadcrumb',
      items: expect.arrayContaining([expect.objectContaining({ label: 'Home' })]),
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'pager',
      type: 'pagination',
      current_page: 2,
      total_pages: 4,
      pages: expect.arrayContaining([expect.objectContaining({ label: 'Next' })]),
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'faq',
      type: 'accordion',
      expanded: true,
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'hero-carousel',
      type: 'carousel',
      slides: expect.arrayContaining([expect.objectContaining({ label: 'One' })]),
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'stars',
      type: 'rating',
      value: 4.5,
      max: 5,
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'checkout-steps',
      type: 'stepper',
      total: 3,
      current: 2,
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'loading-row',
      type: 'skeleton',
      loading: true,
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'notes',
      type: 'textarea',
      maxlength: 500,
      rows: 4,
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'country',
      type: 'select',
      optgroups: ['Europe', 'Asia'],
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'usage',
      type: 'table',
      caption: 'Usage',
      sorted_by: 'date',
      sort_direction: 'asc',
      total_rows: 25,
      pagination: expect.objectContaining({ page: 1, per_page: 10, total_pages: 3 }),
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'revenue',
      type: 'chart',
      chart_type: 'line',
      data_summary: 'Revenue grew from 12 to 45',
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'svg-chart',
      type: 'chart',
      data_summary: expect.stringContaining('Retention'),
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'demo-video',
      type: 'video',
      poster: 'poster.jpg',
      tracks: expect.arrayContaining([expect.objectContaining({ kind: 'captions' })]),
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'podcast',
      type: 'audio',
      format: 'mp3',
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'delete',
      type: 'button',
      variant: 'danger',
      destructive: true,
      loading: true,
      tooltip: 'Deletes plan',
    }));
    expect(snap.elements.some((element) => element.id === 'decorative-icon')).toBe(false);
    expect(snap.elements.some((element) => element.id === 'decorative-img')).toBe(false);
    expect(snap.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'type', target: 'notes' }),
      expect.objectContaining({ action: 'select', target: 'country' }),
      expect.objectContaining({ action: 'media_control', target: 'podcast' }),
    ]));
    expect(snap.navigation.breadcrumbs).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Home' })]));
    expect(snap.navigation.pagination).toEqual(expect.objectContaining({ current_page: 2, total_pages: 4 }));

    const executor = new ActionExecutor({ getPage: () => page } as any);
    const media = await executor.executeAction('session', 'media_control', 'podcast', { command: 'mute' });
    expect(media.action).toBe('media_control');
    expect(media.data).toEqual(expect.objectContaining({ command: 'mute', muted: true }));
    expect(await page!.locator('#podcast').evaluate((node) => (node as HTMLAudioElement).muted)).toBe(true);
  });
});
