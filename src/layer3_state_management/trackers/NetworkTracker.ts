import { Page } from 'playwright';
import { globalEventBus } from '../../common/EventBus';

export class NetworkTracker {
  static inject(page: Page, sessionId: string) {
    let activeRequests = 0;
    let idleTimeout: NodeJS.Timeout | null = null;

    const notifyIdle = () => {
      globalEventBus.publish('network_idle', { session_id: sessionId, timestamp: new Date().toISOString() });
    };

    const requestStarted = () => {
      activeRequests++;
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    };

    const requestFinished = () => {
      activeRequests = Math.max(0, activeRequests - 1);
      if (activeRequests === 0) {
        // debounce idle event by 500ms
        idleTimeout = setTimeout(notifyIdle, 500);
      }
    };

    page.on('request', requestStarted);
    page.on('requestfinished', requestFinished);
    page.on('requestfailed', requestFinished);
  }
}
