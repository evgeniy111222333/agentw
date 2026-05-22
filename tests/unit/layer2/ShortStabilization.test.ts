import { ActionExecutor } from '../../../src/layer2_action_execution/ActionExecutor';
import { Request } from 'playwright';

describe('ShortStabilization', () => {
  let executor: ActionExecutor;
  let mockPage: any;
  let listeners: Record<string, Function[]> = {};

  beforeEach(() => {
    executor = new ActionExecutor({ getPage: () => mockPage } as any);
    listeners = {};
    mockPage = {
      url: () => 'https://example.com',
      on: (event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      },
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
  });

  const trigger = (event: string, ...args: any[]) => {
    if (listeners[event]) {
      for (const cb of listeners[event]) {
        cb(...args);
      }
    }
  };

  it('should ignore websocket and eventsource requests', async () => {
    // Calling shortStabilization initiates request tracking
    const promise = (executor as any).shortStabilization(mockPage, 1000);

    const wsRequest = { resourceType: () => 'websocket' } as Request;
    const sseRequest = { resourceType: () => 'eventsource' } as Request;
    const documentRequest = { resourceType: () => 'document' } as Request;

    trigger('request', wsRequest);
    trigger('request', sseRequest);
    trigger('request', documentRequest);

    const tracker = (executor as any).activePageRequests.get(mockPage);
    expect(tracker).toBeDefined();
    // Only documentRequest should be tracked
    expect(tracker.requests.has(documentRequest)).toBe(true);
    expect(tracker.requests.has(wsRequest)).toBe(false);
    expect(tracker.requests.has(sseRequest)).toBe(false);

    // Finish the document request and trigger completion
    trigger('requestfinished', documentRequest);
    await promise;

    expect(tracker.requests.size).toBe(0);
  });

  it('should resolve immediately if there are no active requests', async () => {
    const started = Date.now();
    await (executor as any).waitForNetworkIdleCustom(mockPage, 500);
    // Since there are 0 active requests initially, it should resolve immediately
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('should wait for active requests to finish before resolving', async () => {
    const documentRequest = { resourceType: () => 'document' } as Request;
    // Track a request
    (executor as any).initRequestTracking(mockPage);
    trigger('request', documentRequest);

    let resolved = false;
    const promise = (executor as any).waitForNetworkIdleCustom(mockPage, 500).then(() => {
      resolved = true;
    });

    // Wait a bit, should not be resolved yet
    await new Promise(r => setTimeout(r, 100));
    expect(resolved).toBe(false);

    // Finish the request
    trigger('requestfinished', documentRequest);
    
    // Now wait for debounce + check interval
    await promise;
    expect(resolved).toBe(true);
  });

  it('should ignore requests active for longer than 1500ms (long-polling)', async () => {
    const longPollRequest = { resourceType: () => 'fetch' } as Request;
    
    (executor as any).initRequestTracking(mockPage);
    
    // Start request
    trigger('request', longPollRequest);
    
    // Mock the start time to be 2000ms ago
    const tracker = (executor as any).activePageRequests.get(mockPage);
    tracker.requests.set(longPollRequest, Date.now() - 2000);

    const started = Date.now();
    await (executor as any).waitForNetworkIdleCustom(mockPage, 500);
    // Since the only request is active for >1500ms, it is ignored and resolves immediately
    expect(Date.now() - started).toBeLessThan(100);
  });
});
