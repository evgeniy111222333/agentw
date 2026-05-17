import { TraceStore } from '../../src/trace/Trace';

describe('TraceStore', () => {
  it('keeps trace spans, status, and filters by session', () => {
    const traces = new TraceStore(10);
    traces.start({ trace_id: 'trace-1', session_id: 'session-1', action: 'click', target_id: 'button' });
    traces.addSpan('trace-1', {
      name: 'action.execute',
      started_at: '2026-05-18T00:00:00.000Z',
      duration_ms: 12,
      status: 'ok',
      attributes: { action: 'click' },
    });
    traces.finish('trace-1', 'success', 20);

    expect(traces.get('trace-1')).toEqual(expect.objectContaining({
      trace_id: 'trace-1',
      status: 'success',
      duration_ms: 20,
      spans: [expect.objectContaining({ name: 'action.execute', duration_ms: 12 })],
    }));
    expect(traces.list({ session_id: 'session-1' })).toHaveLength(1);
    expect(traces.stats()).toEqual(expect.objectContaining({ retained: 1, success: 1 }));
  });

  it('retains only the configured number of traces', () => {
    const traces = new TraceStore(1);
    traces.start({ trace_id: 'old', session_id: 'session', action: 'wait' });
    traces.start({ trace_id: 'new', session_id: 'session', action: 'wait' });

    expect(traces.get('old')).toBeUndefined();
    expect(traces.get('new')).toBeDefined();
  });
});
