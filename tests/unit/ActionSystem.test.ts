import { Browser, chromium, Page } from 'playwright';
import { ActionExecutor } from '../../src/layer2_action_execution/ActionExecutor';
import { globalEventBus } from '../../src/common/EventBus';
import { Bouncer } from '../../src/layer2_action_execution/Bouncer';

jest.setTimeout(30000);

describe('Declarative action system', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let executor: ActionExecutor;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  });

  beforeEach(async () => {
    page = await browser!.newPage({ viewport: { width: 1024, height: 768 } });
    executor = new ActionExecutor({ getPage: () => page } as any);
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  afterAll(async () => {
    await browser?.close();
    browser = undefined;
  });

  it('retries transient failures with classified retry events', async () => {
    const events: any[] = [];
    const onRetry = (payload: any) => {
      events.push(payload);
    };
    globalEventBus.subscribe('action_retry', onRetry);

    const retrying = new ActionExecutor({ getPage: () => ({}) } as any);
    let calls = 0;
    (retrying as any).dispatch = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('Timeout while waiting for element');
      return { ok: true };
    });

    try {
      const result = await retrying.executeAction('session', 'click', 'target');
      expect(result.data).toEqual(expect.objectContaining({ ok: true, attempts: 3 }));
      expect(calls).toBe(3);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(expect.objectContaining({
        action: 'click',
        error_class: 'transient',
        error_code: 'TIMEOUT_ACTION',
        delay_ms: 100,
        remaining: 2,
      }));
      expect(events[1]).toEqual(expect.objectContaining({ delay_ms: 200, remaining: 1 }));
    } finally {
      globalEventBus.unsubscribe('action_retry', onRetry);
    }
  });

  it('does not retry permanent element lookup failures', async () => {
    const retrying = new ActionExecutor({ getPage: () => ({}) } as any);
    let calls = 0;
    (retrying as any).dispatch = jest.fn(async () => {
      calls += 1;
      throw new Error('Element not found: missing');
    });

    await expect(retrying.executeAction('session', 'click', 'missing')).rejects.toMatchObject({
      code: 'ELEMENT_NOT_FOUND',
    });
    expect(calls).toBe(1);
  });

  it('rolls back fill_and_verify when verification fails', async () => {
    await page!.setContent(`
      <form id="profile">
        <label>Email <input id="email" name="email" value="old@example.com"></label>
      </form>
    `);

    const readField = (executor as any).readField.bind(executor);
    let reads = 0;
    (executor as any).readField = async (...args: any[]) => {
      const state = await readField(...args);
      reads += 1;
      return reads >= 3 ? { ...state, value: 'wrong@example.com' } : state;
    };

    await expect(executor.executeAction('session', 'fill_and_verify', 'profile', {
      fields: { email: 'new@example.com' },
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(page!.locator('#email').inputValue()).resolves.toBe('old@example.com');
  });

  it('runs parameterized scripts and try-catch fallbacks', async () => {
    await page!.setContent(`
      <form id="profile">
        <label>Email <input id="email" name="email"></label>
      </form>
      <button id="fallback" onclick="document.getElementById('status').textContent='fallback'">Fallback</button>
      <p id="status">idle</p>
    `);

    await executor.executeAction('session', 'define_script', undefined, {
      name: 'set_email',
      params: ['email'],
      steps: [
        { action: 'type', target_id: 'email', params: { text: '{{email}}' } },
      ],
    });
    await executor.executeAction('session', 'call_script', undefined, {
      name: 'set_email',
      args: { email: 'script@example.com' },
    });
    await expect(page!.locator('#email').inputValue()).resolves.toBe('script@example.com');

    const recovered = await executor.executeAction('session', 'try', undefined, {
      do: { action: 'unsupported_action' },
      catch: [
        {
          error_code: '*',
          fallback: { action: 'click', target_id: 'fallback' },
        },
      ],
    });

    expect(recovered.data).toEqual(expect.objectContaining({
      mode: 'try',
      branch: 'catch',
      status: 'success',
    }));
    await expect(page!.locator('#status').textContent()).resolves.toBe('fallback');
  });

  it('isolates scripts per session and blocks recursive script calls', async () => {
    await page!.setContent('<input id="email">');

    await executor.executeAction('session-a', 'define_script', undefined, {
      name: 'login',
      steps: [{ action: 'type', target_id: 'email', params: { text: 'a@example.com' } }],
    });

    await expect(executor.executeAction('session-b', 'call_script', undefined, {
      name: 'login',
    })).rejects.toMatchObject({ code: 'SCRIPT_NOT_FOUND' });

    await executor.executeAction('session-a', 'define_script', undefined, {
      name: 'loop',
      steps: [{ action: 'call_script', params: { name: 'loop' } }],
    });

    await expect(executor.executeAction('session-a', 'call_script', undefined, {
      name: 'loop',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('evaluates custom_javascript wait conditions', async () => {
    await page!.setContent('<p id="status">idle</p>');
    await page!.evaluate(() => {
      setTimeout(() => {
        (window as any).readyForAgent = true;
      }, 50);
    });

    const result = await executor.executeAction('session', 'wait_for', undefined, {
      condition: { type: 'custom_javascript', expression: 'window.readyForAgent === true' },
      timeout_ms: 1000,
      poll_interval_ms: 25,
    });

    expect(result.data).toEqual(expect.objectContaining({ matched: true }));
  });

  it('executes zero-shot semantic click and type without a prior snapshot', async () => {
    await page!.setContent(`
      <label>Search <input id="search"></label>
      <button onclick="document.getElementById('status').textContent = document.getElementById('search').value">
        Add to Cart
      </button>
      <p id="status">idle</p>
    `);

    await executor.executeAction('session', 'type', undefined, {
      target_semantic: 'input with label "Search"',
      text: 'headphones',
    });
    await executor.executeAction('session', 'click', undefined, {
      target_semantic: 'button with text "Add to Cart"',
    });

    await expect(page!.locator('#status').textContent()).resolves.toBe('headphones');
  });

  it('evaluates read-only snippets and blocks obvious mutations by default', async () => {
    await page!.setContent('<span class="price">$19.99</span>');

    const result = await executor.executeAction('session', 'evaluate', undefined, {
      script: "document.querySelector('.price')?.textContent",
    });

    expect(result.data).toEqual(expect.objectContaining({ result: '$19.99', read_only: true }));
    await expect(executor.executeAction('session', 'evaluate', undefined, {
      script: "document.querySelector('.price').textContent = '$0'",
    })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    await expect(executor.executeAction('session', 'evaluate', undefined, {
      script: "window['fet' + 'ch']('/leak')",
    })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
  });

  it('supports discovered convenience form/input actions', async () => {
    await page!.setContent(`
      <form id="profile">
        <input id="agree" type="checkbox">
        <input id="name" value="old">
      </form>
    `);

    await executor.executeAction('session', 'check', 'agree', { checked: true });
    await executor.executeAction('session', 'clear', 'name');
    await executor.executeAction('session', 'append', 'name', { text: 'new' });
    const validation = await executor.executeAction('session', 'validate_form', 'profile');

    await expect(page!.locator('#agree').isChecked()).resolves.toBe(true);
    await expect(page!.locator('#name').inputValue()).resolves.toBe('new');
    expect(validation.data).toEqual(expect.objectContaining({ valid: true }));
  });

  it('bounces safe cookie popups before extraction', async () => {
    await page!.setContent(`
      <main><button id="buy">Buy</button></main>
      <div role="dialog" class="cookie-modal" style="position:fixed;inset:0;background:white">
        <p>We use cookies for analytics.</p>
        <button id="accept">Accept all</button>
      </div>
    `);

    const result = await new Bouncer().dismiss(page!);

    expect(result.closed).toBe(1);
    expect(result.actions[0]).toEqual(expect.objectContaining({ text: 'Accept all' }));
  });
});
