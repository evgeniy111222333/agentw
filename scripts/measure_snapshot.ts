import { chromium } from 'playwright';
import { SemanticLayer } from '../src/layer4_semantic/SemanticLayer';

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
        plugin_contributions: first.meta?.plugin_contributions,
        sam_actions: first.available_actions.filter((action) => action.source?.standard === 'SAM').length,
        flow_actions: first.available_actions.filter((action) =>
          ['fill_form', 'search_and_paginate', 'wait_for'].includes(action.action)
        ).length,
        file_actions: first.available_actions.filter((action) =>
          ['upload', 'download', 'screenshot_file', 'pdf', 'fs'].includes(action.action)
        ).length,
        cache_status: first.meta?.cache_status,
      },
      repeat_snapshot: {
        extraction_ms: repeat.meta?.extraction_time,
        cache_status: repeat.meta?.cache_status,
        cache_age_ms: repeat.meta?.cache_age_ms,
        delta_operations: repeat.delta?.operations.length ?? 0,
      },
      second_snapshot: {
        elements: second.elements.length,
        actions: second.available_actions.length,
        extraction_ms: second.meta?.extraction_time,
        delta_operations: second.delta?.operations.length ?? 0,
        delta_stats: second.delta?.stats,
        cache_status: second.meta?.cache_status,
        plugin_contributions: second.meta?.plugin_contributions,
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
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
    </main>
  </body>
</html>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
