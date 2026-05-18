import { DiagnosticsDashboard } from '../../../src/obs/DiagnosticsDashboard';
import { StateManagementLayer } from '../../../src/layer3_state_management/StateManagementLayer';
import { StateReconciler } from '../../../src/layer3_state_management/StateReconciler';
import { ConfigurationManager } from '../../../src/config/ConfigurationManager';
import { SemanticSnapshot } from '../../../src/common/types';
import { globalMetrics } from '../../../src/common/MetricsRegistry';
import { globalAuditLog } from '../../../src/common/AuditLog';

describe('DiagnosticsDashboard', () => {
  const mockBrowserCore = {
    stats: () => ({ initialized: true, contexts: 1, pages: 1 }),
  } as any;

  const stateManager = new StateManagementLayer();
  const reconciler = new StateReconciler();
  const previousSnapshots = new Map<string, SemanticSnapshot>();

  const dashboard = new DiagnosticsDashboard(
    mockBrowserCore,
    stateManager,
    reconciler,
    previousSnapshots
  );

  beforeAll(() => {
    // Register test sessions
    stateManager.registerSession('s1', { current_url: 'https://example.com' });
    stateManager.registerSession('s2', { current_url: 'https://google.com' });

    // Record some actions
    stateManager.recordAction({
      action_id: 'a1',
      session_id: 's1',
      action: 'click',
      status: 'success',
      requested_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 150,
      token_estimate: 500,
    });
    stateManager.recordAction({
      action_id: 'a2',
      session_id: 's1',
      action: 'type',
      status: 'success',
      requested_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 200,
      token_estimate: 480,
    });
  });

  describe('report()', () => {
    it('should generate a complete diagnostics report', () => {
      const report = dashboard.report();

      expect(report.timestamp).toBeDefined();
      expect(report.uptime_ms).toBeGreaterThanOrEqual(0);
      expect(report.health.status).toBe('ok');
      expect(report.health.score).toBeGreaterThan(0);
      expect(report.health.browser_initialized).toBe(true);
      expect(report.health.active_sessions).toBe(2);
    });

    it('should include performance analytics', () => {
      const report = dashboard.report();

      expect(report.performance).toBeDefined();
      expect(report.performance.cache).toBeDefined();
      expect(report.performance.cache.hit_rate).toBeDefined();
      expect(report.performance.reconciler).toBeDefined();
      expect(report.performance.tokens).toBeDefined();
    });

    it('should include session diagnostics', () => {
      const report = dashboard.report();

      expect(report.sessions.length).toBe(2);
      const s1 = report.sessions.find((s) => s.session_id === 's1');
      expect(s1).toBeDefined();
      expect(s1!.current_url).toBe('https://example.com');
      expect(s1!.action_count).toBe(2);
    });

    it('should include configuration snapshot', () => {
      const report = dashboard.report();

      expect(report.configuration.max_sessions).toBeDefined();
      expect(report.configuration.max_elements).toBeDefined();
      expect(report.configuration.audit_enabled).toBeDefined();
    });
  });

  describe('summary()', () => {
    it('should return a compact summary for LLM injection', () => {
      const summary = dashboard.summary();

      expect(summary.health).toBe('ok');
      expect(summary.score).toBeGreaterThan(0);
      expect(summary.sessions).toBe(2);
      expect(typeof summary.total_actions).toBe('number');
      expect(typeof summary.cache_hit_rate).toBe('number');
      expect(typeof summary.anomalies).toBe('number');
    });
  });

  describe('sessionAudit()', () => {
    it('should return audit events for a session', () => {
      // Record an audit event
      globalAuditLog.record({
        category: 'ACTION',
        session_id: 's1',
        action: 'click',
        result: 'success',
        duration_ms: 150,
        risk_score: 30,
      });

      const audit = dashboard.sessionAudit('s1');
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0].session_id).toBe('s1');
    });
  });

  describe('anomaly detection', () => {
    it('should detect session at capacity', () => {
      const config = ConfigurationManager.getInstance().getConfig();
      const oldMax = config.server.max_sessions;

      // Temporarily set max to match current count
      config.server.max_sessions = 2;
      const report = dashboard.report();
      config.server.max_sessions = oldMax;

      const capacityAnomaly = report.anomalies.find((a) => a.type === 'session_capacity');
      expect(capacityAnomaly).toBeDefined();
      expect(capacityAnomaly!.severity).toBe('critical');
    });
  });
});
