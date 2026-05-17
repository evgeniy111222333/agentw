import { BrowserCore } from '../layer1_browser_core/BrowserCore';
import { StateManagementLayer } from '../layer3_state_management/StateManagementLayer';
import { globalAuditLog } from '../common/AuditLog';
import { globalMetrics } from '../common/MetricsRegistry';
import { PluginRegistry } from '../plugins/PluginRegistry';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { globalTraceStore } from '../trace/Trace';

export class Probe {
  constructor(
    private browserCore: BrowserCore,
    private stateManager: StateManagementLayer,
    private pluginRegistry: PluginRegistry
  ) {}

  report(): Record<string, any> {
    const sessions = this.stateManager.listSessions();
    const activeSessions = sessions.filter((session) => session.status === 'active');
    const closedSessions = sessions.filter((session) => session.status === 'closed');
    const staleSessions = activeSessions.filter((session) => Date.now() - Date.parse(session.updated_at) > 60_000);
    const plugins = this.pluginRegistry.listPlugins();
    const disabledPlugins = plugins.filter((plugin) => plugin.status !== 'enabled');
    const pluginFailures = plugins.reduce((total, plugin) => total + plugin.failures, 0);
    const audit = globalAuditLog.list();
    const recentAudit = audit.slice(-100);
    const recentErrors = recentAudit.filter((event) => event.result !== 'success');
    const browser = this.browserCore.stats();
    const traces = globalTraceStore.stats();
    const maxSessions = ConfigurationManager.getInstance().getConfig().server.max_sessions;

    const score = clamp01(
      1 -
        staleSessions.length * 0.03 -
        recentErrors.length * 0.02 -
        disabledPlugins.length * 0.1 -
        pluginFailures * 0.03 -
        (activeSessions.length > maxSessions * 0.8 ? 0.15 : 0) -
        (!browser.initialized ? 0.5 : 0)
    );

    return {
      status: statusFor(score),
      version: '2.3.0',
      health_score: Number(score.toFixed(3)),
      checks: {
        browser,
        sessions: {
          total: sessions.length,
          active: activeSessions.length,
          closed: closedSessions.length,
          stale: staleSessions.length,
          max: maxSessions,
        },
        plugins: {
          total: plugins.length,
          enabled: plugins.filter((plugin) => plugin.status === 'enabled').length,
          disabled: disabledPlugins.length,
          failures: pluginFailures,
        },
        audit: {
          retained: audit.length,
          recent_errors: recentErrors.length,
        },
        traces,
      },
      signals: {
        stale_sessions: staleSessions.map((session) => ({
          session_id: session.session_id,
          idle_ms: Date.now() - Date.parse(session.updated_at),
          current_url: session.current_url,
        })),
        disabled_plugins: disabledPlugins.map((plugin) => ({
          name: plugin.name,
          reason: plugin.disabled_reason,
          last_error: plugin.last_error,
        })),
        recent_errors: recentErrors.slice(-10).map((event) => ({
          timestamp: event.timestamp,
          category: event.category,
          action: event.action,
          code: event.error_code,
          message: event.message,
        })),
      },
      metrics: globalMetrics.snapshot(),
    };
  }
}

function statusFor(score: number): 'ok' | 'degraded' | 'critical' {
  if (score < 0.5) return 'critical';
  if (score < 0.8) return 'degraded';
  return 'ok';
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
