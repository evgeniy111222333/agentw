import { BrowserCore } from '../layer1_browser_core/BrowserCore';
import { StateManagementLayer } from '../layer3_state_management/StateManagementLayer';
import { StateReconciler, ReconciliationResult } from '../layer3_state_management/StateReconciler';
import { globalAuditLog, AuditEvent } from '../common/AuditLog';
import { globalMetrics } from '../common/MetricsRegistry';
import { globalTraceStore } from '../trace/Trace';
import { globalSemCache } from '../cache/Sem';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { SemanticSnapshot } from '../common/types';
import { globalEventBus } from '../common/EventBus';

/**
 * DiagnosticsDashboard — Real-time system introspection for operators and debugging.
 *
 * From Concept 2.11: "A diagnostic dashboard provides real-time visibility
 * into the system's state, performance, and health."
 *
 * Exposes:
 *   - System health summary
 *   - Per-session diagnostics
 *   - Performance analytics (token usage, action latency, cache efficiency)
 *   - Reconciler status
 *   - Action audit trail
 *   - Anomaly detection (stale sessions, error spikes, cache misses)
 */

export interface SystemDiagnostics {
  timestamp: string;
  uptime_ms: number;
  health: HealthSummary;
  performance: PerformanceAnalytics;
  sessions: SessionDiagnostics[];
  anomalies: Anomaly[];
  configuration: ConfigSnapshot;
}

export interface HealthSummary {
  status: 'ok' | 'degraded' | 'critical';
  score: number;
  browser_initialized: boolean;
  active_sessions: number;
  max_sessions: number;
  total_actions: number;
  error_rate: number;
}

export interface PerformanceAnalytics {
  actions: {
    total: number;
    succeeded: number;
    failed: number;
    avg_duration_ms: number;
    p95_duration_ms: number;
  };
  tokens: {
    total_estimated: number;
    avg_per_snapshot: number;
    delta_savings_pct: number;
  };
  cache: {
    hits: number;
    misses: number;
    hit_rate: number;
    entries: number;
  };
  reconciler: {
    total_checks: number;
    url_drift: number;
    element_drift: number;
    valid: number;
  };
}

export interface SessionDiagnostics {
  session_id: string;
  status: string;
  current_url: string;
  tabs_count: number;
  action_count: number;
  last_action_at: string | undefined;
  idle_ms: number;
  last_reconciliation: ReconciliationResult | undefined;
  last_snapshot_age_ms: number | undefined;
}

export interface Anomaly {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  session_id?: string;
  detected_at: string;
}

export interface ConfigSnapshot {
  max_sessions: number;
  max_elements: number;
  stabilization_ms: number;
  audit_enabled: boolean;
  rate_limit_rpm: number;
}

export class DiagnosticsDashboard {
  private startedAt = Date.now();

  constructor(
    private browserCore: BrowserCore,
    private stateManager: StateManagementLayer,
    private reconciler: StateReconciler,
    private previousSnapshots: Map<string, SemanticSnapshot>
  ) {}

  /**
   * Generate a full system diagnostics report.
   */
  report(): SystemDiagnostics {
    const config = ConfigurationManager.getInstance().getConfig();
    const metrics = globalMetrics.snapshot();
    const sessions = this.stateManager.listSessions();
    const activeSessions = sessions.filter((s) => s.status === 'active');

    const totalActions = metricValue(metrics, 'llm_browser_actions_total');
    const succeededActions = metricValue(metrics, 'llm_browser_actions_succeeded_total');
    const failedActions = metricValue(metrics, 'llm_browser_actions_failed_total');
    const errorRate = totalActions > 0 ? failedActions / totalActions : 0;
    const browser = this.browserCore.stats();

    // Health score calculation
    const staleSessions = activeSessions.filter((s) => Date.now() - Date.parse(s.updated_at) > 60_000);
    const score = clamp01(
      1.0 -
        (staleSessions.length * 0.05) -
        (errorRate * 0.3) -
        (!browser.initialized ? 0.5 : 0) -
        (activeSessions.length > config.server.max_sessions * 0.9 ? 0.2 : 0)
    );

    // Cache stats
    const cacheStats = globalSemCache.stats();
    const cacheHits = cacheStats.hits ?? 0;
    const cacheMisses = cacheStats.misses ?? 0;
    const cacheTotal = cacheHits + cacheMisses;

    // Reconciler stats
    const urlDrift = metricValue(metrics, 'llm_browser_reconciler_url_drift_total');
    const elementDrift = metricValue(metrics, 'llm_browser_reconciler_element_drift_total');
    const reconcilerValid = metricValue(metrics, 'llm_browser_reconciler_valid_total');

    // Token analytics
    const snapshotCount = metricValue(metrics, 'llm_browser_snapshots_total');
    const totalTokens = this.estimateTotalTokens(sessions);

    // Action durations from audit log
    const recentActions = globalAuditLog.list({ category: 'ACTION' }).slice(-100);
    const durations = recentActions
      .filter((e) => e.duration_ms !== undefined)
      .map((e) => e.duration_ms!);
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;
    const p95Duration = durations.length > 0
      ? durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)] ?? 0
      : 0;

    // Session diagnostics
    const sessionDiags: SessionDiagnostics[] = activeSessions.map((session) => {
      const actionHistory = this.stateManager.getActionHistory(session.session_id);
      const lastAction = actionHistory[actionHistory.length - 1];
      const snapshots = Array.from(this.previousSnapshots.entries())
        .filter(([key]) => key.startsWith(session.session_id));
      const newestSnap = snapshots.length > 0
        ? Math.max(...snapshots.map(([, snap]) => Date.parse(snap.timestamp)))
        : undefined;

      return {
        session_id: session.session_id,
        status: session.status,
        current_url: session.current_url,
        tabs_count: session.tabs.length,
        action_count: actionHistory.length,
        last_action_at: lastAction?.completed_at ?? lastAction?.requested_at,
        idle_ms: Date.now() - Date.parse(session.updated_at),
        last_reconciliation: this.reconciler.getLastResult(session.session_id),
        last_snapshot_age_ms: newestSnap ? Date.now() - newestSnap : undefined,
      };
    });

    // Anomaly detection
    const anomalies = this.detectAnomalies(activeSessions, errorRate, staleSessions, cacheTotal, cacheHits);

    return {
      timestamp: new Date().toISOString(),
      uptime_ms: Date.now() - this.startedAt,
      health: {
        status: score >= 0.8 ? 'ok' : score >= 0.5 ? 'degraded' : 'critical',
        score: Number(score.toFixed(3)),
        browser_initialized: Boolean(browser.initialized),
        active_sessions: activeSessions.length,
        max_sessions: config.server.max_sessions,
        total_actions: totalActions,
        error_rate: Number(errorRate.toFixed(4)),
      },
      performance: {
        actions: {
          total: totalActions,
          succeeded: succeededActions,
          failed: failedActions,
          avg_duration_ms: avgDuration,
          p95_duration_ms: p95Duration,
        },
        tokens: {
          total_estimated: totalTokens,
          avg_per_snapshot: snapshotCount > 0 ? Math.round(totalTokens / snapshotCount) : 0,
          delta_savings_pct: this.estimateDeltaSavings(metrics),
        },
        cache: {
          hits: cacheHits,
          misses: cacheMisses,
          hit_rate: cacheTotal > 0 ? Number((cacheHits / cacheTotal).toFixed(3)) : 0,
          entries: cacheStats.entries ?? 0,
        },
        reconciler: {
          total_checks: urlDrift + elementDrift + reconcilerValid,
          url_drift: urlDrift,
          element_drift: elementDrift,
          valid: reconcilerValid,
        },
      },
      sessions: sessionDiags,
      anomalies,
      configuration: {
        max_sessions: config.server.max_sessions,
        max_elements: config.semantic.max_elements,
        stabilization_ms: config.semantic.stabilization_ms,
        audit_enabled: config.monitoring.audit_enabled,
        rate_limit_rpm: config.security.rate_limit_per_minute,
      },
    };
  }

  /**
   * Get a compact summary for LLM context injection.
   */
  summary(): Record<string, any> {
    const full = this.report();
    return {
      health: full.health.status,
      score: full.health.score,
      sessions: full.health.active_sessions,
      total_actions: full.health.total_actions,
      error_rate: full.health.error_rate,
      cache_hit_rate: full.performance.cache.hit_rate,
      anomalies: full.anomalies.length,
      critical_anomalies: full.anomalies.filter((a) => a.severity === 'critical').length,
    };
  }

  /**
   * Get the audit trail for a session.
   */
  sessionAudit(sessionId: string): AuditEvent[] {
    return globalAuditLog.list({ session_id: sessionId });
  }

  // --- Private ---

  private detectAnomalies(
    activeSessions: any[],
    errorRate: number,
    staleSessions: any[],
    cacheTotal: number,
    cacheHits: number
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const now = new Date().toISOString();

    // Stale sessions
    for (const session of staleSessions) {
      anomalies.push({
        type: 'stale_session',
        severity: Date.now() - Date.parse(session.updated_at) > 300_000 ? 'warning' : 'info',
        message: `Session ${session.session_id} has been idle for ${Math.round((Date.now() - Date.parse(session.updated_at)) / 1000)}s`,
        session_id: session.session_id,
        detected_at: now,
      });
    }

    // High error rate
    if (errorRate > 0.3) {
      anomalies.push({
        type: 'high_error_rate',
        severity: errorRate > 0.5 ? 'critical' : 'warning',
        message: `Error rate is ${(errorRate * 100).toFixed(1)}% (threshold: 30%)`,
        detected_at: now,
      });
    }

    // Low cache efficiency
    if (cacheTotal > 20 && cacheHits / cacheTotal < 0.3) {
      anomalies.push({
        type: 'low_cache_efficiency',
        severity: 'warning',
        message: `Cache hit rate is ${((cacheHits / cacheTotal) * 100).toFixed(1)}% — pages may be too dynamic for caching`,
        detected_at: now,
      });
    }

    // Session capacity
    const config = ConfigurationManager.getInstance().getConfig();
    if (activeSessions.length >= config.server.max_sessions) {
      anomalies.push({
        type: 'session_capacity',
        severity: 'critical',
        message: `At maximum session capacity (${activeSessions.length}/${config.server.max_sessions})`,
        detected_at: now,
      });
    }

    return anomalies;
  }

  private estimateTotalTokens(sessions: any[]): number {
    let total = 0;
    for (const session of sessions) {
      const history = this.stateManager.getActionHistory(session.session_id);
      for (const record of history) {
        total += record.token_estimate ?? 0;
      }
    }
    return total;
  }

  private estimateDeltaSavings(metrics: Record<string, any>): number {
    // Estimate from delta operations if available
    const totalSnapshots = metricValue(metrics, 'llm_browser_snapshots_total');
    if (totalSnapshots < 2) return 0;
    // Rough estimate: 40-70% savings on average with delta protocol
    // In production this would be calculated from actual byte measurements
    return 0.6;
  }
}

function metricValue(metrics: Record<string, any>, name: string): number {
  return Number(metrics[name] ?? 0);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
