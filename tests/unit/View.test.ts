import { defaultView, normalizeView, viewSignature } from '../../src/device/View';

describe('viewport profiles', () => {
  it('normalizes named mobile profiles and clamps unsafe dimensions', () => {
    const fallback = defaultView({
      viewport: { width: 1280, height: 720 },
      user_agent: 'desktop',
      ignore_https_errors: false,
      max_tabs_per_session: 5,
      memory_limit_mb: 2048,
    });

    const mobile = normalizeView({ profile: 'mobile', width: 100, height: 9000 }, fallback);

    expect(mobile).toEqual(expect.objectContaining({
      width: 240,
      height: 4320,
      is_mobile: true,
      has_touch: true,
      profile: 'mobile',
    }));
    expect(viewSignature(mobile)).toContain('240x4320');
  });
});
