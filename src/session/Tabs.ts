import { SessionState, TabState } from '../common/types';

export function activeTab(state: SessionState | undefined): TabState | undefined {
  return state?.tabs.find((tab) => tab.active) ?? state?.tabs[0];
}

export function snapKey(sessionId: string, tabId = 'tab-1'): string {
  return `${sessionId}:${tabId}`;
}

export function deleteSessionSnaps<T>(snapshots: Map<string, T>, sessionId: string): void {
  for (const key of Array.from(snapshots.keys())) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) snapshots.delete(key);
  }
}
