import { Page } from 'playwright';
import { SemanticElement, SemanticSnapshot } from '../common/types';
import { globalEventBus } from '../common/EventBus';
import { globalMetrics } from '../common/MetricsRegistry';

/**
 * StateReconciler — Ensures the cached semantic snapshot still represents reality.
 *
 * From Concept 2.9: "State reconciliation is critical for SPA reliability.
 * If an incremental update becomes stale (page full reload, SPA client-side
 * navigation, unexpected DOM teardown), we must detect it and force a full
 * re-extraction."
 *
 * Three-phase detection:
 *   Phase 1: URL Drift — cheapest check, ~0ms
 *   Phase 2: Fast ID/Type — O(n) check, ~1ms
 *   Phase 3: Deep Element Comparison — O(n) check, ~5ms
 *
 * If any phase detects drift, the snapshot cache is invalidated.
 */

export interface ReconciliationResult {
  valid: boolean;
  phase: 'url_drift' | 'fast_check' | 'deep_check' | 'skipped';
  reason?: string;
  checked_at: string;
  duration_ms: number;
}

export class StateReconciler {
  private lastReconciliation: Map<string, ReconciliationResult> = new Map();

  /**
   * Full reconciliation pipeline.
   * Returns true if the cached snapshot is still valid.
   */
  async reconcile(
    page: Page,
    sessionId: string,
    cachedSnapshot: SemanticSnapshot | undefined
  ): Promise<ReconciliationResult> {
    const started = performance.now();

    if (!cachedSnapshot) {
      const result: ReconciliationResult = {
        valid: true,
        phase: 'skipped',
        reason: 'no_cached_snapshot',
        checked_at: new Date().toISOString(),
        duration_ms: 0,
      };
      this.lastReconciliation.set(sessionId, result);
      return result;
    }

    // Phase 1: URL Drift (cheapest — no DOM access)
    const currentUrl = page.url();
    if (this.urlDrifted(cachedSnapshot.url, currentUrl)) {
      const result = this.invalidate(sessionId, 'url_drift', `URL changed: ${cachedSnapshot.url} → ${currentUrl}`, started);
      await globalEventBus.publish('cache_invalidated', {
        session_id: sessionId,
        reason: 'url_drift',
        old_url: cachedSnapshot.url,
        new_url: currentUrl,
      });
      globalMetrics.increment('llm_browser_reconciler_url_drift_total');
      return result;
    }

    // Phase 2: Fast ID/Type Check (light DOM probe)
    try {
      const summary = await this.extractElementSummary(page);
      if (!StateReconciler.performFastCheck(cachedSnapshot, summary)) {
        const result = this.invalidate(sessionId, 'fast_check', `Element count/types changed (${cachedSnapshot.elements.length} → ${summary.length})`, started);
        await globalEventBus.publish('cache_invalidated', {
          session_id: sessionId,
          reason: 'element_drift',
        });
        globalMetrics.increment('llm_browser_reconciler_element_drift_total');
        return result;
      }
    } catch {
      // Page might have navigated — treat as drift
      const result = this.invalidate(sessionId, 'fast_check', 'DOM access failed (possible navigation)', started);
      globalMetrics.increment('llm_browser_reconciler_access_error_total');
      return result;
    }

    // Phase 3: All checks passed
    const result: ReconciliationResult = {
      valid: true,
      phase: 'fast_check',
      checked_at: new Date().toISOString(),
      duration_ms: Math.round(performance.now() - started),
    };
    this.lastReconciliation.set(sessionId, result);
    globalMetrics.increment('llm_browser_reconciler_valid_total');
    return result;
  }

  getLastResult(sessionId: string): ReconciliationResult | undefined {
    return this.lastReconciliation.get(sessionId);
  }

  // --- Static helpers (kept for backward compatibility) ---

  static performFastCheck(
    snapshot: SemanticSnapshot,
    currentElementsSummary: Array<{ id: string; type: string }>
  ): boolean {
    if (snapshot.elements.length !== currentElementsSummary.length) return false;
    const snapMap = new Map(snapshot.elements.map((e) => [e.id, e.type]));
    for (const el of currentElementsSummary) {
      if (snapMap.get(el.id) !== el.type) return false;
    }
    return true;
  }

  static performDeepCheck(snapshotElements: SemanticElement[], currentElements: SemanticElement[]): boolean {
    if (snapshotElements.length !== currentElements.length) return false;
    for (let i = 0; i < snapshotElements.length; i++) {
      const snapStr = JSON.stringify(snapshotElements[i]);
      const currStr = JSON.stringify(currentElements[i]);
      if (snapStr !== currStr) return false;
    }
    return true;
  }

  // --- Private ---

  private urlDrifted(cached: string, current: string): boolean {
    try {
      const cachedUrl = new URL(cached);
      const currentUrl = new URL(current);
      // Compare origin + pathname (ignore hash for SPA hash-routing)
      return cachedUrl.origin + cachedUrl.pathname !== currentUrl.origin + currentUrl.pathname;
    } catch {
      return cached !== current;
    }
  }

  private async extractElementSummary(page: Page): Promise<Array<{ id: string; type: string }>> {
    return page.evaluate(() => {
      const elements: Array<{ id: string; type: string }> = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node: Node | null = walker.currentNode;
      let count = 0;
      while (node && count < 200) {
        const el = node as Element;
        const id = el.getAttribute('data-llm-browser-id') || el.id;
        if (id) {
          elements.push({ id, type: el.tagName.toLowerCase() });
          count++;
        }
        node = walker.nextNode();
      }
      return elements;
    });
  }

  private invalidate(
    sessionId: string,
    phase: ReconciliationResult['phase'],
    reason: string,
    started: number
  ): ReconciliationResult {
    const result: ReconciliationResult = {
      valid: false,
      phase,
      reason,
      checked_at: new Date().toISOString(),
      duration_ms: Math.round(performance.now() - started),
    };
    this.lastReconciliation.set(sessionId, result);
    return result;
  }
}
