import { SemCache } from '../../src/cache/Sem';

describe('SemCache', () => {
  const snapshot = {
    version: '2.1.0',
    url: 'https://example.test',
    title: 'Example',
    timestamp: '2026-05-18T00:00:00.000Z',
    elements: [],
    available_actions: [],
    session: {
      session_id: 'session',
      tab_id: 'tab-1',
      tabs_count: 1,
      history_length: 0,
      cookies_count: 0,
    },
  };

  it('stores snapshots, records hits, and trims by max entries', () => {
    const cache = new SemCache();
    cache.set('a', snapshot, 2);
    cache.set('b', { ...snapshot, url: 'https://example.test/b' }, 2);
    cache.set('c', { ...snapshot, url: 'https://example.test/c' }, 2);

    expect(cache.get('a', 1000)).toBeUndefined();
    expect(cache.get('c', 1000)?.snapshot.url).toBe('https://example.test/c');
    expect(cache.stats()).toEqual(expect.objectContaining({
      entries: 2,
      hits: 1,
      evictions: 1,
    }));
  });

  it('expires stale entries by ttl', () => {
    const cache = new SemCache();
    cache.set('a', snapshot, 10);

    expect(cache.get('a', -1)).toBeUndefined();
    expect(cache.stats()).toEqual(expect.objectContaining({
      entries: 0,
      stale: 1,
      misses: 1,
    }));
  });
});
