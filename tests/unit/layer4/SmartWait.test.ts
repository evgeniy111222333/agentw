import { SmartWait } from '../../../src/layer4_semantic/stabilization/SmartWait';
import { globalEventBus } from '../../../src/common/EventBus';

describe('SmartWait', () => {
  const smartWait = new SmartWait();

  const mockPage = {
    waitForLoadState: jest.fn().mockResolvedValue(undefined),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should resolve quickly when no mutations fire (already stable page)', async () => {
    // Simulate Playwright networkidle resolving fast
    mockPage.waitForLoadState = jest.fn().mockResolvedValue(undefined);

    const result = await smartWait.waitForStability(mockPage, {
      hardTimeoutMs: 2000,
      mutationQuietMs: 100,
    });

    expect(result.stable).toBe(true);
    expect(result.waited_ms).toBeLessThan(2000);
    expect(result.reason).toContain('quiet');
  });

  it('should extend wait when dom_mutated fires during quiet period', async () => {
    mockPage.waitForLoadState = jest.fn().mockResolvedValue(undefined);

    // Fire a mutation after 50ms to extend the quiet period
    const timer = setTimeout(() => {
      globalEventBus.publish('dom_mutated', { session_id: 'test-session', mutations: [] });
    }, 50);

    const result = await smartWait.waitForStability(mockPage, {
      hardTimeoutMs: 3000,
      mutationQuietMs: 200,
      sessionId: 'test-session',
    });

    clearTimeout(timer);

    expect(result.stable).toBe(true);
    // Should have waited at least 200ms after the last mutation (which was at ~50ms)
    expect(result.waited_ms).toBeGreaterThanOrEqual(200);
  });

  it('should hit hard timeout on continuously mutating page', async () => {
    mockPage.waitForLoadState = jest.fn().mockImplementation((state: string) => {
      if (state === 'networkidle') return new Promise((resolve) => setTimeout(resolve, 10000));
      return Promise.resolve(); // domcontentloaded resolves instantly
    });

    // Fire mutations every 30ms — never lets quiet period be reached
    const interval = setInterval(() => {
      globalEventBus.publish('dom_mutated', { session_id: 'spam', mutations: [] });
    }, 30);

    const result = await smartWait.waitForStability(mockPage, {
      hardTimeoutMs: 500,
      mutationQuietMs: 200,
      sessionId: 'spam',
    });

    clearInterval(interval);

    expect(result.stable).toBe(false);
    expect(result.reason).toBe('hard_timeout');
    expect(result.waited_ms).toBeGreaterThanOrEqual(400);
  }, 10000);

  it('should detect intersection events and extend wait', async () => {
    mockPage.waitForLoadState = jest.fn().mockResolvedValue(undefined);

    // Simulate lazy-loaded content appearing
    setTimeout(() => {
      globalEventBus.publish('element_visible', { session_id: 'lazy', element_id: 'img-5' });
    }, 50);

    const result = await smartWait.waitForStability(mockPage, {
      hardTimeoutMs: 3000,
      mutationQuietMs: 200,
      sessionId: 'lazy',
    });

    expect(result.stable).toBe(true);
    expect(result.intersection_fired).toBe(true);
  });

  it('should ignore events from other sessions', async () => {
    mockPage.waitForLoadState = jest.fn().mockResolvedValue(undefined);

    // Fire mutation for a DIFFERENT session
    setTimeout(() => {
      globalEventBus.publish('dom_mutated', { session_id: 'other-session', mutations: [] });
    }, 30);

    const result = await smartWait.waitForStability(mockPage, {
      hardTimeoutMs: 2000,
      mutationQuietMs: 100,
      sessionId: 'my-session',
    });

    expect(result.stable).toBe(true);
    // Should not have been delayed by the other session's mutation
    expect(result.waited_ms).toBeLessThan(1500);
  });
});
