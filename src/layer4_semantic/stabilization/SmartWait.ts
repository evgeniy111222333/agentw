import { Page } from 'playwright';
import { globalEventBus } from '../../common/EventBus';

/**
 * SmartWait — replaces naive `page.waitForTimeout(stabilization_ms)` with an
 * event-driven strategy that uses NetworkTracker + DOM mutation silence to
 * determine when a page is truly stable.
 *
 * Strategy (from Concept 2.9):
 *   1. Wait for `domcontentloaded`
 *   2. Wait for network idle (via our NetworkTracker event, not Playwright's naive networkidle)
 *   3. Wait for DOM mutation silence (no mutations for `mutationQuietMs`)
 *   4. If any IntersectionObserver fires during wait, extend the timer
 *   5. Hard timeout as safety net
 *
 * This avoids:
 *   - Waiting too long on already-stable pages (saves 500ms+ per action)
 *   - Not waiting long enough on lazy-loading SPAs
 */

export interface SmartWaitOptions {
  /** Maximum total wait time (ms). Default: 5000 */
  hardTimeoutMs?: number;
  /** Required quiet period without DOM mutations (ms). Default: 300 */
  mutationQuietMs?: number;
  /** Whether this is a retry attempt (shorter timeouts). Default: false */
  retry?: boolean;
  /** Session ID to listen for events */
  sessionId?: string;
}

export class SmartWait {
  async waitForStability(page: Page, options: SmartWaitOptions = {}): Promise<SmartWaitResult> {
    const hardTimeout = options.hardTimeoutMs ?? 5000;
    const mutationQuiet = options.mutationQuietMs ?? 300;
    const loadTimeout = options.retry ? 3000 : 1500;
    const started = performance.now();

    // Phase 1: Basic load state
    await page.waitForLoadState('domcontentloaded', { timeout: loadTimeout }).catch(() => undefined);

    // Phase 2: Event-driven stabilization
    const result = await this.waitForQuiet(page, options.sessionId, {
      hardTimeout,
      mutationQuiet,
      started,
    });

    return result;
  }

  private async waitForQuiet(
    page: Page,
    sessionId: string | undefined,
    config: { hardTimeout: number; mutationQuiet: number; started: number }
  ): Promise<SmartWaitResult> {
    return new Promise<SmartWaitResult>((resolve) => {
      let lastMutationAt = performance.now();
      let networkIdle = false;
      let intersectionFired = false;
      let resolved = false;

      const finish = (reason: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({
          stable: reason !== 'hard_timeout',
          reason,
          waited_ms: Math.round(performance.now() - config.started),
          network_idle: networkIdle,
          intersection_fired: intersectionFired,
        });
      };

      // Hard timeout safety net
      const hardTimer = setTimeout(() => finish('hard_timeout'), config.hardTimeout);

      // Subscribe to mutation events from our Layer 3 trackers
      const onMutation = (payload: any) => {
        if (sessionId && payload.session_id !== sessionId) return;
        lastMutationAt = performance.now();
      };

      const onNetworkIdle = (payload: any) => {
        if (sessionId && payload.session_id !== sessionId) return;
        networkIdle = true;
      };

      const onIntersection = (payload: any) => {
        if (sessionId && payload.session_id !== sessionId) return;
        intersectionFired = true;
        // Extend quiet period — new content appeared
        lastMutationAt = performance.now();
      };

      globalEventBus.subscribe('dom_mutated', onMutation);
      globalEventBus.subscribe('network_idle', onNetworkIdle);
      globalEventBus.subscribe('element_visible', onIntersection);

      // Poll for quiet period
      const pollInterval = setInterval(() => {
        const silenceMs = performance.now() - lastMutationAt;
        if (silenceMs >= config.mutationQuiet) {
          // DOM has been quiet long enough
          if (networkIdle) {
            finish('network_idle_and_quiet');
          } else {
            // Network still active but DOM is quiet — give a bit more time
            const totalWaited = performance.now() - config.started;
            if (totalWaited > config.hardTimeout * 0.6) {
              // We've waited long enough, network is probably streaming
              finish('dom_quiet_network_active');
            }
          }
        }
      }, 50);

      // Also try Playwright's networkidle as a fallback signal
      page.waitForLoadState('networkidle', { timeout: config.hardTimeout })
        .then(() => {
          networkIdle = true;
          const silenceMs = performance.now() - lastMutationAt;
          if (silenceMs >= config.mutationQuiet) {
            finish('playwright_networkidle');
          }
        })
        .catch(() => undefined);

      const cleanup = () => {
        clearTimeout(hardTimer);
        clearInterval(pollInterval);
        globalEventBus.unsubscribe('dom_mutated', onMutation);
        globalEventBus.unsubscribe('network_idle', onNetworkIdle);
        globalEventBus.unsubscribe('element_visible', onIntersection);
      };
    });
  }
}

export interface SmartWaitResult {
  stable: boolean;
  reason: string;
  waited_ms: number;
  network_idle: boolean;
  intersection_fired: boolean;
}
