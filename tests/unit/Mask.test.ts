import { maskSnapshot, maskText } from '../../src/privacy/Mask';
import { SemanticSnapshot } from '../../src/common/types';

describe('privacy masking', () => {
  it('masks PII and secrets in semantic content while preserving ids and actions', () => {
    const snapshot: SemanticSnapshot = {
      snapshot_id: 'snapshot',
      version: '2.2.0',
      url: 'https://app.test/profile',
      title: 'Profile',
      timestamp: '2026-05-18T00:00:00.000Z',
      elements: [
        {
          id: 'email-field',
          type: 'input',
          label: 'Email',
          value: 'ada@example.com',
          placeholder: 'name@example.com',
        },
        {
          id: 'billing',
          type: 'table',
          rows: [['Card', '4111 1111 1111 1111'], ['Phone', '+1 (415) 555-0134']],
        },
        {
          id: 'token',
          type: 'text',
          text: 'access_token=abcDEF1234567890abcDEF1234567890',
        },
      ],
      available_actions: [{ action_id: 'type-email-field', action: 'type', target: 'email-field', label: 'Type Email' }],
      session: {
        session_id: 'session',
        tab_id: 'tab-1',
        tabs_count: 1,
        history_length: 0,
        cookies_count: 0,
      },
      navigation: {
        headings: [{ id: 'h', text: 'Contact ada@example.com' }],
      },
      auth: {
        authenticated: true,
        confidence: 1,
        user_identity: 'ada@example.com',
        indicators: ['user_identity'],
        cookies: [],
        updated_at: '2026-05-18T00:00:00.000Z',
      },
    };

    const stats = maskSnapshot(snapshot);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.elements[0].id).toBe('email-field');
    expect(snapshot.available_actions[0].target).toBe('email-field');
    expect(serialized).not.toContain('ada@example.com');
    expect(serialized).not.toContain('4111 1111 1111 1111');
    expect(serialized).not.toContain('+1 (415) 555-0134');
    expect(serialized).not.toContain('abcDEF1234567890abcDEF1234567890');
    expect(snapshot.auth?.user_identity).toBe('[email]');
    expect(stats.kinds).toEqual(expect.objectContaining({
      email: expect.any(Number),
      card: 1,
      phone: 1,
      secret: 1,
    }));
  });

  it('does not mask ordinary labels that only name a field type', () => {
    expect(maskText('Email and phone are required')).toBe('Email and phone are required');
  });
});
