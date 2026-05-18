import { createHash } from 'crypto';
import { Frame, Page } from 'playwright';
import { SemanticSnapshot } from '../common/types';

export interface SemCacheEntry {
  key: string;
  url: string;
  title: string;
  created_at: string;
  last_hit_at?: string;
  hits: number;
  bytes: number;
}

export interface SemCacheStats {
  entries: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  stale: number;
  bytes: number;
}

interface StoredEntry extends SemCacheEntry {
  createdMs: number;
  snapshot: SemanticSnapshot;
}

export class SemCache {
  private entries = new Map<string, StoredEntry>();
  private order: string[] = [];
  private counters = {
    hits: 0,
    misses: 0,
    writes: 0,
    evictions: 0,
    stale: 0,
  };

  get(key: string, ttlMs: number): { snapshot: SemanticSnapshot; age_ms: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.counters.misses += 1;
      return undefined;
    }

    const ageMs = Date.now() - entry.createdMs;
    if (ageMs > ttlMs) {
      this.entries.delete(key);
      this.order = this.order.filter((candidate) => candidate !== key);
      this.counters.stale += 1;
      this.counters.misses += 1;
      return undefined;
    }

    entry.hits += 1;
    entry.last_hit_at = new Date().toISOString();
    this.touch(key);
    this.counters.hits += 1;
    return {
      snapshot: clone(entry.snapshot),
      age_ms: ageMs,
    };
  }

  set(key: string, snapshot: SemanticSnapshot, maxEntries: number): void {
    const storedSnapshot = clone(snapshot);
    delete storedSnapshot.delta;
    delete storedSnapshot.auth;
    const bytes = Buffer.byteLength(JSON.stringify(storedSnapshot), 'utf8');
    const existing = this.entries.get(key);
    const entry: StoredEntry = {
      key,
      url: storedSnapshot.url,
      title: storedSnapshot.title,
      created_at: existing?.created_at ?? new Date().toISOString(),
      createdMs: existing?.createdMs ?? Date.now(),
      last_hit_at: existing?.last_hit_at,
      hits: existing?.hits ?? 0,
      bytes,
      snapshot: storedSnapshot,
    };

    this.entries.set(key, entry);
    this.touch(key);
    this.counters.writes += 1;
    this.trim(maxEntries);
  }

  clear(): void {
    this.entries.clear();
    this.order = [];
  }

  list(): SemCacheEntry[] {
    return this.order
      .map((key) => this.entries.get(key))
      .filter((entry): entry is StoredEntry => Boolean(entry))
      .map(({ snapshot: _snapshot, createdMs: _createdMs, ...entry }) => ({ ...entry }));
  }

  stats(): SemCacheStats {
    const bytes = Array.from(this.entries.values()).reduce((total, entry) => total + entry.bytes, 0);
    return {
      entries: this.entries.size,
      bytes,
      ...this.counters,
    };
  }

  private touch(key: string): void {
    this.order = this.order.filter((candidate) => candidate !== key);
    this.order.push(key);
  }

  private trim(maxEntries: number): void {
    while (this.order.length > maxEntries) {
      const removed = this.order.shift();
      if (!removed) break;
      this.entries.delete(removed);
      this.counters.evictions += 1;
    }
  }
}

export const globalSemCache = new SemCache();

export async function semKey(page: Page): Promise<{ key: string; url: string; title: string }> {
  const main = await page.evaluate(cacheDomState);
  const frames = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    const depth = frameDepth(frame);
    const same_origin = isSameOrigin(page.url(), url);
    if (same_origin && depth <= 3) {
      frames.push({
        url,
        depth,
        same_origin,
        content: await frame.evaluate(cacheDomState).catch(() => undefined),
      });
    } else {
      frames.push({ url, depth, same_origin, content: undefined });
    }
  }

  const data: Record<string, any> = {
    ...main,
    frames,
  };

  const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return {
    key: digest,
    url: String(main.url ?? page.url()),
    title: String(main.title ?? ''),
  };
}

function cacheDomState(): Record<string, any> {
    const clone = document.documentElement.cloneNode(true) as Element;
    for (const el of Array.from(clone.querySelectorAll('[data-llm-browser-id]'))) {
      el.removeAttribute('data-llm-browser-id');
    }
    const controls = Array.from(document.querySelectorAll('input, textarea, select')).map((node) => {
      const el = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
        return { id: el.id, name: el.name, type: el.type, checked: el.checked };
      }
      if (el instanceof HTMLSelectElement) {
        return { id: el.id, name: el.name, type: 'select', value: Array.from(el.selectedOptions).map((option) => option.value) };
      }
      return { id: el.id, name: el.name, type: el instanceof HTMLInputElement ? el.type : 'textarea', value: el.value };
    });

    return {
      url: location.href,
      title: document.title,
      html: clone.outerHTML,
      controls,
      shadow: Array.from(document.querySelectorAll('*'))
        .map((node) => {
          const el = node as HTMLElement;
          const root = el.shadowRoot ?? (window as any).__llmBrowserShadowRoots?.rootFor?.(el);
          if (!root) return undefined;
          const template = document.createElement('template');
          template.innerHTML = root.innerHTML;
          for (const shadowEl of Array.from(template.content.querySelectorAll('[data-llm-browser-id]'))) {
            shadowEl.removeAttribute('data-llm-browser-id');
          }
          return {
            host: el.id || el.tagName.toLowerCase(),
            mode: el.shadowRoot ? 'open' : 'closed',
            html: template.innerHTML,
          };
        })
        .filter(Boolean),
    };
}

function frameDepth(frame: Frame): number {
  let depth = 0;
  let current = frame.parentFrame();
  while (current) {
    depth += 1;
    current = current.parentFrame();
  }
  return depth;
}

function isSameOrigin(parentUrl: string, childUrl: string): boolean {
  try {
    if (!childUrl || childUrl === 'about:blank' || childUrl === 'about:srcdoc') return true;
    return new URL(parentUrl).origin === new URL(childUrl, parentUrl).origin;
  } catch {
    return false;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
