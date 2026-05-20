import type { Page } from 'playwright';

export interface BouncerAction {
  text: string;
  reason: string;
  selector: string;
}

export interface BouncerResult {
  attempted: boolean;
  closed: number;
  actions: BouncerAction[];
  duration_ms: number;
}

export interface BouncerOptions {
  enabled?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
}

const BOUNCER_ID_ATTR = 'data-llm-bouncer-id';

export class Bouncer {
  async dismiss(page: Page, options: BouncerOptions = {}): Promise<BouncerResult> {
    const started = performance.now();
    if (options.enabled === false) {
      return { attempted: false, closed: 0, actions: [], duration_ms: 0 };
    }

    const maxAttempts = Math.min(Math.max(Number(options.maxAttempts ?? 4), 1), 8);
    const timeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? 1200), 250), 5000);
    const actions: BouncerAction[] = [];

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = await page.evaluate(findDismissCandidate, {
        attr: BOUNCER_ID_ATTR,
        attempt,
      }).catch(() => undefined);
      if (!candidate?.id) break;

      const selector = `[${BOUNCER_ID_ATTR}="${cssEscape(candidate.id)}"]`;
      const locator = page.locator(selector).first();
      const clicked = await locator.click({ timeout: timeoutMs }).then(() => true).catch(() => false);
      if (!clicked) break;

      actions.push({
        text: candidate.text,
        reason: candidate.reason,
        selector,
      });
      await page.waitForTimeout(120).catch(() => undefined);
      const stillVisible = await locator.isVisible().catch(() => false);
      if (stillVisible) break;
    }

    return {
      attempted: true,
      closed: actions.length,
      actions,
      duration_ms: Math.round(performance.now() - started),
    };
  }
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findDismissCandidate(input: { attr: string; attempt: number }): { id: string; text: string; reason: string } | undefined {
  const attr = input.attr;
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const lower = (value: string | null | undefined) => normalize(value).toLowerCase();
  const visible = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0.05
      && rect.width > 0
      && rect.height > 0;
  };
  const fixedLike = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    return ['fixed', 'sticky'].includes(style.position) || Number(style.zIndex || '0') >= 10;
  };

  const safeText = /^(accept( all)?|allow all|agree|i agree|ok|got it|dismiss|close|no thanks|not now|maybe later|skip|continue|x|×)$/i;
  const safeLoose = /\b(accept cookies|accept all cookies|cookie settings|reject all|decline|dismiss|close|no thanks|not now|maybe later|skip)\b/i;
  const containerSignal = /\b(cookie|consent|privacy|gdpr|newsletter|subscribe|sign up|region|location|deliver|notification|survey|promo|modal|popup|dialog|banner)\b/i;
  const danger = /\b(buy|pay|checkout|delete|remove account|submit order|place order|confirm purchase|transfer|send money)\b/i;
  const candidateSelector = [
    'button',
    '[role="button"]',
    'a[href]',
    'input[type="button"]',
    'input[type="submit"]',
    '[aria-label]',
    '[title]',
  ].join(',');
  const containers = Array.from(document.querySelectorAll([
    'dialog[open]',
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[class*="modal" i]',
    '[class*="popup" i]',
    '[class*="overlay" i]',
    '[class*="cookie" i]',
    '[class*="consent" i]',
    '[class*="banner" i]',
    '[id*="cookie" i]',
    '[id*="consent" i]',
    '[id*="newsletter" i]',
  ].join(','))).filter((el) => visible(el)) as HTMLElement[];

  const scored: Array<{ el: HTMLElement; score: number; text: string; reason: string }> = [];
  const scoreButton = (el: HTMLElement, container?: HTMLElement): void => {
    if (!visible(el)) return;
    const text = normalize(
      el.textContent ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el instanceof HTMLInputElement ? el.value : '')
    );
    const textLower = text.toLowerCase();
    if (!text || danger.test(textLower)) return;

    const containerText = lower(container?.textContent);
    const containerClass = lower(`${container?.id ?? ''} ${container?.className ?? ''}`);
    const localSignal = lower(`${el.id} ${el.className} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`);
    const hasContainerSignal = containerSignal.test(containerText) || containerSignal.test(containerClass);
    const isSafe = safeText.test(text) || safeLoose.test(text) || /\b(close|dismiss|reject|decline|accept|agree|cookie)\b/i.test(localSignal);
    if (!isSafe) return;

    let score = 0;
    if (safeText.test(text)) score += 60;
    if (safeLoose.test(text)) score += 45;
    if (hasContainerSignal) score += 35;
    if (fixedLike(container ?? el)) score += 15;
    if (/^(x|×)$/i.test(text)) score += 10;
    if (/continue/i.test(text) && !hasContainerSignal) score -= 50;
    if (score < 45) return;

    scored.push({
      el,
      score,
      text,
      reason: hasContainerSignal ? 'modal_or_banner_dismiss' : 'global_safe_dismiss',
    });
  };

  for (const container of containers) {
    for (const el of Array.from(container.querySelectorAll(candidateSelector))) {
      if (el instanceof HTMLElement) scoreButton(el, container);
    }
  }

  if (scored.length === 0) {
    for (const el of Array.from(document.querySelectorAll(candidateSelector))) {
      if (el instanceof HTMLElement) scoreButton(el);
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (!winner) return undefined;

  const id = `dismiss-${Date.now()}-${Math.max(0, input.attempt)}`;
  winner.el.setAttribute(attr, id);
  return { id, text: winner.text, reason: winner.reason };
}
