import { Page } from 'playwright';
import { globalEventBus } from '../../common/EventBus';

export class HistoryTracker {
  static async inject(page: Page, sessionId: string) {
    await page.exposeFunction('reportHistoryChange', (url: string) => {
      globalEventBus.publish('history_changed', { session_id: sessionId, url, timestamp: new Date().toISOString() });
    });

    await page.addInitScript(() => {
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;

      history.pushState = function (...args) {
        originalPushState.apply(this, args);
        (window as any).reportHistoryChange(window.location.href);
      };

      history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        (window as any).reportHistoryChange(window.location.href);
      };

      window.addEventListener('popstate', () => {
        (window as any).reportHistoryChange(window.location.href);
      });
    });
  }
}
