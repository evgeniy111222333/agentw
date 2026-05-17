import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Browser, chromium, Page } from 'playwright';
import { ActionExecutor } from '../../src/layer2_action_execution/ActionExecutor';
import { Box } from '../../src/file/Box';

jest.setTimeout(30000);

describe('File actions', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let tempRoot: string;
  let executor: ActionExecutor;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  });

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llmb-file-'));
    page = await browser!.newPage({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
    executor = new ActionExecutor(
      { getPage: () => page } as any,
      new Box({ root_dir: tempRoot, max_file_bytes: 5 * 1024 * 1024 })
    );
    await page.setContent(fileHtml());
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await browser?.close();
    browser = undefined;
  });

  it('keeps uploads, downloads, screenshots, PDFs, and fs operations inside the session box', async () => {
    const write = await executor.executeAction('session', 'fs', undefined, {
      operation: 'write',
      path: '/uploads/sample.txt',
      content: 'upload-content',
    });
    expect(write.data?.file).toEqual(expect.objectContaining({
      path: '/uploads/sample.txt',
      size: 14,
      mime_type: 'text/plain',
    }));

    const upload = await executor.executeAction('session', 'upload', 'file-input', {
      file_path: '/uploads/sample.txt',
    });
    expect(upload.data?.count).toBe(1);
    await expect(page!.locator('#upload-status').textContent()).resolves.toContain('sample.txt:14');

    const download = await executor.executeAction('session', 'download', 'download-link', {
      file_name: 'saved.txt',
    });
    expect(download.data?.file).toEqual(expect.objectContaining({
      path: '/downloads/saved.txt',
      size: 16,
      mime_type: 'text/plain',
    }));

    const read = await executor.executeAction('session', 'fs', undefined, {
      operation: 'read',
      path: download.data?.file.path,
    });
    expect(read.data?.file.content).toBe('download-content');

    const screenshot = await executor.executeAction('session', 'screenshot_file', undefined, {
      file_name: 'capture.png',
      full_page: false,
    });
    expect(screenshot.data?.file).toEqual(expect.objectContaining({
      path: '/shots/capture.png',
      mime_type: 'image/png',
    }));
    expect(screenshot.data?.file.size).toBeGreaterThan(100);

    const pdf = await executor.executeAction('session', 'pdf', undefined, {
      file_name: 'page.pdf',
    });
    expect(pdf.data?.file).toEqual(expect.objectContaining({
      path: '/shots/page.pdf',
      mime_type: 'application/pdf',
    }));
    expect(pdf.data?.file.size).toBeGreaterThan(100);

    const list = await executor.executeAction('session', 'fs', undefined, {
      operation: 'list',
      path: '/shots',
    });
    expect(list.data?.entries.map((entry: any) => entry.path)).toEqual(expect.arrayContaining([
      '/shots/capture.png',
      '/shots/page.pdf',
    ]));

    const deleted = await executor.executeAction('session', 'fs', undefined, {
      operation: 'delete',
      path: '/downloads/saved.txt',
    });
    expect(deleted.data).toEqual(expect.objectContaining({
      operation: 'delete',
      deleted: true,
      path: '/downloads/saved.txt',
    }));
  });

  it('rejects paths outside the session sandbox', async () => {
    await expect(
      executor.executeAction('session', 'fs', undefined, {
        operation: 'read',
        path: '../../outside.txt',
      })
    ).rejects.toThrow(/escapes session sandbox/);
  });
});

function fileHtml(): string {
  return `<!doctype html>
<html>
  <head><title>File Actions</title></head>
  <body>
    <main>
      <h1>File Actions</h1>
      <input
        id="file-input"
        type="file"
        onchange="document.getElementById('upload-status').textContent = this.files[0].name + ':' + this.files[0].size"
      >
      <p id="upload-status">empty</p>
      <a id="download-link" download="report.txt" href="data:text/plain;base64,ZG93bmxvYWQtY29udGVudA==">Download report</a>
    </main>
  </body>
</html>`;
}
