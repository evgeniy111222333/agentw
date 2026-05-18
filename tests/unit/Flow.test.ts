import { Browser, chromium, Page } from 'playwright';
import { ActionExecutor } from '../../src/layer2_action_execution/ActionExecutor';
import { createServer, Server } from 'http';

jest.setTimeout(30000);

describe('Flow actions', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let executor: ActionExecutor;
  let submitServer: Server | undefined;
  let submitUrl = '';

  beforeAll(async () => {
    submitServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Submitted</title><h1>Submitted</h1>');
    });
    await new Promise<void>((resolve) => submitServer!.listen(0, '127.0.0.1', () => resolve()));
    const address = submitServer.address();
    if (!address || typeof address === 'string') throw new Error('submit server did not start');
    submitUrl = `http://127.0.0.1:${address.port}/submitted`;

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  });

  beforeEach(async () => {
    page = await browser!.newPage({ viewport: { width: 1280, height: 720 } });
    executor = new ActionExecutor({ getPage: () => page } as any);
    await page.setContent(flowHtml(submitUrl));
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  afterAll(async () => {
    await browser?.close();
    browser = undefined;
    await new Promise<void>((resolve, reject) => submitServer?.close((error) => (error ? reject(error) : resolve())) ?? resolve());
    submitServer = undefined;
  });

  it('fills forms, runs sequences, waits for state, and loops bounded actions', async () => {
    const fill = await executor.executeAction('session', 'fill_form', 'profile', {
      fields: {
        email: 'flow@example.com',
        plan: 'pro',
        terms: true,
      },
    });

    expect(fill.data).toEqual(expect.objectContaining({
      mode: 'fill_form',
      completed: 3,
      fields_filled: ['email', 'plan', 'terms'],
    }));
    await expect(page!.locator('#email').inputValue()).resolves.toBe('flow@example.com');
    await expect(page!.locator('#plan').inputValue()).resolves.toBe('pro');
    await expect(page!.locator('#terms').isChecked()).resolves.toBe(true);

    const sequence = await executor.executeAction('session', 'sequence', undefined, {
      steps: [
        { action: 'click', target_id: 'save' },
        {
          action: 'wait_for',
          params: {
            condition: { type: 'element_text_contains', element_id: 'status', text: 'saved' },
            timeout_ms: 1000,
          },
        },
      ],
    });
    expect(sequence.data).toEqual(expect.objectContaining({ mode: 'sequence', completed: 2 }));

    const loop = await executor.executeAction('session', 'loop', undefined, {
      while: { type: 'element_exists', element_id: 'more' },
      do: { action: 'click', target_id: 'more' },
      max_iterations: 5,
    });
    expect(loop.data).toEqual(expect.objectContaining({ mode: 'loop', completed: 2, exhausted: false }));
    await expect(page!.locator('#count').textContent()).resolves.toBe('2');
  });

  it('searches and collects compact paginated page slices', async () => {
    const result = await executor.executeAction('session', 'search_and_paginate', 'search', {
      query: 'alpha',
      submit_id: 'search-btn',
      collect_all_pages: true,
      next_id: 'next',
      max_pages: 2,
    });

    expect(result.data).toEqual(expect.objectContaining({
      query: 'alpha',
      pages_collected: 2,
    }));
    expect(result.data?.pages[0].text).toContain('alpha page 1');
    expect(result.data?.pages[1].text).toContain('alpha page 2');
  });

  it('fills and submits forms that navigate without surfacing context destruction', async () => {
    const result = await executor.executeAction('session', 'fill_form', 'nav-form', {
      fields: {
        nav_email: 'submit@example.com',
      },
      submit: true,
    });

    expect(result.data).toEqual(expect.objectContaining({
      mode: 'fill_form',
      submitted: true,
    }));
    await expect(page!.locator('h1').textContent()).resolves.toBe('Submitted');
  });
});

function flowHtml(submitUrl: string): string {
  return `<!doctype html>
<html>
  <head><title>Flow</title></head>
  <body>
    <form id="profile" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'submitted';">
      <label>Email <input id="email" name="email" required></label>
      <label>Plan
        <select id="plan" name="plan">
          <option value="basic">Basic</option>
          <option value="pro">Pro</option>
        </select>
      </label>
      <label><input id="terms" name="terms" type="checkbox"> Terms</label>
    </form>
    <button id="save" onclick="document.getElementById('status').textContent = 'saved'">Save</button>
    <p id="status">idle</p>
    <button id="more" onclick="window.hit=(window.hit||0)+1; document.getElementById('count').textContent=String(window.hit); if(window.hit>=2){this.remove();}">More</button>
    <p id="count">0</p>
    <label>Search <input id="search" type="search"></label>
    <button id="search-btn" onclick="document.getElementById('results').textContent = 'alpha page 1'">Search</button>
    <button id="next" onclick="document.getElementById('results').textContent = 'alpha page 2'; this.hidden = true;">Next</button>
    <p id="results">empty</p>
    <form id="nav-form" method="get" action="${submitUrl}">
      <label>Nav email <input id="nav-email" name="nav_email" type="email" required></label>
      <button type="submit">Submit nav</button>
    </form>
  </body>
</html>`;
}
