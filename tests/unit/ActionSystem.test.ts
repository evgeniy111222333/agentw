import { Browser, chromium, Page } from 'playwright';
import { ActionExecutor } from '../../src/layer2_action_execution/ActionExecutor';
import { globalEventBus } from '../../src/common/EventBus';

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
});
