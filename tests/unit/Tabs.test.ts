import { StateManagementLayer } from '../../src/layer3_state_management/StateManagementLayer';
import { activeTab, deleteSessionSnaps, snapKey } from '../../src/session/Tabs';

describe('Tabs helpers and state sync', () => {
  it('tracks active tab and preserves per-tab snapshot metadata', () => {
    const state = new StateManagementLayer();
    state.registerSession('session');

    state.syncTabs('session', [
      { tab_id: 'tab-1', url: 'https://example.test/one', title: 'One', active: false },
      { tab_id: 'tab-2', url: 'https://example.test/two', title: 'Two', active: true },
    ]);
    state.recordPageState('session', {
      url: 'https://example.test/two',
      title: 'Two',
      snapshot_id: 'snapshot-two',
    });
    state.syncTabs('session', [
      { tab_id: 'tab-1', url: 'https://example.test/one', title: 'One', active: true },
      { tab_id: 'tab-2', url: 'https://example.test/two', title: 'Two', active: false },
    ]);

    const session = state.getSessionState('session');
    expect(activeTab(session)?.tab_id).toBe('tab-1');
    expect(session?.current_url).toBe('https://example.test/one');
    expect(session?.tabs.find((tab) => tab.tab_id === 'tab-2')?.snapshot_id).toBe('snapshot-two');
  });

  it('uses stable per-tab snapshot keys and deletes a whole session namespace', () => {
    const snapshots = new Map<string, number>([
      [snapKey('session', 'tab-1'), 1],
      [snapKey('session', 'tab-2'), 2],
      [snapKey('other', 'tab-1'), 3],
    ]);

    deleteSessionSnaps(snapshots, 'session');

    expect(snapshots.has(snapKey('session', 'tab-1'))).toBe(false);
    expect(snapshots.has(snapKey('session', 'tab-2'))).toBe(false);
    expect(snapshots.get(snapKey('other', 'tab-1'))).toBe(3);
  });
});
