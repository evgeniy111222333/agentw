import { Probe } from '../../src/health/Probe';

describe('Health Probe', () => {
  it('reports health score and degraded signals from runtime state', () => {
    const probe = new Probe(
      {
        stats: () => ({ initialized: true, contexts: 2, pages: 2 }),
      } as any,
      {
        listSessions: () => [
          {
            session_id: 'session',
            status: 'active',
            updated_at: new Date(Date.now() - 120_000).toISOString(),
            current_url: 'https://example.test',
          },
        ],
      } as any,
      {
        listPlugins: () => [
          { name: 'ok', status: 'enabled', failures: 0 },
          { name: 'bad', status: 'disabled', failures: 1, disabled_reason: 'init failed' },
        ],
      } as any
    );

    const report = probe.report();

    expect(report.status).toBe('ok');
    expect(report.health_score).toBeLessThan(1);
    expect(report.checks.sessions.stale).toBe(1);
    expect(report.checks.plugins.disabled).toBe(1);
    expect(report.signals.disabled_plugins[0]).toEqual(expect.objectContaining({ name: 'bad' }));
  });
});
