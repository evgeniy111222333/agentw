import { ConfigurationManager, SecurityConfig } from '../../src/config/ConfigurationManager';
import { StateManagementLayer } from '../../src/layer3_state_management/StateManagementLayer';
import { SecurityPolicy } from '../../src/security/SecurityPolicy';

describe('SecurityPolicy', () => {
  const configManager = ConfigurationManager.getInstance();
  let originalSecurity: SecurityConfig;

  beforeEach(() => {
    originalSecurity = { ...configManager.getConfig().security };
  });

  afterEach(() => {
    configManager.updateConfig({ security: originalSecurity });
  });

  it('blocks blacklisted navigation domains', () => {
    const state = new StateManagementLayer();
    state.registerSession('session');
    const policy = new SecurityPolicy(state);
    configManager.updateConfig({
      security: {
        ...originalSecurity,
        domain_blacklist: ['blocked.test'],
      },
    });

    expect(() =>
      policy.authorize({
        action: 'navigate',
        session_id: 'session',
        action_params: { url: 'https://blocked.test/path' },
      })
    ).toThrow(expect.objectContaining({ code: 'SECURITY_VIOLATION' }));
  });

  it('applies navigation domain policy to new tabs', () => {
    const state = new StateManagementLayer();
    state.registerSession('session');
    const policy = new SecurityPolicy(state);
    configManager.updateConfig({
      security: {
        ...originalSecurity,
        domain_blacklist: ['blocked.test'],
      },
    });

    expect(() =>
      policy.authorize({
        action: 'open_tab',
        session_id: 'session',
        action_params: { url: 'https://blocked.test/path' },
      })
    ).toThrow(expect.objectContaining({ code: 'SECURITY_VIOLATION' }));
  });

  it('enforces per-session token bucket limits', () => {
    const state = new StateManagementLayer();
    state.registerSession('session');
    const policy = new SecurityPolicy(state);
    configManager.updateConfig({
      security: {
        ...originalSecurity,
        rate_limit_per_minute: 1,
      },
    });

    policy.authorize({ action: 'snapshot', session_id: 'session' });

    expect(() => policy.authorize({ action: 'snapshot', session_id: 'session' })).toThrow(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' })
    );
  });
});
