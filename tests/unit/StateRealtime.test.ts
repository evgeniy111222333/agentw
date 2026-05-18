import fs from 'fs';
import os from 'os';
import path from 'path';
import { Browser, chromium, Page } from 'playwright';
import { EventBus, globalEventBus } from '../../src/common/EventBus';
import { ActionExecutor } from '../../src/layer2_action_execution/ActionExecutor';
import { StateManagementLayer } from '../../src/layer3_state_management/StateManagementLayer';
import { SemanticLayer } from '../../src/layer4_semantic/SemanticLayer';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';

jest.setTimeout(30000);

describe('real-time state management', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let tempDir: string;
  const configManager = ConfigurationManager.getInstance();
  const originalSemantic = { ...configManager.getConfig().semantic };

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  });

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-browser-state-'));
    process.env.LLM_BROWSER_CHECKPOINT_DIR = path.join(tempDir, 'checkpoints');
    configManager.updateConfig({
      semantic: {
        ...configManager.getConfig().semantic,
        cache_enabled: false,
        max_elements: 500,
      },
    });
    page = await browser!.newPage({ viewport: { width: 800, height: 500 } });
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.LLM_BROWSER_CHECKPOINT_DIR;
  });

  afterAll(async () => {
    configManager.updateConfig({ semantic: originalSemantic });
    await browser?.close();
    browser = undefined;
  });

  it('buffers and persists critical EventBus events', async () => {
    const eventPath = path.join(tempDir, 'events.jsonl');
    const bus = new EventBus({ maxEvents: 2, persistPath: eventPath });

    await bus.publish('node_added', { session_id: 's1', node: 'a' });
    await bus.publish('node_removed', { session_id: 's1', node: 'b' });
    await bus.publish('action_completed', { session_id: 's1', action: 'click' });

    expect(bus.snapshot().events).toHaveLength(2);
    expect(bus.snapshot().dropped_events).toBe(1);
    expect(fs.readFileSync(eventPath, 'utf8')).toContain('action_completed');

    const restored = new EventBus({ maxEvents: 10, persistPath: eventPath });
    expect(restored.list({ type: 'action_completed', session_id: 's1' })).toHaveLength(1);
  });

  it('tracks DOM mutations, aggregate FormState, checkpoints, scroll, lazy content, and auto-scroll', async () => {
    await page!.setContent(`<!doctype html>
      <html>
        <body style="margin:0">
          <form id="login">
            <label>Email <input id="email" name="email" type="email" required></label>
            <label>Password <input id="password" name="password" type="password" required minlength="8"></label>
            <span class="field-error">Password must be 8+ characters</span>
            <button type="submit">Submit</button>
          </form>
          <div id="feed"></div>
          <img id="lazy-img" data-src="real.jpg" width="120" height="120" style="display:block;margin-top:900px">
          <div data-infinite-scroll id="sentinel" style="height:20px;margin-top:1200px"></div>
          <script>
            window.addItem = () => {
              const item = document.createElement('article');
              item.id = 'item-' + document.querySelectorAll('article').length;
              item.textContent = 'New item';
              document.getElementById('feed').appendChild(item);
            };
          </script>
        </body>
      </html>`);

    const state = new StateManagementLayer();
    state.registerSession('state-session');
    await state.injectAllTrackers(page!, 'state-session');
    await page!.waitForTimeout(100);

    await page!.fill('#email', 'user@example.com');
    await page!.fill('#password', 'short');
    await page!.waitForTimeout(100);

    const form = state.getFormStates('state-session').login;
    expect(form).toEqual(expect.objectContaining({
      form_id: 'login',
      is_dirty: true,
      is_valid: false,
      completion_percentage: 100,
    }));
    expect(form.fields).toEqual(expect.objectContaining({
      email: 'user@example.com',
      password: '[masked]',
    }));
    expect(form.errors.join(' ')).toMatch(/8|characters|invalid/i);

    const domEvents: any[] = [];
    const onDom = (payload: any) => {
      domEvents.push(payload);
    };
    globalEventBus.subscribe('dom_mutated', onDom);
    await page!.evaluate(() => (window as any).addItem());
    await page!.waitForTimeout(700);
    globalEventBus.unsubscribe('dom_mutated', onDom);

    expect(domEvents.some((event) => event.session_id === 'state-session' && event.mutations.some((mutation: any) => mutation.type === 'childList'))).toBe(true);
    expect(state.getRecentMutations('state-session').some((mutation) => mutation.type === 'childList')).toBe(true);

    const checkpoint = await state.checkpointSession('state-session', 'test');
    expect(checkpoint && fs.existsSync(checkpoint)).toBe(true);
    const restored = new StateManagementLayer();
    expect(restored.restoreCheckpoint('state-session')).toBe(true);
    expect(restored.getFormStates('state-session').login.fields.email).toBe('user@example.com');

    const snapshot = await new SemanticLayer().createSnapshot(page!, {
      session: {
        session_id: 'state-session',
        tab_id: 'tab-1',
        tabs_count: 1,
        history_length: 0,
        cookies_count: 0,
      },
    });
    expect(snapshot.meta?.scroll).toEqual(expect.objectContaining({
      position: 0,
      viewport_height: 500,
      lazy_count: expect.any(Number),
      infinite_scroll: expect.objectContaining({ detected: true }),
    }));
    expect(snapshot.elements).toContainEqual(expect.objectContaining({
      id: 'lazy-img',
      lazy: expect.objectContaining({ lazy: true, loaded: false, trigger: 'scroll_into_view' }),
    }));

    const executor = new ActionExecutor({ getPage: () => page } as any);
    const result = await executor.executeAction('state-session', 'scroll', undefined, {
      mode: 'auto_scroll',
      max_items: 4,
      stall_timeout_ms: 500,
      amount: 700,
    });
    expect(result.data?.scroll.percentage).toBeGreaterThan(0);
    expect(result.data?.auto_scroll.iterations).toBeGreaterThan(0);
  });
});
