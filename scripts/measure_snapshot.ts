import { chromium } from 'playwright';
import { SemanticLayer } from '../src/layer4_semantic/SemanticLayer';
import { BrowserCore } from '../src/layer1_browser_core/BrowserCore';
import { viewProfiles } from '../src/device/View';

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
    </style>
  </head>
  <body>
    ${decorativeNoise}
    <nav>
      <a href="/home">Home</a>
      <a href="/cart">Cart <span id="cart-count">0</span></a>
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
          <option value="basic">Basic</option>
          <option value="pro" selected>Pro</option>
        </select>
        <input name="invoice" type="file">
        <button type="submit">Pay now</button>
      </form>
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
