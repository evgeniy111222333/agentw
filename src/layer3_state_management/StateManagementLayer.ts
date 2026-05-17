import { Page } from 'playwright';
import { globalEventBus } from '../common/EventBus';
import { ActionRecord, SessionState } from '../common/types';

export class StateManagementLayer {
  private sessions: Map<string, SessionState> = new Map();
  private actionHistory: Map<string, ActionRecord[]> = new Map();

  constructor() {
    this.setupSubscriptions();
  }

  private setupSubscriptions() {
    globalEventBus.subscribe('action_completed', this.handleActionCompleted.bind(this));
  }

  public registerSession(sessionId: string) {
    const now = new Date().toISOString();
    this.sessions.set(sessionId, {
      session_id: sessionId,
      created_at: now,
      updated_at: now,
      status: 'active',
      current_url: '',
      tabs: [{ tab_id: 'tab-1', url: '', title: '', active: true }],
      cookies: [],
      localStorage: {},
      history: [],
      configuration: {}
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

  public getAction(sessionId: string, actionId: string): ActionRecord | undefined {
    return this.getActionHistory(sessionId).find((record) => record.action_id === actionId);
  }

  public getSessionState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }
}
