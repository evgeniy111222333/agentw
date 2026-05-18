import { NetworkTracker } from '../../../src/layer3_state_management/trackers/NetworkTracker';
import { globalEventBus } from '../../../src/common/EventBus';

describe('Trackers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('NetworkTracker', () => {
    it('should publish network_idle after requests finish and debounce time elapses', () => {
      const pageMock = {
        on: jest.fn(),
      } as any;

      const publishSpy = jest.spyOn(globalEventBus, 'publish').mockResolvedValue(undefined);

      NetworkTracker.inject(pageMock, 'test-session');

      expect(pageMock.on).toHaveBeenCalledWith('request', expect.any(Function));
      expect(pageMock.on).toHaveBeenCalledWith('requestfinished', expect.any(Function));

      const requestHandler = pageMock.on.mock.calls.find((call: any) => call[0] === 'request')[1];
      const requestFinishedHandler = pageMock.on.mock.calls.find((call: any) => call[0] === 'requestfinished')[1];

      // Simulate 2 requests starting
      requestHandler();
      requestHandler();

      // One finishes
      requestFinishedHandler();
      jest.advanceTimersByTime(1000);
      expect(publishSpy).not.toHaveBeenCalledWith('network_idle', expect.anything());

      // Second finishes
      requestFinishedHandler();
      
      // Debounce is 500ms
      jest.advanceTimersByTime(300);
      expect(publishSpy).not.toHaveBeenCalledWith('network_idle', expect.anything());
      
      jest.advanceTimersByTime(200);
      expect(publishSpy).toHaveBeenCalledWith('network_idle', expect.objectContaining({ session_id: 'test-session' }));
    });
  });
});
