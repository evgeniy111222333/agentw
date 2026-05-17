import type { Page } from 'playwright';
import type { AvailableAction, SemanticElement, SessionInfo } from '../common/types';
import type { PluginRegistryConfig } from '../config/ConfigurationManager';
import { SemanticActionMarkupPlugin } from './sam/SemanticActionMarkupPlugin';

export interface PluginMetadata {
  name: string;
  version: string;
  priority?: number;
  kind?: string;
  description?: string;
  capabilities?: string[];
}

export interface RegisteredPluginAction {
  name: string;
  schema?: Record<string, any>;
  description?: string;
  risk?: 'low' | 'medium' | 'high';
}

export interface RegisteredPluginExtractor {
  type: string;
  selector: string;
  description?: string;
}

export interface PluginPageContext {
  page: Page;
  url: string;
  title: string;
  session: SessionInfo;
  elements: SemanticElement[];
  available_actions: AvailableAction[];
}

export interface PluginPageContribution {
  elements?: SemanticElement[];
  actions?: AvailableAction[];
  metadata?: Record<string, any>;
  warnings?: string[];
}

export interface PluginActionContext {
  session_id: string;
  action: string;
  target_id?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
}

export interface SemanticPlugin {
  metadata: PluginMetadata;
  init?(config: Record<string, any>): void;
  registerActions?(): RegisteredPluginAction[];
  registerExtractors?(): RegisteredPluginExtractor[];
  onPageLoad?(context: PluginPageContext): Promise<PluginPageContribution | void> | PluginPageContribution | void;
  onAction?(context: PluginActionContext): Promise<Record<string, any> | void> | Record<string, any> | void;
  destroy?(): void | Promise<void>;
}

export interface PluginRuntimeInfo extends PluginMetadata {
  priority: number;
  status: 'enabled' | 'disabled';
  actions: RegisteredPluginAction[];
  extractors: RegisteredPluginExtractor[];
  warnings: string[];
  failures: number;
  disabled_reason?: string;
  last_error?: string;
}

interface PluginState {
  plugin: SemanticPlugin;
  metadata: PluginMetadata;
  status: 'enabled' | 'disabled';
  disabledByInit: boolean;
  disabled_reason?: string;
  warnings: string[];
  initWarnings: string[];
  failures: number;
  last_error?: string;
  actions: RegisteredPluginAction[];
  extractors: RegisteredPluginExtractor[];
}

export class PluginRegistry {
  private states = new Map<string, PluginState>();

  register(plugin: SemanticPlugin, config: Record<string, any> = {}): void {
    const name = plugin.metadata.name;
    if (!name) throw new Error('Plugin metadata.name is required');
    if (this.states.has(name)) throw new Error(`Plugin already registered: ${name}`);

    const state: PluginState = {
      plugin,
      metadata: plugin.metadata,
      status: 'enabled',
      disabledByInit: false,
      warnings: [],
      initWarnings: [],
      failures: 0,
      actions: [],
      extractors: [],
    };

    try {
      plugin.init?.(config);
    } catch (error: any) {
      state.status = 'disabled';
      state.disabledByInit = true;
      state.disabled_reason = `init failed: ${error.message}`;
      state.last_error = error.message;
      state.initWarnings.push(state.disabled_reason);
    }

    this.states.set(name, state);
    this.rebuildRegistrations();
  }

  listPlugins(): PluginRuntimeInfo[] {
    return this.sortedStates().map((state) => ({
      ...state.metadata,
      priority: priorityOf(state),
      status: state.status,
      actions: [...state.actions],
      extractors: [...state.extractors],
      warnings: [...state.warnings],
      failures: state.failures,
      disabled_reason: state.disabled_reason,
      last_error: state.last_error,
    }));
  }

  async applyPageLoad(context: PluginPageContext): Promise<{
    elements: SemanticElement[];
    available_actions: AvailableAction[];
    metadata: Record<string, any>;
    stats: { actions: number; elements: number; warnings: number };
    warnings: string[];
  }> {
    let elements = dedupeElements(context.elements);
    let availableActions = dedupeActions(context.available_actions);
    const metadata: Record<string, any> = {};
    const warnings: string[] = [];
    let contributedActions = 0;
    let contributedElements = 0;

    for (const state of this.sortedStates()) {
      if (state.status !== 'enabled' || !state.plugin.onPageLoad) continue;

      try {
        const contribution = await state.plugin.onPageLoad({
          ...context,
          elements,
          available_actions: availableActions,
        });
        if (!contribution) continue;

        const nextElements = contribution.elements ?? [];
        const nextActions = contribution.actions ?? [];
        elements = dedupeElements([...elements, ...nextElements]);
        availableActions = dedupeActions([...availableActions, ...nextActions]);
        contributedElements += nextElements.length;
        contributedActions += nextActions.length;

        if (contribution.metadata) metadata[state.metadata.name] = contribution.metadata;
        for (const warning of contribution.warnings ?? []) {
          warnings.push(`${state.metadata.name}: ${warning}`);
        }
      } catch (error: any) {
        state.failures += 1;
        state.last_error = error.message;
        const warning = `${state.metadata.name}: on_page_load failed: ${error.message}`;
        state.warnings.push(warning);
        warnings.push(warning);
      }
    }

    return {
      elements,
      available_actions: availableActions,
      metadata,
      warnings,
      stats: {
        actions: contributedActions,
        elements: contributedElements,
        warnings: warnings.length,
      },
    };
  }

  async destroy(): Promise<void> {
    for (const state of this.sortedStates().reverse()) {
      await state.plugin.destroy?.();
    }
    this.states.clear();
  }

  private rebuildRegistrations(): void {
    const claimedActions = new Map<string, string>();
    const claimedExtractors = new Map<string, string>();

    for (const state of this.sortedStates()) {
      state.actions = [];
      state.extractors = [];
      state.warnings = [...state.initWarnings];

      if (state.disabledByInit) {
        state.status = 'disabled';
        continue;
      }

      const actions = state.plugin.registerActions?.() ?? [];
      const extractors = state.plugin.registerExtractors?.() ?? [];
      const conflict =
        actions.find((action) => claimedActions.has(action.name)) ??
        extractors.find((extractor) => claimedExtractors.has(extractor.type));

      if (conflict) {
        state.status = 'disabled';
        const conflictKey = 'name' in conflict ? conflict.name : conflict.type;
        const owner = claimedActions.get(conflictKey) ?? claimedExtractors.get(conflictKey);
        state.disabled_reason = `conflict on ${conflictKey} with higher-priority plugin ${owner}`;
        state.warnings.push(state.disabled_reason);
        continue;
      }

      state.status = 'enabled';
      state.disabled_reason = undefined;
      state.actions = actions;
      state.extractors = extractors;

      for (const action of actions) claimedActions.set(action.name, state.metadata.name);
      for (const extractor of extractors) claimedExtractors.set(extractor.type, state.metadata.name);
    }
  }

  private sortedStates(): PluginState[] {
    return [...this.states.values()].sort((left, right) => {
      const byPriority = priorityOf(right) - priorityOf(left);
      return byPriority || left.metadata.name.localeCompare(right.metadata.name);
    });
  }
}

export function createDefaultPluginRegistry(config?: Partial<PluginRegistryConfig>): PluginRegistry {
  const registry = new PluginRegistry();
  if (config?.enabled === false) return registry;
  if (config?.sam_enabled !== false) {
    registry.register(new SemanticActionMarkupPlugin());
  }
  return registry;
}

function priorityOf(state: PluginState): number {
  return state.metadata.priority ?? 0;
}

function dedupeElements(elements: SemanticElement[]): SemanticElement[] {
  const seen = new Set<string>();
  const result: SemanticElement[] = [];

  for (const element of elements) {
    if (seen.has(element.id)) continue;
    seen.add(element.id);
    result.push(element);
  }

  return result;
}

function dedupeActions(actions: AvailableAction[]): AvailableAction[] {
  const seen = new Set<string>();
  const result: AvailableAction[] = [];

  for (const action of actions) {
    const key = action.action_id ?? `${action.action}:${action.target ?? ''}:${action.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }

  return result;
}
