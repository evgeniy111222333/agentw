const { chromium } = require('playwright');

function shadowDomHook() {
  const key = '__llmBrowserShadowRoots';
  const win = window;
  if (win[key]?.installed) return;

  const original = Element.prototype.attachShadow;
  const roots = [];
  Object.defineProperty(win, key, {
    value: {
      installed: true,
      roots,
      rootFor(host) {
        return roots.find((entry) => entry.host === host)?.root;
      },
      modeFor(host) {
        return roots.find((entry) => entry.host === host)?.mode;
      },
    },
    configurable: false,
  });

  Element.prototype.attachShadow = function patchedAttachShadow(init) {
    const root = original.call(this, init);
    roots.push({ host: this, root, mode: init.mode });
    return root;
  };
}

function stealthScript() {
  // 1. Overwrite navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
  });

  // 2. Overwrite navigator.languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });

  // 3. Mock navigator.plugins
  const mockPlugins = () => {
    const plugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbgoaodhbgedhhffmhnhiigihneae', description: 'Google Chrome PDF Viewer' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
    ];
    const pluginList = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperty(plugin, 'name', { get: () => p.name });
      Object.defineProperty(plugin, 'filename', { get: () => p.filename });
      Object.defineProperty(plugin, 'description', { get: () => p.description });
      Object.defineProperty(pluginList, i, { value: plugin });
      Object.defineProperty(pluginList, p.name, { value: plugin });
    });
    Object.defineProperty(pluginList, 'length', { get: () => plugins.length });
    Object.defineProperty(navigator, 'plugins', { get: () => pluginList });
  };
  mockPlugins();

  // 4. Overwrite navigator.permissions.query
  if (navigator.permissions && navigator.permissions.query) {
    const originalQuery = navigator.permissions.query;
    navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  }

  // 5. Mock WebGL vendor/renderer
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    // UNMASKED_VENDOR_WEBGL
    if (parameter === 37445) {
      return 'Intel Inc.';
    }
    // UNMASKED_RENDERER_WEBGL
    if (parameter === 37446) {
      return 'Intel(R) Iris(TM) Plus Graphics 640';
    }
    return getParameter.call(this, parameter);
  };

  // 6. Mock window.chrome
  window.chrome = {
    runtime: {},
    loadTimes: function() {},
    csi: function() {},
    app: {}
  };
}

(async () => {
  console.log('Launching chromium headed...');
  try {
    const browser = await chromium.launch({
      headless: false,
    });
    console.log('Browser launched successfully. Creating context...');
    const context = await browser.newContext();
    await context.addInitScript(shadowDomHook);
    await context.addInitScript(stealthScript);
    
    console.log('Context created. Opening new page...');
    const page = await context.newPage();
    console.log('Page opened. URL:', page.url());
    page.on('close', () => {
      console.log('Page closed event received!');
    });
    console.log('Navigating to https://example.com...');
    await page.goto('https://example.com');
    console.log('Navigation complete. Page URL:', page.url());
    console.log('Waiting 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    await browser.close();
    console.log('Browser closed successfully.');
  } catch (error) {
    console.error('Error occurred:', error);
  }
})();
