import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { Page } from 'playwright';
import { globalEventBus } from '../common/EventBus';
import { ActionRecord, FormState, SessionState, TabState } from '../common/types';
import { HistoryTracker } from './trackers/HistoryTracker';
import { NetworkTracker } from './trackers/NetworkTracker';
import { IntersectionTracker } from './trackers/IntersectionTracker';
import { FormTracker } from './trackers/FormTracker';

export class StateManagementLayer {
  private sessions: Map<string, SessionState> = new Map();
  private actionHistory: Map<string, ActionRecord[]> = new Map();
  private formStates: Map<string, Record<string, FormState>> = new Map();
  private visibilityState: Map<string, Record<string, { visible: boolean; visible_ratio: number; updated_at: string }>> = new Map();
  private recentMutations: Map<string, any[]> = new Map();
  private checkpointExtras: Map<string, Record<string, any>> = new Map();
  private checkpointExtrasProvider?: (sessionId: string) => Record<string, any> | undefined;
  private checkpointDir = process.env.PRISM_CHECKPOINT_DIR ?? process.env.LLM_BROWSER_CHECKPOINT_DIR ?? path.join(process.cwd(), '.prism', 'checkpoints');
  private checkpointTimer?: NodeJS.Timeout;

  constructor() {
    this.setupSubscriptions();
    this.loadCheckpoints();
    this.checkpointTimer = setInterval(() => {
      for (const sessionId of this.sessions.keys()) {
        void this.checkpointSession(sessionId, 'periodic');
      }
    }, Number(process.env.PRISM_CHECKPOINT_INTERVAL_MS ?? process.env.LLM_BROWSER_CHECKPOINT_INTERVAL_MS ?? 60000));
    this.checkpointTimer.unref?.();
  }

  public setCheckpointExtrasProvider(provider: (sessionId: string) => Record<string, any> | undefined): void {
    this.checkpointExtrasProvider = provider;
  }

  public getCheckpointExtras(sessionId: string): Record<string, any> {
    return this.checkpointExtras.get(sessionId) ?? {};
  }

  private setupSubscriptions(): void {
    globalEventBus.subscribe('action_completed', this.handleActionCompleted.bind(this));
    globalEventBus.subscribe('action_failed', this.handleActionCompleted.bind(this));
    globalEventBus.subscribe('form_state_updated', this.handleFormStateUpdated.bind(this));
    globalEventBus.subscribe('element_visibility_changed', this.handleVisibilityChanged.bind(this));
    globalEventBus.subscribe('dom_mutated', this.handleDomMutated.bind(this));
  }

  public registerSession(sessionId: string, initial: Partial<SessionState> = {}): void {
    const now = new Date().toISOString();
    const formStates = initial.form_states ?? this.formStates.get(sessionId) ?? {};
    this.sessions.set(sessionId, {
      session_id: sessionId,
      created_at: initial.created_at ?? now,
      updated_at: now,
      status: initial.status ?? 'active',
      current_url: initial.current_url ?? '',
      tabs: initial.tabs ?? [{ tab_id: 'tab-1', url: '', title: '', active: true, form_states: formStates }],
      cookies: initial.cookies ?? [],
      localStorage: initial.localStorage ?? {},
      history: initial.history ?? [],
      configuration: initial.configuration ?? {},
      viewport: initial.viewport,
      auth: initial.auth,
      form_states: formStates,
      checkpoint: initial.checkpoint,
    });
    this.formStates.set(sessionId, formStates);
    this.actionHistory.set(sessionId, this.actionHistory.get(sessionId) ?? []);
  }

  public async injectAllTrackers(page: Page, sessionId: string): Promise<void> {
    await this.injectMutationObserver(page, sessionId);
    await HistoryTracker.inject(page, sessionId);
    NetworkTracker.inject(page, sessionId);
    await IntersectionTracker.inject(page, sessionId);
    await FormTracker.inject(page, sessionId);
  }

  public async injectMutationObserver(page: Page, sessionId: string): Promise<void> {
    await exposeOnce(page, 'reportMutation', async (batch: any) => {
      const mutations = Array.isArray(batch) ? batch : batch?.mutations ?? [];
      const timestamp = batch?.timestamp ?? new Date().toISOString();
      const payload = {
        session_id: sessionId,
        mutations,
        timestamp,
        debounce_ms: batch?.debounce_ms ?? 500,
        continuous: Boolean(batch?.continuous),
        dropped: Number(batch?.dropped ?? 0),
      };
      await globalEventBus.publish('dom_mutated', payload);
      for (const mutation of mutations.slice(0, 200)) {
        await publishDomMutation(sessionId, mutation, timestamp);
      }
    });

    await page.addInitScript(mutationObserverScript, sessionId);
    await page.evaluate(mutationObserverScript, sessionId).catch(() => undefined);
  }

  private async handleActionCompleted(payload: any): Promise<void> {
    const { session_id } = payload;
    const session = this.sessions.get(session_id);
    if (session) {
      session.updated_at = new Date().toISOString();
      this.sessions.set(session_id, session);
      await this.checkpointSession(session_id, payload.action ? `action:${payload.action}` : 'action');
    }
  }

  private handleFormStateUpdated(payload: any): void {
    const sessionId = payload.session_id;
    const data = payload.data ?? payload.form_state ?? payload;
    const state = normalizeFormState(data, payload.timestamp);
    if (!sessionId || !state) return;
    const states = { ...(this.formStates.get(sessionId) ?? {}) };
    states[state.form_id] = state;
    this.formStates.set(sessionId, states);
    this.updateSession(sessionId, { form_states: states });
    this.patchActiveTab(sessionId, { form_states: states });
  }

  private handleVisibilityChanged(payload: any): void {
    const sessionId = payload.session_id;
    if (!sessionId) return;
    const state = { ...(this.visibilityState.get(sessionId) ?? {}) };
    for (const entry of payload.entries ?? []) {
      const id = entry.targetId ?? entry.target_id;
      if (!id) continue;
      state[id] = {
        visible: Boolean(entry.isIntersecting ?? entry.visible),
        visible_ratio: Number(entry.intersectionRatio ?? entry.visible_ratio ?? 0),
        updated_at: payload.timestamp ?? new Date().toISOString(),
      };
      if (state[id].visible && state[id].visible_ratio >= 0.5) {
        void globalEventBus.publish('element_visible', {
          session_id: sessionId,
          element_id: id,
          visible_ratio: state[id].visible_ratio,
          timestamp: state[id].updated_at,
        });
      }
    }
    this.visibilityState.set(sessionId, state);
  }

  private handleDomMutated(payload: any): void {
    const sessionId = payload.session_id;
    if (!sessionId) return;
    const existing = this.recentMutations.get(sessionId) ?? [];
    this.recentMutations.set(sessionId, [...existing, ...(payload.mutations ?? [])].slice(-1000));
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
    activeTab.form_states = this.formStates.get(sessionId) ?? activeTab.form_states;

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
    session.form_states = this.formStates.get(sessionId) ?? session.form_states;
    session.updated_at = now;
    this.sessions.set(sessionId, session);
  }

  public syncTabs(sessionId: string, tabs: TabState[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const previous = new Map(session.tabs.map((tab) => [tab.tab_id, tab]));
    const formStates = this.formStates.get(sessionId);
    const normalized = tabs.map((tab, index) => {
      const old = previous.get(tab.tab_id);
      return {
        ...tab,
        active: index === 0 ? Boolean(tab.active || !tabs.some((candidate) => candidate.active)) : Boolean(tab.active),
        viewport: tab.viewport ?? old?.viewport,
        snapshot_id: old?.snapshot_id,
        form_states: tab.active ? formStates ?? old?.form_states : old?.form_states,
      };
    });
    if (!normalized.some((tab) => tab.active) && normalized[0]) normalized[0].active = true;

    const activeTab = normalized.find((tab) => tab.active) ?? normalized[0];
    session.tabs = normalized;
    session.current_url = activeTab?.url ?? session.current_url;
    session.viewport = activeTab?.viewport ?? session.viewport;
    session.form_states = formStates ?? session.form_states;
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

  public purgeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.actionHistory.delete(sessionId);
    this.formStates.delete(sessionId);
    this.visibilityState.delete(sessionId);
    this.recentMutations.delete(sessionId);
    this.checkpointExtras.delete(sessionId);
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

  public getFormStates(sessionId: string): Record<string, FormState> {
    return this.formStates.get(sessionId) ?? {};
  }

  public setFormStates(sessionId: string, states: Record<string, FormState>): void {
    this.formStates.set(sessionId, states);
    this.updateSession(sessionId, { form_states: states });
    this.patchActiveTab(sessionId, { form_states: states });
  }

  public getRecentMutations(sessionId: string): any[] {
    return this.recentMutations.get(sessionId) ?? [];
  }

  public getVisibilityState(sessionId: string): Record<string, { visible: boolean; visible_ratio: number; updated_at: string }> {
    return this.visibilityState.get(sessionId) ?? {};
  }

  public async checkpointSession(sessionId: string, reason = 'manual'): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const checkpointedAt = new Date().toISOString();
    const filePath = path.join(this.checkpointDir, `${safeFileName(sessionId)}.json`);
    const payload = {
      version: 'state-checkpoint/1.0',
      checkpointed_at: checkpointedAt,
      reason,
      session,
      actions: this.getActionHistory(sessionId),
      form_states: this.getFormStates(sessionId),
      recent_mutations: this.getRecentMutations(sessionId),
      visibility: this.getVisibilityState(sessionId),
      event_bus: globalEventBus.snapshot({ session_id: sessionId, limit: 500 }),
      ...(this.checkpointExtrasProvider?.(sessionId) ?? {}),
    };
    await fs.promises.mkdir(this.checkpointDir, { recursive: true });
    await writeCheckpointAtomic(filePath, payload);
    this.updateSession(sessionId, {
      checkpoint: {
        last_checkpoint_at: checkpointedAt,
        checkpoint_path: filePath,
        checkpoint_reason: reason,
      },
    });
    return filePath;
  }

  public restoreCheckpoint(sessionId: string): boolean {
    const filePath = path.join(this.checkpointDir, `${safeFileName(sessionId)}.json`);
    if (!fs.existsSync(filePath)) return false;
    const raw = readCheckpointFile(filePath);
    if (!raw?.session?.session_id) return false;
    this.sessions.set(sessionId, { ...raw.session, session_id: sessionId, status: 'active' });
    this.actionHistory.set(sessionId, Array.isArray(raw.actions) ? raw.actions : []);
    this.formStates.set(sessionId, raw.form_states ?? {});
    this.visibilityState.set(sessionId, raw.visibility ?? {});
    this.recentMutations.set(sessionId, raw.recent_mutations ?? []);
    this.checkpointExtras.set(sessionId, extractCheckpointExtras(raw));
    return true;
  }

  private loadCheckpoints(): void {
    if (!fs.existsSync(this.checkpointDir)) return;
    for (const file of fs.readdirSync(this.checkpointDir).filter((entry) => entry.endsWith('.json'))) {
      try {
        const raw = readCheckpointFile(path.join(this.checkpointDir, file));
        const sessionId = raw?.session?.session_id;
        if (!sessionId || this.sessions.has(sessionId)) continue;
        this.sessions.set(sessionId, { ...raw.session, status: 'suspended' });
        this.actionHistory.set(sessionId, raw.actions ?? []);
        this.formStates.set(sessionId, raw.form_states ?? {});
        this.visibilityState.set(sessionId, raw.visibility ?? {});
        this.recentMutations.set(sessionId, raw.recent_mutations ?? []);
        this.checkpointExtras.set(sessionId, extractCheckpointExtras(raw));
      } catch {
        // Ignore corrupt checkpoints; they are diagnostic artifacts, not source of truth.
      }
    }
  }

  private patchActiveTab(sessionId: string, patch: Partial<TabState>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const activeTab = session.tabs.find((tab) => tab.active) ?? session.tabs[0];
    if (!activeTab) return;
    Object.assign(activeTab, patch);
    session.updated_at = new Date().toISOString();
    this.sessions.set(sessionId, session);
  }
}

async function exposeOnce(page: Page, name: string, fn: (...args: any[]) => any): Promise<void> {
  try {
    await page.exposeFunction(name, fn);
  } catch (error) {
    if (!/already exists|has been already registered|Function .* has been already registered/i.test(String((error as Error).message))) {
      throw error;
    }
  }
}

async function publishDomMutation(sessionId: string, mutation: any, timestamp: string): Promise<void> {
  const base = { session_id: sessionId, timestamp, mutation };
  if (mutation.type === 'childList') {
    for (const node of mutation.added ?? []) {
      await globalEventBus.publish('node_added', { ...base, target_id: node.id, node });
    }
    for (const node of mutation.removed ?? []) {
      await globalEventBus.publish('node_removed', { ...base, target_id: node.id, node });
    }
  } else if (mutation.type === 'attributes') {
    await globalEventBus.publish('attribute_changed', {
      ...base,
      target_id: mutation.target_id,
      attribute: mutation.attribute_name,
      old_value: mutation.old_value,
      new_value: mutation.new_value,
    });
  } else if (mutation.type === 'characterData') {
    await globalEventBus.publish('text_changed', { ...base, target_id: mutation.target_id, text: mutation.text });
  }
}

function normalizeFormState(data: any, timestamp?: string): FormState | undefined {
  const formId = data.form_id ?? data.formId ?? data.id;
  if (!formId) return undefined;
  return {
    form_id: String(formId),
    fields: data.fields ?? {},
    errors: Array.isArray(data.errors) ? data.errors.map(String) : [],
    is_dirty: Boolean(data.is_dirty ?? data.isDirty),
    is_valid: Boolean(data.is_valid ?? data.isValid),
    completion_percentage: Number(data.completion_percentage ?? data.completionPercentage ?? 0),
    updated_at: timestamp ?? data.updated_at ?? new Date().toISOString(),
  };
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

async function writeCheckpointAtomic(filePath: string, payload: Record<string, any>): Promise<void> {
  const body = JSON.stringify(payload);
  const wrapped = {
    checkpoint_format: 'state-checkpoint-envelope/1.0',
    checksum: checksum(body),
    payload,
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(wrapped, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, filePath);
}

function readCheckpointFile(filePath: string): any {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (raw?.checkpoint_format === 'state-checkpoint-envelope/1.0') {
    const body = JSON.stringify(raw.payload);
    if (raw.checksum !== checksum(body)) {
      throw new Error(`Checkpoint checksum mismatch: ${filePath}`);
    }
    return raw.payload;
  }
  return raw;
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function extractCheckpointExtras(raw: any): Record<string, any> {
  const extras: Record<string, any> = {};
  if (raw?.scripts) extras.scripts = raw.scripts;
  return extras;
}

function mutationObserverScript(sessionId: string): void {
  const win = window as any;
  const key = '__prismMutationObserver';
  if (win[key]?.sessionId === sessionId) return;

  const semanticIdAttr = 'data-prism-id';
  const legacySemanticIdAttr = 'data-llm-browser-id';
  const ignoredAttributes = new Set([semanticIdAttr, legacySemanticIdAttr]);
  const selectorFor = (node: Node): string | undefined => {
    if (!(node instanceof Element)) return undefined;
    const id = node.getAttribute(semanticIdAttr) || node.getAttribute(legacySemanticIdAttr) || node.id;
    const attr = node.hasAttribute(semanticIdAttr) ? semanticIdAttr : node.hasAttribute(legacySemanticIdAttr) ? legacySemanticIdAttr : 'id';
    if (id) return `[${attr}="${String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) return tag;
    const index = Array.from(parent.children).indexOf(node) + 1;
    return `${tag}:nth-child(${index})`;
  };
  const nodeSummary = (node: Node) => {
    if (!(node instanceof Element)) return { node_type: node.nodeType, text: node.textContent?.slice(0, 160) };
    return {
      id: node.getAttribute(semanticIdAttr) || node.getAttribute(legacySemanticIdAttr) || node.id || undefined,
      selector: selectorFor(node),
      tag: node.tagName.toLowerCase(),
      text: node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) || undefined,
    };
  };
  const serialize = (mutation: MutationRecord) => {
    const target = mutation.target;
    const elementTarget = target instanceof Element ? target : target.parentElement;
    if (elementTarget?.id === 'prism-visual-cursor') return undefined;
    if (mutation.type === 'attributes' && mutation.attributeName && ignoredAttributes.has(mutation.attributeName)) return undefined;
    return {
      type: mutation.type,
      target_id: elementTarget?.getAttribute(semanticIdAttr) || elementTarget?.getAttribute(legacySemanticIdAttr) || elementTarget?.id || undefined,
      target: selectorFor(target),
      attribute_name: mutation.attributeName ?? undefined,
      old_value: mutation.oldValue ?? undefined,
      new_value: mutation.type === 'attributes' && mutation.attributeName && elementTarget
        ? elementTarget.getAttribute(mutation.attributeName) ?? undefined
        : undefined,
      text: mutation.type === 'characterData' ? target.textContent?.slice(0, 300) : undefined,
      added: Array.from(mutation.addedNodes).map(nodeSummary),
      removed: Array.from(mutation.removedNodes).map(nodeSummary),
      timestamp: new Date().toISOString(),
    };
  };

  const state = {
    sessionId,
    pending: [] as any[],
    dropped: 0,
    debounceTimer: 0,
    continuousTimer: 0,
    observer: undefined as MutationObserver | undefined,
  };
  const flush = (continuous = false) => {
    if (!state.pending.length) return;
    const mutations = state.pending.splice(0, 250);
    win.reportMutation?.({
      mutations,
      timestamp: new Date().toISOString(),
      debounce_ms: 500,
      continuous,
      dropped: state.dropped,
    });
    state.dropped = 0;
  };
  state.observer = new MutationObserver((mutations) => {
    const serialized = mutations.map(serialize).filter(Boolean);
    state.pending.push(...serialized);
    if (state.pending.length > 1000) {
      const overflow = state.pending.length - 1000;
      state.pending.splice(0, overflow);
      state.dropped += overflow;
    }
    window.clearTimeout(state.debounceTimer);
    state.debounceTimer = window.setTimeout(() => flush(false), 500);
    if (!state.continuousTimer) {
      state.continuousTimer = window.setTimeout(() => {
        state.continuousTimer = 0;
        flush(true);
      }, 2500);
    }
  });
  state.observer.observe(document, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true,
    attributeOldValue: true,
    characterDataOldValue: true,
  });
  win[key] = state;
}
