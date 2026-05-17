import { CommandRouter } from '../../src/layer5_agent_interface/CommandRouter';

describe('CommandRouter', () => {
  const router = new CommandRouter(
    {} as any,
    {
      getActionHistory: () => [],
      getSessionState: () => ({
        session_id: 'session',
        status: 'active',
        updated_at: new Date().toISOString(),
        tabs: [],
        history: [],
        cookies: [],
        configuration: {},
      }),
      recordAction: jest.fn(),
    } as any,
    {} as any,
    {} as any,
    new Map()
  );

  it('normalizes REST commands and strips routing params from action params', () => {
    const command = router.normalizeRest('session', {
      action: 'click',
      params: {
        element_id: 'submit',
        extra: true,
      },
      trace_id: 'trace',
    });

    expect(command).toEqual({
      action: 'click',
      session_id: 'session',
      target_id: 'submit',
      action_params: { extra: true },
      trace_id: 'trace',
    });
  });

  it('rejects invalid commands before browser execution', async () => {
    await expect(
      router.execute({
        action: 'type',
        session_id: 'session',
        target_id: 'email',
        action_params: {},
      })
    ).rejects.toMatchObject({
      code: 'MISSING_PARAM',
    });
  });

  it('validates file system action parameters before execution', async () => {
    await expect(
      router.execute({
        action: 'fs',
        session_id: 'session',
        action_params: {
          operation: 'write',
          path: '/uploads/a.txt',
        },
      })
    ).rejects.toMatchObject({
      code: 'MISSING_PARAM',
    });
  });
});
