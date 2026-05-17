import { Page } from 'playwright';
import { randomUUID } from 'crypto';
import { ActionDiscovery } from './action_discovery/ActionDiscovery';
import { ElementClassifier } from './classifier/ElementClassifier';
import { SnapshotDiffer } from './diff/SnapshotDiffer';
import { ContentExtractor } from './extractor/ContentExtractor';
import { DOMTraverser } from './traverser/DOMTraverser';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { SemanticElement, SemanticSnapshot, SessionInfo, SnapshotMeta } from '../common/types';
import { createDefaultPluginRegistry, PluginRegistry } from '../plugins/PluginRegistry';
import { globalMetrics } from '../common/MetricsRegistry';
import { globalSemCache, semKey } from '../cache/Sem';
import { AuthTracker } from '../auth/Auth';

export interface SnapshotBuildOptions {
  previousSnapshot?: SemanticSnapshot;
  session: SessionInfo;
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
    const config = ConfigurationManager.getInstance().getConfig().semantic;
    const cache = config.cache_enabled ? await semKey(page) : undefined;
    if (cache) {
      const cached = globalSemCache.get(cache.key, config.cache_ttl_ms);
      if (cached) {
        globalMetrics.increment('llm_browser_semantic_cache_hits_total');
        return this.fromCache(page, cached.snapshot, options, extractionStart, cache.key, cached.age_ms);
      }
      globalMetrics.increment('llm_browser_semantic_cache_misses_total');
    }

    const traversal = await this.traverser.traverse(page);

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

    const incomplete =
      traversal.stats.semantic_nodes_count >= config.max_elements &&
      traversal.stats.dom_nodes_count > traversal.stats.semantic_nodes_count;
    let elements = incomplete ? allElements.slice(0, config.max_elements) : allElements;
    let availableActions = this.actionDiscovery.discover(elements);
    const timestamp = new Date().toISOString();
    const title = await page.title();

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

    const extractionTime = Math.round(performance.now() - extractionStart);
    const meta: SnapshotMeta = {
      page_load_time: options.pageLoadTime,
      action_time: options.actionTime,
      total_time: options.totalTime,
      extraction_time: extractionTime,
      dom_nodes_count: traversal.stats.dom_nodes_count,
      semantic_nodes_count: elements.length,
      raw_dom_bytes: traversal.stats.raw_dom_bytes,
      cache_status: cache ? 'miss' : 'disabled',
      cache_key: cache?.key,
      cache_entries: globalSemCache.stats().entries,
      incomplete,
      trace_id: options.traceId,
      plugin_contributions: {
        ...pluginResult.stats,
        plugins: pluginResult.metadata,
      },
    };

    snapshot.meta = dropUndefined(meta);
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
    const meta: SnapshotMeta = dropUndefined({
      ...(snapshot.meta ?? {}),
      page_load_time: options.pageLoadTime,
      action_time: options.actionTime,
      total_time: options.totalTime,
      extraction_time: Math.round(performance.now() - extractionStart),
      trace_id: options.traceId,
      cache_status: 'hit' as const,
      cache_key: cacheKey,
      cache_age_ms: cacheAgeMs,
      cache_entries: globalSemCache.stats().entries,
    });
    snapshot.meta = meta;
    delete snapshot.delta;
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    meta.snapshot_bytes = snapshotBytes;
    meta.token_estimate = Math.ceil(snapshotBytes / 4);
    snapshot.delta = this.differ.diff(options.previousSnapshot, snapshot);
    return snapshot;
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

  return {
    links_count: links.length,
    headings: headings.slice(0, 12).map((heading) => ({
      id: heading.id,
      level: heading.level,
      text: heading.text ?? heading.label,
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
