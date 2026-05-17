import { ActionRecord, SemanticSnapshot, SessionState } from '../common/types';

export const SESSION_PACK_VERSION = 'session-pack/1.0';

export interface SessionPack {
  version: typeof SESSION_PACK_VERSION;
  exported_at: string;
  session: SessionState;
  actions: ActionRecord[];
  browser: {
    storage_state: Record<string, any>;
  };
  page: {
    url: string;
    title: string;
  };
  snapshot?: SemanticSnapshot;
}

export function makePack(input: {
  session: SessionState;
  actions: ActionRecord[];
  storageState: Record<string, any>;
  page: { url: string; title: string };
  snapshot?: SemanticSnapshot;
}): SessionPack {
  return {
    version: SESSION_PACK_VERSION,
    exported_at: new Date().toISOString(),
    session: clone(input.session),
    actions: clone(input.actions),
    browser: {
      storage_state: clone(input.storageState),
    },
    page: clone(input.page),
    snapshot: input.snapshot ? clone(input.snapshot) : undefined,
  };
}

export function readPack(raw: any): SessionPack {
  const pack = raw?.package ?? raw?.pack ?? raw;
  if (!pack || typeof pack !== 'object') throw new Error('Session package is required');
  if (pack.version !== SESSION_PACK_VERSION) {
    throw new Error(`Unsupported session package version: ${pack.version ?? 'unknown'}`);
  }
  if (!pack.session?.session_id) throw new Error('Session package missing session');
  if (!pack.browser?.storage_state) throw new Error('Session package missing browser storage_state');

  return {
    version: SESSION_PACK_VERSION,
    exported_at: String(pack.exported_at ?? new Date().toISOString()),
    session: clone(pack.session),
    actions: Array.isArray(pack.actions) ? clone(pack.actions) : [],
    browser: {
      storage_state: clone(pack.browser.storage_state),
    },
    page: {
      url: String(pack.page?.url ?? pack.session.current_url ?? ''),
      title: String(pack.page?.title ?? ''),
    },
    snapshot: pack.snapshot ? clone(pack.snapshot) : undefined,
  };
}

export function importedSession(pack: SessionPack, sessionId: string): SessionState {
  const now = new Date().toISOString();
  return {
    ...clone(pack.session),
    session_id: sessionId,
    status: 'active',
    current_url: pack.page.url || pack.session.current_url || '',
    tabs: normalizeTabs(pack, sessionId),
    history: clone(pack.session.history ?? []).slice(-50),
    configuration: {
      ...(pack.session.configuration ?? {}),
      imported_from_session_id: pack.session.session_id,
      imported_at: now,
    },
    updated_at: now,
  };
}

export function importedActions(pack: SessionPack, sessionId: string): ActionRecord[] {
  return pack.actions.map((record) => ({
    ...clone(record),
    session_id: sessionId,
  }));
}

export function importedSnapshot(pack: SessionPack, sessionId: string): SemanticSnapshot | undefined {
  if (!pack.snapshot) return undefined;
  const snapshot = clone(pack.snapshot);
  snapshot.session = {
    ...snapshot.session,
    session_id: sessionId,
  };
  return snapshot;
}

function normalizeTabs(pack: SessionPack, sessionId: string): SessionState['tabs'] {
  const tabs = pack.session.tabs?.length
    ? clone(pack.session.tabs)
    : [{ tab_id: 'tab-1', url: pack.page.url, title: pack.page.title, active: true }];
  let sawActive = false;
  const normalized = tabs.map((tab, index) => {
    const active = index === 0 ? true : Boolean(tab.active && !sawActive);
    if (active) sawActive = true;
    return {
      ...tab,
      tab_id: tab.tab_id || `tab-${index + 1}`,
      url: active ? pack.page.url || tab.url || '' : tab.url || '',
      title: active ? pack.page.title || tab.title || '' : tab.title || '',
      active,
      form_states: tab.form_states,
    };
  });
  if (!normalized.some((tab) => tab.active)) normalized[0].active = true;
  return normalized;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
