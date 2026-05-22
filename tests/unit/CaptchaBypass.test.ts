import { CaptchaDetector } from '../../src/layer2_action_execution/CaptchaDetector';
import { CommandRouter } from '../../src/layer5_agent_interface/CommandRouter';
import { ActionExecutor } from '../../src/layer2_action_execution/ActionExecutor';
import { LlmBrowserError } from '../../src/common/errors';
import { globalEventBus } from '../../src/common/EventBus';

describe('3-Level CAPTCHA Bypass System', () => {
  describe('Level 1: Stealth & Human Simulation', () => {
    it('applies realistic Bezier mouse movement steps', async () => {
      const mouseMovements: Array<[number, number]> = [];
      const fakePage = {
        mouse: {
          move: jest.fn(async (x: number, y: number) => {
            mouseMovements.push([x, y]);
          }),
        },
      } as any;

      const executor = new ActionExecutor({} as any);
      (executor as any).visualStates.set('session', { x: 10, y: 20 });

      await executor.simulateHumanMouse('session', fakePage, 100, 200);

      expect(mouseMovements.length).toBeGreaterThan(5);
      expect(mouseMovements[mouseMovements.length - 1]).toEqual([100, 200]);
    });

    it('types character by character with delays', async () => {
      const typeSequence: string[] = [];
      const fakeLocator = {
        focus: jest.fn(async () => {}),
        type: jest.fn(async (char: string) => {
          typeSequence.push(char);
        }),
      } as any;

      const executor = new ActionExecutor({} as any);
      await executor.simulateHumanType(fakeLocator, 'hello', 1000);

      expect(typeSequence).toEqual(['h', 'e', 'l', 'l', 'o']);
      expect(fakeLocator.focus).toHaveBeenCalled();
    });
  });

  describe('Level 2: CAPTCHA Detection & Solving', () => {
    it('detects reCAPTCHA sitekeys in main frame', async () => {
      const fakePage = {
        evaluate: jest.fn(async () => [
          { type: 'recaptcha', sitekey: '6LeOeObSTAAAAGG1zgn_6UY7tAM2JNsLBKe', url: 'https://example.com' }
        ]),
        frames: () => [],
      } as any;

      const detected = await CaptchaDetector.detect(fakePage);
      expect(detected).toEqual({
        type: 'recaptcha',
        sitekey: '6LeOeObSTAAAAGG1zgn_6UY7tAM2JNsLBKe',
        url: 'https://example.com'
      });
    });

    it('solves CAPTCHA via mock API and injects token', async () => {
      const originalFetch = global.fetch;
      const originalSetTimeout = global.setTimeout;
      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 1, request: 'task-123' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 1, request: 'solved-token-xyz' }),
        });
      global.fetch = mockFetch;
      (global as any).setTimeout = (cb: any, ms?: number) => originalSetTimeout(cb, 0);

      try {
        const captcha = {
          type: 'recaptcha' as const,
          sitekey: 'test-sitekey',
          url: 'https://example.com',
        };

        const token = await CaptchaDetector.solve(captcha, '2captcha', 'mock-api-key', 5000);
        expect(token).toBe('solved-token-xyz');
        expect(mockFetch).toHaveBeenCalledTimes(2);

        const fakePage = {
          evaluate: jest.fn(async (fn: any, args: any) => {
            expect(args.captcha).toBe(captcha);
            expect(args.token).toBe('solved-token-xyz');
          }),
          frames: () => [],
        } as any;

        await CaptchaDetector.injectToken(fakePage, captcha, 'solved-token-xyz');
        expect(fakePage.evaluate).toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
        global.setTimeout = originalSetTimeout;
      }
    });
  });

  describe('Level 3: Session Pausing & HITL Fallback', () => {
    it('rejects commands when session is paused', async () => {
      const stateManager = {
        getSessionState: jest.fn((id: string) => {
          if (id === 'session-paused') {
            return { session_id: 'session-paused', status: 'paused', tabs: [], history: [], cookies: [] };
          }
          return { session_id: 'session-active', status: 'active', tabs: [], history: [], cookies: [] };
        }),
        recordAction: jest.fn(),
        syncTabs: jest.fn(),
        recordPageState: jest.fn(),
        updateSession: jest.fn(),
      } as any;

      const router = new CommandRouter(
        {
          getPage: () => ({
            evaluate: async () => [],
            frames: () => [],
          }),
          getViewport: () => ({ width: 800, height: 600 }),
          listTabs: async () => [],
        } as any,
        stateManager,
        {} as any,
        {} as any,
        new Map()
      );

      await expect(
        router.execute({
          action: 'click',
          session_id: 'session-paused',
          target_id: 'btn',
          action_params: {},
        })
      ).rejects.toThrow(LlmBrowserError);

      try {
        await router.execute({
          action: 'click',
          session_id: 'session-paused',
          target_id: 'btn',
          action_params: {},
        });
      } catch (err: any) {
        expect(err.code).toBe('SESSION_PAUSED');
      }

      const promise = router.execute({
        action: 'click',
        session_id: 'session-active',
        target_id: 'btn',
        action_params: {},
      });
      await expect(promise).rejects.not.toMatchObject({ code: 'SESSION_PAUSED' });
    });

    it('pauses session and fires events when solve_captcha fails or lacks keys', async () => {
      const stateManager = {
        updateSession: jest.fn(),
      } as any;

      const events: any[] = [];
      const eventSubscription = (event: any) => {
        events.push(event);
      };
      globalEventBus.subscribe('stream_event', eventSubscription);

      try {
        const fakePage = {
          evaluate: async () => [{ type: 'recaptcha', sitekey: 'key', url: 'url' }],
          frames: () => [],
        } as any;

        const executor = new ActionExecutor(
          {
            getPage: () => fakePage,
          } as any,
          {} as any,
          stateManager
        );

        await expect(
          (executor as any).dispatch('session-1', fakePage, 'solve_captcha', undefined, { provider: '2captcha' })
        ).rejects.toThrow(LlmBrowserError);

        expect(stateManager.updateSession).toHaveBeenCalledWith('session-1', { status: 'paused' });
        expect(events).toContainEqual(expect.objectContaining({
          type: 'session_paused',
          session_id: 'session-1',
        }));
      } finally {
        globalEventBus.unsubscribe('stream_event', eventSubscription);
      }
    });
  });
});
