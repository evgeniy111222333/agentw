import { Page } from 'playwright';
import { globalEventBus } from '../../common/EventBus';

export class IntersectionTracker {
  static async inject(page: Page, sessionId: string): Promise<void> {
    await exposeOnce(page, 'reportIntersection', async (entries: any[]) => {
      const timestamp = new Date().toISOString();
      await globalEventBus.publish('element_visibility_changed', { session_id: sessionId, entries, timestamp });
      for (const entry of entries) {
        if ((entry.intersectionRatio ?? 0) >= 0.5) {
          await globalEventBus.publish('element_visible', {
            session_id: sessionId,
            element_id: entry.targetId,
            visible_ratio: entry.intersectionRatio,
            timestamp,
          });
        }
      }
    });

    await page.addInitScript(intersectionTrackerScript, sessionId);
    await page.evaluate(intersectionTrackerScript, sessionId).catch(() => undefined);
  }
}

async function exposeOnce(page: Page, name: string, fn: (...args: any[]) => any): Promise<void> {
  try {
    await page.exposeFunction(name, fn);
  } catch (error) {
    if (!/already exists|has been already registered|Function .* has been already registered/i.test(String((error as Error).message))) {
      throw error;
    }
  }
}

function intersectionTrackerScript(sessionId: string): void {
  const win = window as any;
  const key = '__llmBrowserIntersectionTracker';
  if (win[key]?.sessionId === sessionId) return;
  const semanticIdAttr = 'data-prism-id';
  const targetId = (el: Element): string => el.getAttribute(semanticIdAttr) || el.id || el.tagName.toLowerCase();
  const observer = new IntersectionObserver((entries) => {
    win.reportIntersection?.(entries.map((entry) => ({
      targetId: targetId(entry.target),
      visible: entry.isIntersecting && entry.intersectionRatio >= 0.5,
      isIntersecting: entry.isIntersecting,
      intersectionRatio: Number(entry.intersectionRatio.toFixed(4)),
      boundingClientRect: {
        x: Math.round(entry.boundingClientRect.x),
        y: Math.round(entry.boundingClientRect.y),
        width: Math.round(entry.boundingClientRect.width),
        height: Math.round(entry.boundingClientRect.height),
      },
    })));
  }, { threshold: [0, 0.5, 1] });
  const observe = (root: ParentNode = document): void => {
    root.querySelectorAll?.('img, iframe, video, audio, canvas, svg, form, input, textarea, select, button, a, [data-src], [data-lazy-src], [data-infinite-scroll], [data-prism-id]')
      .forEach((el) => observer.observe(el));
  };
  const mo = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof Element) {
          observer.observe(node);
          observe(node);
        }
      }
    }
  });
  mo.observe(document, { childList: true, subtree: true });
  observe();
  win[key] = { sessionId, observer, mo };
}
