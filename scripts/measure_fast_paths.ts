import { BrowserCore } from '../src/layer1_browser_core/BrowserCore';
import { StateManagementLayer } from '../src/layer3_state_management/StateManagementLayer';
import { ActionExecutor } from '../src/layer2_action_execution/ActionExecutor';
import { SemanticLayer } from '../src/layer4_semantic/SemanticLayer';
import { Bouncer } from '../src/layer2_action_execution/Bouncer';
import { ConfigurationManager } from '../src/config/ConfigurationManager';

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - start), value };
}

async function main(): Promise<void> {
  const config = ConfigurationManager.getInstance();
  config.updateConfig({
    semantic: {
      ...config.getConfig().semantic,
      cache_enabled: false,
    },
  });

  const core = new BrowserCore();
  const state = new StateManagementLayer();
  const executor = new ActionExecutor(core);
  const semantic = new SemanticLayer();
  const sessionId = 'fast-path-measure';

  await core.initialize();
  await core.createSession(sessionId);
  state.registerSession(sessionId);

  const page = core.getPage(sessionId);
  await page.setContent(`
    <main>
      <h1>Fast path fixture</h1>
      <label>Search <input id="search" type="search" placeholder="Search"></label>
      <button id="add" onclick="document.getElementById('status').textContent = document.getElementById('search').value">Add to Cart</button>
      <span class="price">$19.99</span>
      <p id="status">idle</p>
      ${Array.from({ length: 500 }, (_, index) => `<div class="noise"><span>decorative node ${index}</span></div>`).join('')}
    </main>
    <div role="dialog" class="cookie-modal" style="position:fixed;inset:0;background:white;z-index:99">
      <p>We use cookies.</p><button onclick="this.closest('[role=dialog]').remove()">Accept all</button>
    </div>
  `);

  const session = {
    session_id: sessionId,
    tab_id: 'tab-1',
    tabs_count: 1,
    history_length: 0,
    cookies_count: 0,
  };

  const bounce = await timed(() => new Bouncer().dismiss(page));
  const full = await timed(() => semantic.createSnapshot(page, { session, maxElements: 800, forceRefresh: true }));
  const actionable = await timed(() => semantic.createSnapshot(page, {
    session,
    maxElements: 800,
    actionableOnly: true,
    affordances: ['clickable', 'fillable'],
    forceRefresh: true,
  }));
  const type = await timed(() => executor.executeAction(sessionId, 'type', undefined, {
    target_semantic: 'input with label "Search"',
    text: 'headphones',
  }));
  const click = await timed(() => executor.executeAction(sessionId, 'click', undefined, {
    target_semantic: 'button with text "Add to Cart"',
  }));
  const evaluate = await timed(() => executor.executeAction(sessionId, 'evaluate', undefined, {
    script: "document.querySelector('.price')?.textContent",
  }));
  const status = await page.locator('#status').textContent();

  console.log(JSON.stringify({
    bouncer: { ms: bounce.ms, closed: bounce.value.closed },
    full_snapshot: {
      ms: full.ms,
      elements: full.value.elements.length,
      actions: full.value.available_actions.length,
      bytes: Buffer.byteLength(JSON.stringify(full.value)),
    },
    actionable_snapshot: {
      ms: actionable.ms,
      elements: actionable.value.elements.length,
      actions: actionable.value.available_actions.length,
      bytes: Buffer.byteLength(JSON.stringify(actionable.value)),
      filter: actionable.value.meta?.filter,
    },
    zero_shot_type: {
      ms: type.ms,
      attempts: type.value.data?.attempts ?? 1,
    },
    zero_shot_click: {
      ms: click.ms,
      attempts: click.value.data?.attempts ?? 1,
      status,
    },
    evaluate: {
      ms: evaluate.ms,
      result: evaluate.value.data?.result,
    },
  }, null, 2));

  await core.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
