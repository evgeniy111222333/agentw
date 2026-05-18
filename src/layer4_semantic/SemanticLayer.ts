import { Page } from 'playwright';
import { randomUUID } from 'crypto';
import { ActionDiscovery } from './action_discovery/ActionDiscovery';
import { ElementClassifier } from './classifier/ElementClassifier';
import { SnapshotDiffer } from './diff/SnapshotDiffer';
import { ContentExtractor } from './extractor/ContentExtractor';
import { DOMTraverser } from './traverser/DOMTraverser';
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
  pageLoadTime?: number;
  actionTime?: number;
  totalTime?: number;
  traceId?: string;
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

  constructor(dependencies: SemanticLayerDependencies = {}) {
    const config = ConfigurationManager.getInstance().getConfig();
    this.traverser = dependencies.traverser ?? new DOMTraverser();
    this.classifier = dependencies.classifier ?? new ElementClassifier();
    this.extractor = dependencies.extractor ?? new ContentExtractor();
    this.actionDiscovery = dependencies.actionDiscovery ?? new ActionDiscovery();
    this.differ = dependencies.differ ?? new SnapshotDiffer();
    this.pluginRegistry = dependencies.pluginRegistry ?? createDefaultPluginRegistry(config.plugin_registry);
    this.authTracker = dependencies.authTracker ?? new AuthTracker();
  }

  async createSnapshot(page: Page, options: SnapshotBuildOptions): Promise<SemanticSnapshot> {
    const extractionStart = performance.now();
    await this.stabilizePage(page);
    try {
      return await this.createSnapshotOnce(page, options, extractionStart);
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
      await this.stabilizePage(page, true);
      return this.createSnapshotOnce(page, options, extractionStart);
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
            cacheSeed.key,
            requestedMaxElements ?? config.max_elements,
            config.adaptive_max_elements ? 'adaptive' : 'fixed',
            config.max_elements_hard_limit,
            viewSignature(options.session.viewport),
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

    const traversal = await this.traverser.traverse(page, { maxElements: requestedMaxElements });

    const allElements = traversal.nodes.map((node): SemanticElement => {
      const type = this.classifier.classify(node);
      const content = this.extractor.extract(node, type);
      return {
        id: node.id,
        type,
        role: node.role,
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
      semantic_nodes_count: elements.length,
      semantic_nodes_total: traversal.stats.semantic_nodes_total,
      max_elements: traversal.stats.max_elements,
      max_elements_requested: traversal.stats.max_elements_requested,
      raw_dom_bytes: traversal.stats.raw_dom_bytes,
      cache_status: cache ? 'miss' : 'disabled',
      cache_key: cache?.key,
      cache_entries: globalSemCache.stats().entries,
      incomplete,
      trace_id: options.traceId,
      viewport: options.session.viewport,
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
      privacy,
    };

    snapshot.meta = dropUndefined(meta);
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
    snapshot.meta.token_estimate = Math.ceil(snapshotBytes / 4);
    snapshot.meta.compression_ratio =
      traversal.stats.raw_dom_bytes > 0 ? Number((snapshotBytes / traversal.stats.raw_dom_bytes).toFixed(4)) : undefined;

    snapshot.delta = this.differ.diff(options.previousSnapshot, snapshot);
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
    meta.token_estimate = Math.ceil(snapshotBytes / 4);
    snapshot.delta = this.differ.diff(options.previousSnapshot, snapshot);
    return snapshot;
  }

  private async stabilizePage(page: Page, retry = false): Promise<void> {
    const config = ConfigurationManager.getInstance().getConfig().semantic;
    await page.waitForLoadState('domcontentloaded', { timeout: retry ? 3000 : 1000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: retry ? 3000 : 1000 }).catch(() => undefined);
    await page.waitForTimeout(config.stabilization_ms);
  }
}

function collectForms(elements: SemanticElement[]): any[] | undefined {
  const forms = elements
    .filter((element) => element.type === 'form')
    .map((form) => ({
      form_id: form.id,
      action: form.action,
      method: form.method,
      fields: form.fields ?? [],
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
  const navigationHeadings = headings.length > 0 ? headings : inferHeadings(elements);

  return {
    links_count: links.length,
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
