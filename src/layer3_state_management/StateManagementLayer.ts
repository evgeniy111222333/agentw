import { Page } from 'playwright';
import { globalEventBus } from '../common/EventBus';
import { ActionRecord, SessionState, TabState } from '../common/types';

export class StateManagementLayer {
  private sessions: Map<string, SessionState> = new Map();
  private actionHistory: Map<string, ActionRecord[]> = new Map();

  constructor() {
    this.setupSubscriptions();
  }

  private setupSubscriptions() {
    globalEventBus.subscribe('action_completed', this.handleActionCompleted.bind(this));
  }

  public registerSession(sessionId: string, initial: Partial<SessionState> = {}) {
    const now = new Date().toISOString();
    this.sessions.set(sessionId, {
      session_id: sessionId,
      created_at: initial.created_at ?? now,
      updated_at: now,
      status: 'active',
      current_url: initial.current_url ?? '',
      tabs: initial.tabs ?? [{ tab_id: 'tab-1', url: '', title: '', active: true }],
      cookies: initial.cookies ?? [],
      localStorage: initial.localStorage ?? {},
      history: initial.history ?? [],
      configuration: initial.configuration ?? {},
      viewport: initial.viewport,
    });
    this.actionHistory.set(sessionId, []);
  }

  public async injectMutationObserver(page: Page, sessionId: string) {
    await page.exposeFunction('reportMutation', (mutations: any[]) => {
      globalEventBus.publish('dom_mutated', { session_id: sessionId, mutations });
    });

    await page.addInitScript(() => {
      const observer = new MutationObserver((mutations) => {
        const serialized = mutations.map(m => ({
          type: m.type,
          target: m.target ? (m.target as Element).id || (m.target as Element).tagName : null,
        }));
        (window as any).reportMutation(serialized);
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    });
  }

  private async handleActionCompleted(payload: any) {
    const { session_id } = payload;
    const session = this.sessions.get(session_id);
    if (session) {
      session.updated_at = new Date().toISOString();
      this.sessions.set(session_id, session);
    }
  }

  public recordPageState(sessionId: string, pageState: { url: string; title: string; snapshot_id?: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const now = new Date().toISOString();
    const activeTab = session.tabs.find((tab) => tab.active) ?? session.tabs[0];
    if (!activeTab) return;
    activeTab.url = pageState.url;
    activeTab.title = pageState.title;
    activeTab.snapshot_id = pageState.snapshot_id;

    if (pageState.url && session.current_url !== pageState.url) {
      session.history.push({
        url: pageState.url,
        timestamp: now,
        navigation_type: session.current_url ? 'action' : 'initial',
        referrer: session.current_url || undefined,
      });
      session.history = session.history.slice(-50);
    }

    session.current_url = pageState.url;
    session.updated_at = now;
    this.sessions.set(sessionId, session);
  }

  public syncTabs(sessionId: string, tabs: TabState[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const previous = new Map(session.tabs.map((tab) => [tab.tab_id, tab]));
    const normalized = tabs.map((tab, index) => {
      const old = previous.get(tab.tab_id);
      return {
        ...tab,
        active: index === 0 ? Boolean(tab.active || !tabs.some((candidate) => candidate.active)) : Boolean(tab.active),
        viewport: tab.viewport ?? old?.viewport,
        snapshot_id: old?.snapshot_id,
        form_states: old?.form_states,
      };
    });
    if (!normalized.some((tab) => tab.active) && normalized[0]) normalized[0].active = true;

    const activeTab = normalized.find((tab) => tab.active) ?? normalized[0];
    session.tabs = normalized;
    session.current_url = activeTab?.url ?? session.current_url;
    session.viewport = activeTab?.viewport ?? session.viewport;
    session.updated_at = new Date().toISOString();
    this.sessions.set(sessionId, session);
  }

  public closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'closed';
    session.updated_at = new Date().toISOString();
    this.sessions.set(sessionId, session);
  }

  public listSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  public updateSession(sessionId: string, patch: Partial<SessionState>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, {
      ...session,
      ...patch,
      session_id: sessionId,
      updated_at: new Date().toISOString(),
    });
  }

  public recordAction(record: ActionRecord): void {
    const history = this.actionHistory.get(record.session_id) ?? [];
    const existingIndex = history.findIndex((entry) => entry.action_id === record.action_id);
    if (existingIndex >= 0) {
      history[existingIndex] = { ...history[existingIndex], ...record };
    } else {
      history.push(record);
    }
    this.actionHistory.set(record.session_id, history.slice(-200));
  }

  public getActionHistory(sessionId: string): ActionRecord[] {
    return this.actionHistory.get(sessionId) ?? [];
  }

  public setActionHistory(sessionId: string, records: ActionRecord[]): void {
    this.actionHistory.set(
      sessionId,
      records
        .map((record) => ({ ...record, session_id: sessionId }))
        .slice(-200)
    );
  }

  public getAction(sessionId: string, actionId: string): ActionRecord | undefined {
    return this.getActionHistory(sessionId).find((record) => record.action_id === actionId);
  }

  public getSessionState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }
}
