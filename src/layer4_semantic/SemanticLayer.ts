import { Page } from 'playwright';
import { randomUUID } from 'crypto';
import { ActionDiscovery } from './action_discovery/ActionDiscovery';
import { ElementClassifier } from './classifier/ElementClassifier';
import { SnapshotDiffer, generateChecksum } from './diff/SnapshotDiffer';
import { ContentExtractor } from './extractor/ContentExtractor';
import { DOMTraverser } from './traverser/DOMTraverser';
import { IncrementalUpdater } from './diff/IncrementalUpdater';
import { StateReconciler } from '../layer3_state_management/StateReconciler';
import { SmartWait } from './stabilization/SmartWait';
import { TokenBudgetManager } from './budget/TokenBudgetManager';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { SemanticElement, SemanticSnapshot, SessionInfo, SnapshotMeta } from '../common/types';
import { globalEventBus } from '../common/EventBus';
import { createDefaultPluginRegistry, PluginRegistry } from '../plugins/PluginRegistry';
import { globalMetrics } from '../common/MetricsRegistry';
import { globalSemCache, semKey } from '../cache/Sem';
import { AuthTracker } from '../auth/Auth';
import { maskSnapshot } from '../privacy/Mask';
import { viewSignature } from '../device/View';

export interface SnapshotBuildOptions {
  previousSnapshot?: SemanticSnapshot;
  session: SessionInfo;
  maxElements?: number;
  snapshotMode?: 'compact' | 'standard' | 'detailed';
  actionableOnly?: boolean;
  affordances?: string[];
  includeTypes?: string[];
  excludeTypes?: string[];
  pageLoadTime?: number;
  actionTime?: number;
  totalTime?: number;
  traceId?: string;
  forceRefresh?: boolean;
}

export interface SemanticLayerDependencies {
  traverser?: DOMTraverser;
  classifier?: ElementClassifier;
  extractor?: ContentExtractor;
  actionDiscovery?: ActionDiscovery;
  differ?: SnapshotDiffer;
  pluginRegistry?: PluginRegistry;
  authTracker?: AuthTracker;
}

export class SemanticLayer {
  private traverser: DOMTraverser;
  private classifier: ElementClassifier;
  private extractor: ContentExtractor;
  private actionDiscovery: ActionDiscovery;
  private differ: SnapshotDiffer;
  private pluginRegistry: PluginRegistry;
  private authTracker: AuthTracker;
  private incrementalUpdater: IncrementalUpdater;
  private reconciler: StateReconciler;
  private smartWait: SmartWait;
  private tokenBudgetManager: TokenBudgetManager;

  constructor(dependencies: SemanticLayerDependencies = {}) {
    const config = ConfigurationManager.getInstance().getConfig();
    this.traverser = dependencies.traverser ?? new DOMTraverser();
    this.classifier = dependencies.classifier ?? new ElementClassifier();
    this.extractor = dependencies.extractor ?? new ContentExtractor();
    this.actionDiscovery = dependencies.actionDiscovery ?? new ActionDiscovery();
    this.differ = dependencies.differ ?? new SnapshotDiffer();
    this.pluginRegistry = dependencies.pluginRegistry ?? createDefaultPluginRegistry(config.plugin_registry);
    this.authTracker = dependencies.authTracker ?? new AuthTracker();
    this.incrementalUpdater = new IncrementalUpdater(this.traverser, this.classifier, this.extractor);
    this.reconciler = new StateReconciler();
    this.smartWait = new SmartWait();
    this.tokenBudgetManager = new TokenBudgetManager();
  }

  async createSnapshot(page: Page, options: SnapshotBuildOptions): Promise<SemanticSnapshot> {
    const extractionStart = performance.now();
    const filteredView = hasSnapshotFilters(options);

    // Concept §3.7.1: True incremental fast-path.
    // If IncrementalUpdater has a snapshot patched via EventBus (form_state_updated,
    // dom_mutated) AND StateReconciler confirms the page hasn't drifted, we can
    // skip stabilization + DOM traversal entirely — 0ms extraction.
    if (!options.forceRefresh && !filteredView) {
      const incremental = this.incrementalUpdater.getSnapshot(options.session.session_id);
      if (incremental) {
        if (!options.previousSnapshot) {
          // Try fast-path: validate with StateReconciler, skip DOM if valid.
          try {
            const reconcileResult = await this.reconciler.reconcile(
              page, options.session.session_id, incremental
            );
            if (reconcileResult.valid) {
              // State is still valid — return the in-memory snapshot directly.
              const fastSnap: SemanticSnapshot = {
                ...incremental,
                snapshot_id: randomUUID(),
                timestamp: new Date().toISOString(),
                session: options.session,
                meta: {
                  ...incremental.meta,
                  extraction_time: Math.round(performance.now() - extractionStart),
                  cache_status: 'incremental' as any,
                  incremental_extraction: true,
                  incremental_cached_nodes: incremental.elements.length,
                },
              };
              fastSnap.checksum = generateChecksum(fastSnap.elements);
              this.incrementalUpdater.registerSession(options.session.session_id, page, fastSnap);
              return fastSnap;
            }
          } catch {
            // Reconciliation failed (page navigated, etc.) — fall through
          }
        }
        // Use incremental as previousSnapshot for FNV-1a optimization
        options = { ...options, previousSnapshot: options.previousSnapshot ?? incremental };
      }
    }

    await this.stabilizePage(page);
    try {
      const snap = await this.createSnapshotOnce(page, options, extractionStart);
      if (!filteredView) this.incrementalUpdater.registerSession(options.session.session_id, page, snap);
      return snap;
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
      await this.stabilizePage(page, true);
      const snap = await this.createSnapshotOnce(page, options, extractionStart);
      if (!filteredView) this.incrementalUpdater.registerSession(options.session.session_id, page, snap);
      return snap;
    }
  }

  private async createSnapshotOnce(
    page: Page,
    options: SnapshotBuildOptions,
    extractionStart: number
  ): Promise<SemanticSnapshot> {
    const config = ConfigurationManager.getInstance().getConfig().semantic;
    const requestedMaxElements = normalizeMaxElements(options.maxElements, config.max_elements_hard_limit);
    const cacheSeed = config.cache_enabled ? await semKey(page) : undefined;
    const cache = cacheSeed
      ? {
          ...cacheSeed,
          key: [
            `session=${options.session.session_id}`,
            cacheSeed.key,
            requestedMaxElements ?? config.max_elements,
            config.adaptive_max_elements ? 'adaptive' : 'fixed',
            config.max_elements_hard_limit,
            viewSignature(options.session.viewport),
            snapshotFilterSignature(options),
          ].join(':'),
        }
      : undefined;
    if (cache) {
      const cached = globalSemCache.get(cache.key, config.cache_ttl_ms);
      if (cached) {
        globalMetrics.increment('llm_browser_semantic_cache_hits_total');
        return this.fromCache(page, cached.snapshot, options, extractionStart, cache.key, cached.age_ms);
      }
      globalMetrics.increment('llm_browser_semantic_cache_misses_total');
    }

    let previousHashes: Record<string, string> | undefined;
    const previousElementsMap = new Map<string, SemanticElement>();
    
    if (options.previousSnapshot) {
      previousHashes = {};
      for (const el of options.previousSnapshot.elements) {
        if (el._hash) previousHashes[el.id] = el._hash;
        previousElementsMap.set(el.id, el);
      }
    }

    const traversal = await this.traverser.traverse(page, { 
      maxElements: requestedMaxElements,
      previousHashes 
    });

    const allElements = traversal.nodes.map((node): SemanticElement => {
      if (node.type === 'cached' && previousElementsMap.has(node.id)) {
        return previousElementsMap.get(node.id)!;
      }

      const classification = this.classifier.classifyDetailed(node);
      const type = classification.type;
      const content = this.extractor.extract(node, type);
      return {
        id: node.id,
        _hash: node._hash,
        type,
        role: node.role,
        classification,
        ...content,
      };
    });

    const incomplete = traversal.stats.semantic_nodes_total > traversal.stats.semantic_nodes_count;
    let elements = allElements;
    let availableActions = this.actionDiscovery.discover(elements);
    const timestamp = new Date().toISOString();
    const rawTitle = await page.title().catch(() => '');
    const title = rawTitle || inferTitle(elements, page.url());

    const pluginResult = await this.pluginRegistry.applyPageLoad({
      page,
      url: page.url(),
      title,
      session: options.session,
      elements,
      available_actions: availableActions,
    });
    elements = pluginResult.elements;
    availableActions = pluginResult.available_actions;

    const filterResult = applySnapshotFilter(elements, availableActions, options);
    elements = filterResult.elements;
    availableActions = filterResult.availableActions;

    // Apply Token Budget (Concept 2.7)
    const budgetConfig = ConfigurationManager.getInstance().getConfig().semantic.token_budget;
    const budgetResult = this.tokenBudgetManager.applyBudget(elements, {
      max_tokens: budgetConfig?.max_tokens,
    });
    elements = budgetResult.elements;
    availableActions = filterActionsToElements(availableActions, elements);

    const snapshot: SemanticSnapshot = {
      snapshot_id: randomUUID(),
      version: '2.2.0',
      url: page.url(),
      title,
      timestamp,
      elements,
      available_actions: availableActions,
      session: options.session,
      forms: collectForms(elements),
      alerts: collectAlerts(elements),
      navigation: collectNavigation(elements, traversal.stats.below_fold_count),
    };
    snapshot.auth = await this.authTracker.inspect(page, snapshot);
    recordAuthMetrics(snapshot.auth.authenticated);
    const privacy = maskSnapshot(snapshot);

    const extractionTime = Math.round(performance.now() - extractionStart);
    const meta: SnapshotMeta = {
      page_load_time: options.pageLoadTime,
      action_time: options.actionTime,
      total_time: options.totalTime,
      extraction_time: extractionTime,
      dom_nodes_count: traversal.stats.dom_nodes_count,
      semantic_nodes_count: snapshot.elements.length,
      semantic_nodes_total: traversal.stats.semantic_nodes_total,
      max_elements: traversal.stats.max_elements,
      max_elements_requested: traversal.stats.max_elements_requested,
      raw_dom_bytes: traversal.stats.raw_dom_bytes,
      cache_status: cache ? 'miss' : 'disabled',
      cache_key: cache?.key,
      cache_entries: globalSemCache.stats().entries,
      incremental_extraction: Boolean(previousHashes),
      incremental_cached_nodes: traversal.nodes.filter(n => n.type === 'cached').length,
      incomplete,
      trace_id: options.traceId,
      viewport: options.session.viewport,
      scroll: traversal.stats.scroll,
      encapsulation: {
        iframe_count: traversal.stats.iframe_count,
        iframe_in_output_count: traversal.stats.iframe_in_output_count,
        iframe_extracted_count: traversal.stats.iframe_extracted_count,
        iframe_skipped_ads: traversal.stats.iframe_skipped_ads,
        iframe_depth_limited: traversal.stats.iframe_depth_limited,
        shadow_root_count: traversal.stats.shadow_root_count,
        closed_shadow_roots: traversal.stats.closed_shadow_roots,
        max_frame_depth: traversal.stats.max_frame_depth,
      },
      plugin_contributions: {
        ...pluginResult.stats,
        plugins: pluginResult.metadata,
      },
      budget: {
        estimated_tokens: budgetResult.estimated_tokens,
        budget_used_pct: budgetResult.budget_used_pct,
        pruned_elements: budgetResult.pruned_count,
        pruning_applied: budgetResult.pruning_applied,
      },
      privacy,
      filter: filterResult.meta,
    };

    snapshot.meta = dropUndefined(meta);
    snapshot.meta.token_estimate = this.tokenBudgetManager.estimateSnapshotTokens(snapshot);
    if (traversal.stats.closed_shadow_roots > 0) {
      void globalEventBus.publish('stream_event', {
        type: 'security',
        session_id: options.session.session_id,
        tab_id: options.session.tab_id,
        timestamp: new Date().toISOString(),
        data: {
          event: 'closed_shadow_dom_access',
          closed_shadow_roots: traversal.stats.closed_shadow_roots,
        },
      });
    }
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    snapshot.meta.snapshot_bytes = snapshotBytes;
    snapshot.meta.compression_ratio =
      traversal.stats.raw_dom_bytes > 0 ? Number((snapshotBytes / traversal.stats.raw_dom_bytes).toFixed(4)) : undefined;

    snapshot.checksum = generateChecksum(snapshot.elements);
    snapshot.delta = this.differ.diff(options.previousSnapshot, snapshot);

    // Concept §6.4: 40% threshold fallback + compact mode protection
    // If maxElements was drastically reduced (e.g., compact(20) after full(500+)),
    // delta would contain ~188K operations which inflates tokens.
    // Skip delta when previous snapshot is significantly larger than current.
    if (snapshot.delta) {
      const currentElements = snapshot.elements.length;
      const prevElements = options.previousSnapshot?.elements.length ?? 0;
      const requestedMax = options.maxElements ?? 500;

      // Skip delta if: 1) 40% threshold exceeded, OR
      // 2) Previous was >2x the requested maxElements (compact mode scenario)
      const totalElements = Math.max(prevElements, currentElements);
      const changed = snapshot.delta.stats.added + snapshot.delta.stats.removed + snapshot.delta.stats.updated;
      // Skip delta if: 1) 40% threshold exceeded, OR
      // 2) Previous had >2x current elements (e.g., compact after full)
      // Note: Compare prev/current actual counts, not prev vs maxElements (hard_limit scenario)
      const shouldSkipDelta = (totalElements > 0 && changed / totalElements > 0.4) ||
                              (prevElements > 0 && currentElements > 0 && prevElements > currentElements * 2);

      if (shouldSkipDelta) {
        delete snapshot.delta;
      }
    }

    if (cache) {
      globalSemCache.set(cache.key, snapshot, config.cache_max_entries);
      globalMetrics.increment('llm_browser_semantic_cache_writes_total');
    }

    return snapshot;
  }

  private async fromCache(
    page: Page,
    cached: SemanticSnapshot,
    options: SnapshotBuildOptions,
    extractionStart: number,
    cacheKey: string,
    cacheAgeMs: number
  ): Promise<SemanticSnapshot> {
    const snapshot: SemanticSnapshot = clone(cached);
    snapshot.snapshot_id = randomUUID();
    snapshot.timestamp = new Date().toISOString();
    snapshot.session = options.session;
    snapshot.auth = await this.authTracker.inspect(page, snapshot);
    recordAuthMetrics(snapshot.auth.authenticated);
    const privacy = maskSnapshot(snapshot);
    const cachePrivacy = privacy.masked > 0 ? privacy : snapshot.meta?.privacy;
    const meta: SnapshotMeta = dropUndefined({
      ...(snapshot.meta ?? {}),
      page_load_time: options.pageLoadTime,
      action_time: options.actionTime,
      total_time: options.totalTime,
      extraction_time: Math.round(performance.now() - extractionStart),
      trace_id: options.traceId,
      viewport: options.session.viewport,
      cache_status: 'hit' as const,
      cache_key: cacheKey,
      cache_age_ms: cacheAgeMs,
      cache_entries: globalSemCache.stats().entries,
      privacy: cachePrivacy,
    });
    snapshot.meta = meta;
    delete snapshot.delta;
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    meta.snapshot_bytes = snapshotBytes;
    meta.token_estimate = this.tokenBudgetManager.estimateSnapshotTokens(snapshot);
    snapshot.checksum = generateChecksum(snapshot.elements);
    snapshot.delta = this.differ.diff(options.previousSnapshot, snapshot);
    if (snapshot.delta) {
      const currentElements = snapshot.elements.length;
      const prevElements = options.previousSnapshot?.elements.length ?? 0;
      const requestedMax = options.maxElements ?? 500;

      const totalElements = Math.max(prevElements, currentElements);
      const changed = snapshot.delta.stats.added + snapshot.delta.stats.removed + snapshot.delta.stats.updated;
      // Skip delta if: 1) 40% threshold exceeded, OR
      // 2) Previous had >2x current elements (e.g., compact after full)
      // Note: Compare prev/current actual counts, not prev vs maxElements (hard_limit scenario)
      const shouldSkipDelta = (totalElements > 0 && changed / totalElements > 0.4) ||
                              (prevElements > 0 && currentElements > 0 && prevElements > currentElements * 2);

      if (shouldSkipDelta) {
        delete snapshot.delta;
      }
    }
    return snapshot;
  }

  private async stabilizePage(page: Page, retry = false): Promise<void> {
    const sessionId = undefined; // Will be passed when integrated with session tracking
    await this.smartWait.waitForStability(page, {
      retry,
      sessionId,
      hardTimeoutMs: retry ? 3000 : 5000,
      mutationQuietMs: 300,
    });
  }
}

function hasSnapshotFilters(options: SnapshotBuildOptions): boolean {
  return Boolean(
    options.actionableOnly ||
    options.affordances?.length ||
    options.includeTypes?.length ||
    options.excludeTypes?.length
  );
}

function snapshotFilterSignature(options: SnapshotBuildOptions): string {
  if (!hasSnapshotFilters(options)) return 'all';
  return JSON.stringify({
    actionableOnly: Boolean(options.actionableOnly),
    affordances: normalizeList(options.affordances),
    includeTypes: normalizeList(options.includeTypes),
    excludeTypes: normalizeList(options.excludeTypes),
  });
}

function applySnapshotFilter(
  elements: SemanticElement[],
  availableActions: SemanticSnapshot['available_actions'],
  options: SnapshotBuildOptions
): {
  elements: SemanticElement[];
  availableActions: SemanticSnapshot['available_actions'];
  meta?: SnapshotMeta['filter'];
} {
  if (!hasSnapshotFilters(options)) {
    return { elements, availableActions };
  }

  const includeTypes = new Set(normalizeList(options.includeTypes));
  const excludeTypes = new Set(normalizeList(options.excludeTypes));
  const affordances = new Set(normalizeList(options.affordances));
  const actionableTargets = new Set(
    availableActions
      .filter((action) => action.action !== 'scroll_to_element')
      .map((action) => action.target)
      .filter(Boolean) as string[]
  );
  const parentIds = new Set<string>();
  const keepIds = new Set<string>();

  const keep = (element: SemanticElement): boolean => {
    const type = String(element.type);
    if (excludeTypes.has(type)) return false;
    if (includeTypes.size > 0 && includeTypes.has(type)) return true;
    if (options.actionableOnly && isActionableSnapshotElement(element, actionableTargets)) return true;
    if (affordances.size > 0 && matchesAffordance(element, availableActions, affordances)) return true;
    if (!options.actionableOnly && includeTypes.size === 0 && affordances.size === 0) return true;
    return false;
  };

  for (const element of elements) {
    if (!keep(element)) continue;
    keepIds.add(element.id);
    if (element.parent_id) parentIds.add(element.parent_id);
  }

  // Preserve a thin amount of semantic context around actionable controls.
  for (const element of elements) {
    if (parentIds.has(element.id) && ['form', 'card', 'article', 'navigation', 'modal', 'dialog', 'menu'].includes(element.type)) {
      keepIds.add(element.id);
    }
    if (options.actionableOnly && isCompactContext(element)) {
      keepIds.add(element.id);
    }
  }

  const filteredElements = elements.filter((element) => keepIds.has(element.id));
  const filteredActions = filterActionsToElements(availableActions, filteredElements);
  return {
    elements: filteredElements,
    availableActions: filteredActions,
    meta: {
      actionable_only: options.actionableOnly || undefined,
      affordances: normalizeList(options.affordances),
      include_types: normalizeList(options.includeTypes),
      exclude_types: normalizeList(options.excludeTypes),
      before_elements: elements.length,
      after_elements: filteredElements.length,
      before_actions: availableActions.length,
      after_actions: filteredActions.length,
      dropped_elements: Math.max(0, elements.length - filteredElements.length),
    },
  };
}

function filterActionsToElements(
  actions: SemanticSnapshot['available_actions'],
  elements: SemanticElement[]
): SemanticSnapshot['available_actions'] {
  const elementIds = new Set(elements.map((element) => element.id));
  return actions.filter((action) => !action.target || elementIds.has(action.target));
}

function isActionableSnapshotElement(element: SemanticElement, actionableTargets: Set<string>): boolean {
  if (actionableTargets.has(element.id)) return true;
  if ([
    'button', 'link', 'input', 'textarea', 'select', 'form', 'menu', 'menu_item',
    'pagination', 'tab_group', 'accordion', 'carousel', 'iframe', 'embed', 'video', 'audio',
  ].includes(element.type)) return true;
  if (['heading', 'card', 'article', 'table', 'list', 'chart', 'notification', 'modal', 'dialog', 'breadcrumb'].includes(element.type)) {
    return hasUsefulText(element);
  }
  return false;
}

function matchesAffordance(
  element: SemanticElement,
  actions: SemanticSnapshot['available_actions'],
  affordances: Set<string>
): boolean {
  const elementActions = actions.filter((action) => action.target === element.id).map((action) => action.action);
  const hasAction = (...names: string[]) => names.some((name) => elementActions.includes(name));
  if ((affordances.has('click') || affordances.has('clickable')) && (hasAction('click', 'interact') || ['button', 'menu_item', 'accordion', 'carousel', 'tab_group'].includes(element.type))) return true;
  if ((affordances.has('navigate') || affordances.has('navigable')) && (hasAction('navigate') || ['link', 'breadcrumb', 'pagination', 'navigation'].includes(element.type))) return true;
  if ((affordances.has('type') || affordances.has('fillable') || affordances.has('input')) && (hasAction('type', 'fill_form') || ['input', 'textarea', 'form'].includes(element.type))) return true;
  if ((affordances.has('select') || affordances.has('selectable')) && (hasAction('select') || element.type === 'select' || ['checkbox', 'radio'].includes(String(element.input_type)))) return true;
  if ((affordances.has('submit') || affordances.has('submittable')) && (hasAction('submit', 'fill_form') || element.type === 'form')) return true;
  if (affordances.has('media') && (hasAction('media_control', 'interact') || ['video', 'audio', 'embed', 'iframe'].includes(element.type))) return true;
  if ((affordances.has('read') || affordances.has('readable') || affordances.has('text')) && ['heading', 'text', 'article', 'card', 'table', 'list', 'chart'].includes(element.type)) return true;
  if (affordances.has('visible') && element.visible !== false) return true;
  return false;
}

function isCompactContext(element: SemanticElement): boolean {
  if (!hasUsefulText(element)) return false;
  if (['heading', 'card', 'article', 'breadcrumb', 'pagination', 'notification', 'modal', 'dialog', 'chart'].includes(element.type)) return true;
  const text = String(element.text ?? element.label ?? element.title ?? '').trim();
  return /\$|€|£|¥|uah|usd|price|total|title|product|result|error|warning/i.test(text) && text.length <= 180;
}

function hasUsefulText(element: SemanticElement): boolean {
  return Boolean(String(element.text ?? element.label ?? element.title ?? element.data_summary ?? '').trim());
}

function normalizeList(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
}

function collectForms(elements: SemanticElement[]): any[] | undefined {
  const forms = elements
    .filter((element) => element.type === 'form')
    .map((form) => ({
      form_id: form.id,
      action: form.action,
      method: form.method,
      fields: form.fields ?? [],
      field_values: form.field_values,
      errors: form.errors ?? [],
      is_dirty: form.is_dirty,
      is_valid: form.is_valid,
      completion_percentage: form.completion_percentage,
      submit_button_id: form.submit_button_id,
      validation_errors: form.validation_errors ?? [],
      enctype: form.enctype,
      autocomplete: form.autocomplete,
    }));

  return forms.length > 0 ? forms : undefined;
}

function collectAlerts(elements: SemanticElement[]): any[] | undefined {
  const alerts = elements
    .filter((element) => element.type === 'notification' || element.type === 'modal')
    .map((element) => ({
      element_id: element.id,
      type: element.type,
      label: element.label,
      text: element.text,
    }));

  return alerts.length > 0 ? alerts : undefined;
}

function collectNavigation(elements: SemanticElement[], belowFoldCount: number): any {
  const links = elements.filter((element) => element.type === 'link');
  const headings = elements.filter((element) => element.type === 'heading');
  const breadcrumbs = elements.find((element) => element.type === 'breadcrumb');
  const pagination = elements.find((element) => element.type === 'pagination');
  const navigationHeadings = headings.length > 0 ? headings : inferHeadings(elements);

  return {
    links_count: links.length,
    breadcrumbs: breadcrumbs?.items,
    pagination: pagination
      ? {
          current_page: pagination.current_page ?? pagination.current,
          total_pages: pagination.total_pages ?? pagination.total,
          has_next: pagination.has_next,
          has_prev: pagination.has_prev,
        }
      : undefined,
    headings: navigationHeadings.slice(0, 12).map((heading) => ({
      id: heading.id,
      level: heading.level,
      text: heading.text ?? heading.label,
      inferred: heading.type !== 'heading' || undefined,
    })),
    viewport_hint:
      belowFoldCount > 0
        ? {
            below_fold_count: belowFoldCount,
            action: 'scroll',
          }
        : undefined,
  };
}

function inferHeadings(elements: SemanticElement[]): SemanticElement[] {
  const blocked = new Set(['home', 'new', 'past', 'comments', 'ask', 'show', 'jobs', 'submit', 'login', 'sign in']);
  return elements.filter((element) => {
    if (!['link', 'text', 'article'].includes(element.type)) return false;
    const text = String(element.text ?? element.label ?? '').trim();
    if (text.length < 12 || text.length > 140) return false;
    if (blocked.has(text.toLowerCase())) return false;
    return /[A-Za-z\u0400-\u04FF]/.test(text);
  });
}

function inferTitle(elements: SemanticElement[], url: string): string {
  const heading = elements.find((element) => element.type === 'heading' && (element.text || element.label));
  const text = heading?.text ?? heading?.label;
  if (text) return String(text).slice(0, 120);
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function dropUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function recordAuthMetrics(authenticated: boolean): void {
  globalMetrics.increment(authenticated ? 'llm_browser_auth_authenticated_total' : 'llm_browser_auth_anonymous_total');
}

function normalizeMaxElements(value: number | undefined, hardLimit: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(1, Math.round(parsed)), Math.max(1, hardLimit));
}

function isNavigationContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Cannot find context|Frame was detached|Target closed|navigation/i.test(message);
}
