import { chromium } from 'playwright';
import { SemanticLayer } from '../src/layer4_semantic/SemanticLayer';
import { BrowserCore } from '../src/layer1_browser_core/BrowserCore';
import { viewProfiles } from '../src/device/View';

const COMPONENT_TYPES = new Set([
  'card',
  'pagination',
  'breadcrumb',
  'accordion',
  'carousel',
  'rating',
  'stepper',
  'skeleton',
  'chart',
  'tab_group',
  'menu',
  'modal',
  'dialog',
]);

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.setContent(benchmarkHtml(), { waitUntil: 'load' });

    const semanticLayer = new SemanticLayer();
    const session = {
      session_id: 'measurement-session',
      tab_id: 'tab-1',
      tabs_count: 1,
      history_length: 0,
      cookies_count: 0,
    };

    const first = await semanticLayer.createSnapshot(page, { session });
    const repeat = await semanticLayer.createSnapshot(page, {
      session,
      previousSnapshot: first,
    });
    await page.getByRole('button', { name: 'Add credits' }).click();
    const second = await semanticLayer.createSnapshot(page, {
      session: { ...session, history_length: 1 },
      previousSnapshot: first,
    });
    await page.setViewportSize({ width: viewProfiles.mobile.width, height: viewProfiles.mobile.height });
    const mobile = await semanticLayer.createSnapshot(page, {
      session: {
        ...session,
        viewport: viewProfiles.mobile,
      },
      previousSnapshot: second,
    });

    const report = {
      first_snapshot: {
        elements: first.elements.length,
        actions: first.available_actions.length,
        forms: first.forms?.length ?? 0,
        extraction_ms: first.meta?.extraction_time,
        raw_dom_bytes: first.meta?.raw_dom_bytes,
        snapshot_bytes: first.meta?.snapshot_bytes,
        token_estimate: first.meta?.token_estimate,
        compression_ratio: first.meta?.compression_ratio,
        max_elements: first.meta?.max_elements,
        semantic_nodes_total: first.meta?.semantic_nodes_total,
        encapsulation: first.meta?.encapsulation,
        scroll: first.meta?.scroll,
        form_state: first.forms?.[0]
          ? {
              is_dirty: first.forms[0].is_dirty,
              is_valid: first.forms[0].is_valid,
              completion_percentage: first.forms[0].completion_percentage,
              errors: first.forms[0].errors?.length ?? 0,
              field_count: Object.keys(first.forms[0].field_values ?? {}).length,
            }
          : undefined,
        privacy: first.meta?.privacy,
        plugin_contributions: first.meta?.plugin_contributions,
        sam_actions: first.available_actions.filter((action) => action.source?.standard === 'SAM').length,
        flow_actions: first.available_actions.filter((action) =>
          ['fill_form', 'search_and_paginate', 'wait_for'].includes(action.action)
        ).length,
        file_actions: first.available_actions.filter((action) =>
          ['upload', 'download', 'screenshot_file', 'pdf', 'fs'].includes(action.action)
        ).length,
        auth: {
          authenticated: first.auth?.authenticated,
          method: first.auth?.method,
          confidence: first.auth?.confidence,
          indicators: first.auth?.indicators,
        },
        type_counts: countBy(first.elements, (element) => element.type),
        classification_levels: countBy(first.elements, (element) => element.classification?.level ?? 'unknown'),
        low_confidence: first.elements.filter((element) => element.classification?.low_confidence).length,
        component_types: countBy(first.elements.filter((element) => element.component || COMPONENT_TYPES.has(element.type)), (element) => element.type),
        media_types: countBy(first.elements.filter((element) => element.media_state || element.data_summary || ['image', 'video', 'audio', 'chart'].includes(element.type)), (element) => element.type),
        cache_status: first.meta?.cache_status,
      },
      repeat_snapshot: {
        extraction_ms: repeat.meta?.extraction_time,
        cache_status: repeat.meta?.cache_status,
        cache_age_ms: repeat.meta?.cache_age_ms,
        delta_operations: repeat.delta?.operations.length ?? 0,
        privacy: repeat.meta?.privacy,
      },
      second_snapshot: {
        elements: second.elements.length,
        actions: second.available_actions.length,
        extraction_ms: second.meta?.extraction_time,
        delta_operations: second.delta?.operations.length ?? 0,
        delta_stats: second.delta?.stats,
        cache_status: second.meta?.cache_status,
        privacy: second.meta?.privacy,
        plugin_contributions: second.meta?.plugin_contributions,
      },
      mobile_snapshot: {
        elements: mobile.elements.length,
        actions: mobile.available_actions.length,
        extraction_ms: mobile.meta?.extraction_time,
        viewport: mobile.meta?.viewport,
        cache_status: mobile.meta?.cache_status,
        delta_operations: mobile.delta?.operations.length ?? 0,
      },
      tabs: await measureTabs(),
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

async function measureTabs() {
  const core = new BrowserCore();
  await core.initialize();
  try {
    const sessionId = 'measurement-tabs';
    await core.createSession(sessionId);
    const viewportStarted = performance.now();
    const viewport = await core.setViewport(sessionId, 'mobile');
    const viewportMs = Math.round(performance.now() - viewportStarted);

    const openStarted = performance.now();
    const opened = await core.openTab(sessionId, `data:text/html;charset=utf-8,${encodeURIComponent(tabHtml('Measure Tab'))}`);
    const openMs = Math.round(performance.now() - openStarted);

    const listStarted = performance.now();
    const tabsOpen = await core.listTabs(sessionId);
    const listMs = Math.round(performance.now() - listStarted);

    const switchStarted = performance.now();
    const switched = await core.switchTab(sessionId, 'tab-1');
    const switchMs = Math.round(performance.now() - switchStarted);

    const closeStarted = performance.now();
    const closed = await core.closeTab(sessionId, opened.tab_id);
    const closeMs = Math.round(performance.now() - closeStarted);
    const tabsFinal = await core.listTabs(sessionId);
    const eventsStarted = performance.now();
    const events = core.listEvents(sessionId, { limit: 50 });
    const eventsMs = Math.round(performance.now() - eventsStarted);
    const eventStats = core.eventStats(sessionId);

    return {
      open_ms: openMs,
      viewport_ms: viewportMs,
      viewport,
      list_ms: listMs,
      switch_ms: switchMs,
      close_ms: closeMs,
      opened: { tab_id: opened.tab_id, title: opened.title },
      after_open_count: tabsOpen.length,
      switched_to: switched.tab_id,
      closed: closed.closed_tab_id,
      final_count: tabsFinal.length,
      events_ms: eventsMs,
      events_total: eventStats.total,
      events_by_kind: eventStats.by_kind,
      recent_console: events.filter((event) => event.kind === 'console').slice(-3).map((event) => event.text),
    };
  } finally {
    await core.close();
  }
}

function benchmarkHtml(): string {
  const decorativeNoise = Array.from({ length: 120 }, (_, index) =>
    `<div class="layout css-${index}"><span class="spacer"></span><div data-reactid="${index}"></div></div>`
  ).join('');

  return `<!doctype html>
<html>
  <head>
    <title>LLM Browser Measurement</title>
    <style>
      body { font-family: sans-serif; }
      .muted { color: #666; }
      .product-card { width: 320px; border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 12px 0; }
      .pagination a { margin-right: 8px; }
      .skeleton { width: 220px; height: 24px; background: #eee; display: block; }
      .rating { cursor: default; }
      canvas { width: 420px; height: 160px; }
    </style>
  </head>
  <body>
    ${decorativeNoise}
    <nav aria-label="Breadcrumb" class="breadcrumbs">
      <a href="/home">Home</a>
      <a href="/billing">Billing</a>
      <span aria-current="page">Checkout</span>
    </nav>
    <nav>
      <a href="/home">Home</a>
      <a href="/cart">Cart <span id="cart-count">0</span></a>
    </nav>
    <nav class="pagination" data-current="2" data-total-pages="5">
      <a href="?page=1">1</a><a href="?page=2" aria-current="page">2</a><a href="?page=3">Next</a>
    </nav>
    <main>
      <h1>Checkout</h1>
      <p id="account">Signed in as measure@example.com</p>
      <button id="logout">Logout</button>
      <p class="muted">A compact benchmark page with links, form fields, table data, and dynamic state.</p>
      <form id="checkout" method="post" action="/pay" autocomplete="on">
        <label>Email <input name="email" type="email" required placeholder="you@example.com"></label>
        <label>Password <input name="password" type="password" value="secret"></label>
        <select name="plan">
          <optgroup label="Public">
            <option value="basic">Basic</option>
            <option value="pro" selected>Pro</option>
          </optgroup>
          <optgroup label="Enterprise">
            <option value="team">Team</option>
          </optgroup>
        </select>
        <textarea id="notes" name="notes" placeholder="Internal notes" maxlength="500"></textarea>
        <input name="invoice" type="file">
        <button type="submit">Pay now</button>
      </form>
      <div id="plan-card" class="product-card" data-title="API Credits" data-subtitle="$20 prepaid">
        <img id="plan-img" src="credits.webp" alt="API credits pack" width="80" height="60">
        <h2>API Credits</h2>
        <p>$20 prepaid balance</p>
        <button id="card-buy" class="btn-primary">Add pack</button>
      </div>
      <details id="faq" class="accordion-item" open><summary>Billing policy</summary><p>Monthly invoices are available.</p></details>
      <div id="plans-carousel" class="carousel"><div class="slide active">Starter</div><div class="slide">Scale</div><button>Next</button></div>
      <div id="rating" class="rating" aria-label="4.5 out of 5 stars">★★★★☆</div>
      <ol id="steps" class="checkout steps"><li>Cart</li><li aria-current="step">Payment</li><li>Done</li></ol>
      <div id="loading" class="skeleton shimmer" aria-label="Loading row"></div>
      <canvas id="usage-chart" data-chart-type="bar" data-chart-data="Usage rose from 1200 to 2400 requests"></canvas>
      <svg id="retention-chart" class="chart" width="220" height="120" viewBox="0 0 220 120"><title>Retention</title><desc>Retention by cohort</desc><text x="10" y="20">Week 1 92%</text></svg>
      <video id="intro-video" title="Intro video" controls poster="intro.jpg"><source src="intro.mp4" type="video/mp4"><track kind="captions" src="intro.vtt" label="English"></video>
      <audio id="briefing" title="Briefing" controls><source src="briefing.mp3" type="audio/mpeg"><track kind="captions" src="briefing.vtt" label="Transcript"></audio>
      <a download="invoice.csv" href="data:text/csv;base64,aXRlbSxwcmljZQpjcmVkaXRzLDIw">Download invoice</a>
      <iframe id="measure-frame" title="Embedded checkout helper" srcdoc="<button id='frame-help'>Frame Help</button><input id='frame-note' placeholder='Frame note'>"></iframe>
      <iframe id="measure-video" title="Demo video" src="https://www.youtube.com/embed/abc123"></iframe>
      <iframe id="measure-ad" width="300" height="250" data-ad-client="ca-pub-1" src="https://googleads.g.doubleclick.net/pagead/ads"></iframe>
      <measure-card id="measure-card"><span slot="label">Slotted benchmark label</span></measure-card>
      <button
        data-semantic-action="add_credits"
        data-semantic-label="Add credits to cart"
        data-semantic-params='{"sku":"credits-20"}'
        onclick="document.getElementById('cart-count').textContent = '1'; this.textContent = 'Credits added';"
      >
        Add credits
      </button>
      <script type="application/llm-actions+json">
        {
          "actions": [
            {
              "action": "quick_checkout",
              "label": "Quick checkout",
              "selector": "form#checkout button[type='submit']",
              "execution": { "action": "click" },
              "preconditions": ["email_valid", "plan_selected"],
              "risk": "medium"
            }
          ]
        }
      </script>
      <table>
        <tr><th>Item</th><th>Price</th></tr>
        <tr><td>API credits</td><td>$20</td></tr>
      </table>
      <script>
        customElements.define('measure-card', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<button id="shadow-action">Shadow Action</button><slot name="label"></slot>';
          }
        });
      </script>
    </main>
  </body>
</html>`;
}

function tabHtml(title: string): string {
  return `<!doctype html>
<html>
  <head><title>${title}</title></head>
  <body>
    <main><h1>${title}</h1></main>
    <script>
      console.log('${title} console ready');
      fetch('data:application/json,%7B%22ok%22%3Atrue%7D').then(() => console.log('${title} fetch done'));
    </script>
  </body>
</html>`;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
