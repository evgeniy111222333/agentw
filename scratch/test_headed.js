const { chromium } = require('playwright');

(async () => {
  console.log('Launching chromium headed...');
  try {
    const browser = await chromium.launch({
      headless: false,
    });
    console.log('Browser launched successfully. Creating context...');
    const context = await browser.newContext();
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
