import { Page } from 'playwright';
import { globalEventBus } from '../../common/EventBus';

export class IntersectionTracker {
  static async inject(page: Page, sessionId: string) {
    await page.exposeFunction('reportIntersection', (entries: any[]) => {
      globalEventBus.publish('element_visibility_changed', { session_id: sessionId, entries, timestamp: new Date().toISOString() });
    });

    await page.addInitScript(() => {
      // In a real browser context, we can't observe everything without huge overhead, 
      // but we can observe images, iframes, and dynamic content boundaries (divs).
      const observer = new IntersectionObserver((entries) => {
        const serialized = entries.map(e => ({
          targetId: e.target.id || e.target.tagName,
          isIntersecting: e.isIntersecting,
          intersectionRatio: e.intersectionRatio
        }));
        (window as any).reportIntersection(serialized);
      }, { threshold: [0, 0.5, 1] });

      const mo = new MutationObserver(mutations => {
        mutations.forEach(m => {
          m.addedNodes.forEach(node => {
            if (node.nodeType === 1) {
              const el = node as Element;
              if (el.tagName === 'IMG' || el.tagName === 'IFRAME') {
                 observer.observe(el);
              }
            }
          });
        });
      });
      mo.observe(document, { childList: true, subtree: true });
      
      // Observe existing imgs/iframes initially
      document.querySelectorAll('img, iframe').forEach(el => observer.observe(el));
    });
  }
}
