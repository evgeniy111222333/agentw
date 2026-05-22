import { Page } from 'playwright';

export interface DetectedCaptcha {
  type: 'recaptcha' | 'hcaptcha' | 'turnstile';
  sitekey: string;
  url: string;
}

export class CaptchaDetector {
  static async detect(page: Page): Promise<DetectedCaptcha | null> {
    // 1. Scan the main frame
    let results = await page.evaluate(detectCaptchasInPage).catch(() => []);
    if (results && results.length > 0) return results[0];

    // 2. Scan all subframes
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      results = await frame.evaluate(detectCaptchasInPage).catch(() => []);
      if (results && results.length > 0) return results[0];
    }

    return null;
  }

  static async solve(
    captcha: DetectedCaptcha,
    provider: '2captcha' | 'capmonster' | 'anticaptcha',
    apiKey: string,
    timeoutMs = 120000
  ): Promise<string> {
    if (provider === '2captcha') {
      return this.solve2Captcha(captcha, apiKey, timeoutMs);
    } else if (provider === 'capmonster') {
      return this.solveCapMonster(captcha, apiKey, timeoutMs);
    } else if (provider === 'anticaptcha') {
      return this.solveAntiCaptcha(captcha, apiKey, timeoutMs);
    }
    throw new Error(`Unsupported CAPTCHA provider: ${provider}`);
  }

  private static async solve2Captcha(captcha: DetectedCaptcha, apiKey: string, timeoutMs: number): Promise<string> {
    let method = 'userrecaptcha';
    if (captcha.type === 'hcaptcha') method = 'hcaptcha';
    if (captcha.type === 'turnstile') method = 'turnstile';

    const submitUrl = 'https://2captcha.com/in.php';
    const submitParams = new URLSearchParams({
      key: apiKey,
      method,
      googlekey: captcha.sitekey,
      pageurl: captcha.url,
      json: '1',
    });

    const res = await fetch(`${submitUrl}?${submitParams.toString()}`);
    if (!res.ok) throw new Error(`2Captcha submit HTTP error: ${res.statusText}`);
    const data = (await res.json()) as any;

    if (data.status !== 1) {
      throw new Error(`2Captcha submit error: ${data.request || JSON.stringify(data)}`);
    }

    const taskId = data.request;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollUrl = `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
      const pollRes = await fetch(pollUrl);
      if (!pollRes.ok) continue;
      const pollData = (await pollRes.json()) as any;

      if (pollData.status === 1) {
        return pollData.request;
      }
      if (pollData.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2Captcha polling error: ${pollData.request || JSON.stringify(pollData)}`);
      }
    }
    throw new Error('2Captcha solving timeout exceeded');
  }

  private static async solveCapMonster(captcha: DetectedCaptcha, apiKey: string, timeoutMs: number): Promise<string> {
    let type = 'NoCaptchaTaskProxyless';
    if (captcha.type === 'hcaptcha') type = 'HCaptchaTaskProxyless';
    if (captcha.type === 'turnstile') type = 'TurnstileTaskProxyless';

    const submitUrl = 'https://api.capmonster.cloud/createTask';
    const body = {
      clientKey: apiKey,
      task: {
        type,
        websiteURL: captcha.url,
        websiteKey: captcha.sitekey,
      },
    };

    const res = await fetch(submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CapMonster submit HTTP error: ${res.statusText}`);
    const data = (await res.json()) as any;

    if (data.errorId !== 0) {
      throw new Error(`CapMonster submit error: code ${data.errorCode} - ${data.errorDescription}`);
    }

    const taskId = data.taskId;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollUrl = 'https://api.capmonster.cloud/getTaskResult';
      const pollRes = await fetch(pollUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      if (!pollRes.ok) continue;
      const pollData = (await pollRes.json()) as any;

      if (pollData.errorId !== 0) {
        throw new Error(`CapMonster polling error: code ${pollData.errorCode} - ${pollData.errorDescription}`);
      }

      if (pollData.status === 'ready') {
        const solution = pollData.solution;
        return solution.gRecaptchaResponse || solution.token || solution.text || JSON.stringify(solution);
      }
    }
    throw new Error('CapMonster solving timeout exceeded');
  }

  private static async solveAntiCaptcha(captcha: DetectedCaptcha, apiKey: string, timeoutMs: number): Promise<string> {
    let type = 'NoCaptchaTaskProxyless';
    if (captcha.type === 'hcaptcha') type = 'HCaptchaTaskProxyless';
    if (captcha.type === 'turnstile') type = 'TurnstileTaskProxyless';

    const submitUrl = 'https://api.anti-captcha.com/createTask';
    const body = {
      clientKey: apiKey,
      task: {
        type,
        websiteURL: captcha.url,
        websiteKey: captcha.sitekey,
      },
    };

    const res = await fetch(submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anti-Captcha submit HTTP error: ${res.statusText}`);
    const data = (await res.json()) as any;

    if (data.errorId !== 0) {
      throw new Error(`Anti-Captcha submit error: code ${data.errorCode} - ${data.errorDescription}`);
    }

    const taskId = data.taskId;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollUrl = 'https://api.anti-captcha.com/getTaskResult';
      const pollRes = await fetch(pollUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      if (!pollRes.ok) continue;
      const pollData = (await pollRes.json()) as any;

      if (pollData.errorId !== 0) {
        throw new Error(`Anti-Captcha polling error: code ${pollData.errorCode} - ${pollData.errorDescription}`);
      }

      if (pollData.status === 'ready') {
        const solution = pollData.solution;
        return solution.gRecaptchaResponse || solution.token || solution.text || JSON.stringify(solution);
      }
    }
    throw new Error('Anti-Captcha solving timeout exceeded');
  }

  static async injectToken(page: Page, captcha: DetectedCaptcha, token: string): Promise<void> {
    // Try to inject in main frame and all frames
    await page.evaluate(injectTokenInPage, { captcha, token }).catch(() => undefined);
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      await frame.evaluate(injectTokenInPage, { captcha, token }).catch(() => undefined);
    }
  }
}

function detectCaptchasInPage() {
  const results: Array<{ type: 'recaptcha' | 'hcaptcha' | 'turnstile'; sitekey: string; url: string }> = [];

  // 1. Google reCAPTCHA
  const recaptchaIframes = document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
  recaptchaIframes.forEach((iframe) => {
    const src = iframe.getAttribute('src') || '';
    const match = src.match(/k=([^&]+)/);
    if (match) {
      results.push({ type: 'recaptcha', sitekey: match[1], url: window.location.href });
    }
  });

  const recaptchaElements = document.querySelectorAll('.g-recaptcha, [data-sitekey]');
  recaptchaElements.forEach((el) => {
    const sitekey = el.getAttribute('data-sitekey');
    if (sitekey && !el.getAttribute('src')?.includes('hcaptcha') && !el.getAttribute('src')?.includes('challenges')) {
      const isHCaptcha = el.classList.contains('h-captcha') || el.id?.includes('hcaptcha');
      const isTurnstile = el.classList.contains('cf-turnstile') || el.id?.includes('turnstile');
      if (!isHCaptcha && !isTurnstile) {
        results.push({ type: 'recaptcha', sitekey, url: window.location.href });
      }
    }
  });

  // 2. hCaptcha
  const hcaptchaIframes = document.querySelectorAll('iframe[src*="hcaptcha.com/embed"]');
  hcaptchaIframes.forEach((iframe) => {
    const src = iframe.getAttribute('src') || '';
    const match = src.match(/sitekey=([^&]+)/);
    if (match) {
      results.push({ type: 'hcaptcha', sitekey: match[1], url: window.location.href });
    }
  });
  const hcaptchaElements = document.querySelectorAll('.h-captcha');
  hcaptchaElements.forEach((el) => {
    const sitekey = el.getAttribute('data-sitekey');
    if (sitekey) {
      results.push({ type: 'hcaptcha', sitekey, url: window.location.href });
    }
  });

  // 3. Turnstile
  const turnstileIframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
  turnstileIframes.forEach((iframe) => {
    const src = iframe.getAttribute('src') || '';
    const match = src.match(/sitekey=([^&]+)/) || src.match(/k=([^&]+)/);
    if (match) {
      results.push({ type: 'turnstile', sitekey: match[1], url: window.location.href });
    }
  });
  const turnstileElements = document.querySelectorAll('.cf-turnstile');
  turnstileElements.forEach((el) => {
    const sitekey = el.getAttribute('data-sitekey');
    if (sitekey) {
      results.push({ type: 'turnstile', sitekey, url: window.location.href });
    }
  });

  return results;
}

function injectTokenInPage(args: { captcha: DetectedCaptcha; token: string }) {
  const { captcha, token } = args;

  if (captcha.type === 'recaptcha') {
    const textareas = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
    textareas.forEach((el) => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        el.value = token;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    const reEl = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (reEl) {
      const cb = reEl.getAttribute('data-callback');
      if (cb && typeof (window as any)[cb] === 'function') {
        (window as any)[cb](token);
      }
    }
  } else if (captcha.type === 'hcaptcha') {
    const textareas = document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]');
    textareas.forEach((el) => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        el.value = token;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    const hEl = document.querySelector('.h-captcha, [data-sitekey]');
    if (hEl) {
      const cb = hEl.getAttribute('data-callback');
      if (cb && typeof (window as any)[cb] === 'function') {
        (window as any)[cb](token);
      }
    }
  } else if (captcha.type === 'turnstile') {
    const inputs = document.querySelectorAll('input[name*="cf-turnstile-response"]');
    inputs.forEach((el) => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        el.value = token;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    const tEl = document.querySelector('.cf-turnstile, [data-sitekey]');
    if (tEl) {
      const cb = tEl.getAttribute('data-callback');
      if (cb && typeof (window as any)[cb] === 'function') {
        (window as any)[cb](token);
      }
    }
  }
}
