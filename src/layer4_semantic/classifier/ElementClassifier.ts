import { ElementType } from '../../common/types';

export type ClassificationLevel = 'encapsulation' | 'tag' | 'aria' | 'heuristic' | 'ml_fallback';

export interface ClassificationResult {
  type: ElementType;
  confidence: number;
  level: ClassificationLevel;
  signals: string[];
  candidates?: Array<{ type: ElementType; score: number }>;
  low_confidence?: boolean;
}

type Candidate = {
  type: ElementType;
  confidence: number;
  level: ClassificationLevel;
  signals: string[];
  candidates?: Array<{ type: ElementType; score: number }>;
};

export class ElementClassifier {
  classify(node: any): ElementType {
    return this.classifyDetailed(node).type;
  }

  classifyDetailed(node: any): ClassificationResult {
    const role = normalize(node.role ?? node.attributes?.role);
    const tagName = normalize(node.tagName);
    const attributes = node.attributes ?? {};

    const encapsulation = this.classifyEncapsulation(node);
    if (encapsulation) return finalize(encapsulation);

    const tagType = this.classifyByTag(tagName, attributes, node);
    const roleType = this.classifyByRole(role, attributes, node);

    // ARIA expresses explicit author intent and can override a generic tag.
    if (roleType && (!tagType || roleType.confidence >= tagType.confidence || tagName === 'div' || tagName === 'span')) {
      return finalize(roleType);
    }
    if (tagType) return finalize(tagType);

    const heuristicType = this.classifyByHeuristic(node, attributes);
    if (heuristicType && heuristicType.confidence >= 0.7) return finalize(heuristicType);

    const fallback = this.classifyByDecisionTree(node, attributes, heuristicType);
    return finalize(fallback);
  }

  private classifyEncapsulation(node: any): Candidate | undefined {
    if (node.shadow?.has_shadow) {
      return candidate('shadow_host', 0.98, 'encapsulation', ['shadow_root_detected']);
    }
    if (node.iframe?.embed_type || node.iframe?.iframe_type === 'content') {
      return candidate('embed', 0.96, 'encapsulation', [`iframe:${node.iframe?.embed_type ?? node.iframe?.iframe_type}`]);
    }
    if (node.iframe) {
      return candidate('iframe', 0.95, 'encapsulation', [`iframe:${node.iframe.iframe_type ?? 'unknown'}`]);
    }
    return undefined;
  }

  private classifyByRole(role: string | undefined, attributes: Record<string, string>, node: any): Candidate | undefined {
    switch (role) {
      case 'alert':
      case 'status':
      case 'log':
        return candidate('notification', 0.96, 'aria', [`role:${role}`]);
      case 'alertdialog':
        return candidate('modal', 0.97, 'aria', ['role:alertdialog']);
      case 'button':
      case 'switch':
      case 'checkbox':
      case 'radio':
        return candidate('button', 0.96, 'aria', [`role:${role}`]);
      case 'combobox':
      case 'listbox':
        return candidate('select', 0.94, 'aria', [`role:${role}`]);
      case 'dialog':
        return candidate(attributes['aria-modal'] === 'true' || classAndIdText(node).includes('modal') ? 'modal' : 'dialog', 0.95, 'aria', ['role:dialog']);
      case 'grid':
      case 'table':
        return candidate('table', 0.94, 'aria', [`role:${role}`]);
      case 'img':
        return candidate('image', 0.93, 'aria', ['role:img']);
      case 'link':
        return candidate('link', 0.96, 'aria', ['role:link']);
      case 'list':
        return candidate('list', 0.91, 'aria', ['role:list']);
      case 'menu':
      case 'menubar':
        return candidate('menu', 0.95, 'aria', [`role:${role}`]);
      case 'menuitem':
      case 'option':
        return candidate('menu_item', 0.94, 'aria', [`role:${role}`]);
      case 'navigation':
        if (isBreadcrumbLike(node, attributes)) return candidate('breadcrumb', 0.96, 'aria', ['role:navigation', 'breadcrumb_label']);
        if (isPaginationLike(node, attributes)) return candidate('pagination', 0.93, 'aria', ['role:navigation', 'pagination_signal']);
        return candidate('navigation', 0.94, 'aria', ['role:navigation']);
      case 'progressbar':
      case 'meter':
      case 'slider':
        return candidate('progress', 0.93, 'aria', [`role:${role}`]);
      case 'searchbox':
      case 'textbox':
        return candidate(node.tagName === 'textarea' ? 'textarea' : 'input', 0.94, 'aria', [`role:${role}`]);
      case 'separator':
        return candidate('separator', 0.95, 'aria', ['role:separator']);
      case 'tablist':
        return candidate('tab_group', 0.96, 'aria', ['role:tablist']);
      case 'tab':
        return candidate('button', 0.9, 'aria', ['role:tab']);
      case 'tooltip':
        return candidate('tooltip', 0.96, 'aria', ['role:tooltip']);
      case 'article':
        return candidate('article', 0.92, 'aria', ['role:article']);
      case 'heading':
        return candidate('heading', 0.96, 'aria', ['role:heading']);
      default:
        return undefined;
    }
  }

  private classifyByTag(tagName: string | undefined, attributes: Record<string, string>, node: any): Candidate | undefined {
    switch (tagName) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return candidate('heading', 0.99, 'tag', [`tag:${tagName}`]);
      case 'a':
      case 'area':
        if (attributes.href) {
          // v2: Detect "heading links" — links that serve as titles/headings
          // (e.g., HN post titles <a class="titleline">, article title links, etc.)
          if (isHeadingLink(node, attributes)) {
            return candidate('heading', 0.88, 'heuristic', ['tag:a', 'href', 'heading_link']);
          }
          return candidate('link', 0.98, 'tag', ['tag:a', 'href']);
        }
        return candidate('button', 0.82, 'heuristic', ['tag:a', 'missing_href']);
      case 'button':
      case 'summary':
        return candidate('button', 0.98, 'tag', [`tag:${tagName}`]);
      case 'input':
        return ['submit', 'button', 'reset', 'image'].includes(normalize(attributes.type) ?? '')
          ? candidate('button', 0.97, 'tag', ['tag:input', `type:${attributes.type}`])
          : candidate('input', 0.98, 'tag', ['tag:input']);
      case 'textarea':
        return candidate('textarea', 0.99, 'tag', ['tag:textarea']);
      case 'select':
        return candidate('select', 0.99, 'tag', ['tag:select']);
      case 'form':
        return candidate('form', 0.99, 'tag', ['tag:form']);
      case 'table':
        return candidate('table', 0.99, 'tag', ['tag:table']);
      case 'ul':
      case 'ol':
        if (isBreadcrumbLike(node, attributes)) return candidate('breadcrumb', 0.92, 'heuristic', [`tag:${tagName}`, 'breadcrumb_signal']);
        if (isStepperLike(node, attributes)) return candidate('stepper', 0.88, 'heuristic', [`tag:${tagName}`, 'stepper_signal']);
        return candidate('list', 0.96, 'tag', [`tag:${tagName}`]);
      case 'img':
      case 'picture':
        return candidate('image', 0.98, 'tag', [`tag:${tagName}`]);
      case 'svg':
        if (isChartLike(node, attributes)) return candidate('chart', 0.88, 'heuristic', ['tag:svg', 'chart_signal']);
        return candidate('image', 0.9, 'tag', ['tag:svg']);
      case 'canvas':
        return isChartLike(node, attributes)
          ? candidate('chart', 0.9, 'heuristic', ['tag:canvas', 'chart_signal'])
          : candidate('image', 0.82, 'tag', ['tag:canvas']);
      case 'figure':
        if (isCardLike(node, attributes)) return candidate('card', 0.86, 'heuristic', ['tag:figure', 'card_signal']);
        if (isChartLike(node, attributes)) return candidate('chart', 0.86, 'heuristic', ['tag:figure', 'chart_signal']);
        return candidate('image', 0.86, 'tag', ['tag:figure']);
      case 'nav':
        if (isBreadcrumbLike(node, attributes)) return candidate('breadcrumb', 0.95, 'heuristic', ['tag:nav', 'breadcrumb_signal']);
        if (isPaginationLike(node, attributes)) return candidate('pagination', 0.93, 'heuristic', ['tag:nav', 'pagination_signal']);
        return candidate('navigation', 0.98, 'tag', ['tag:nav']);
      case 'article':
      case 'main':
      case 'section':
        if (isCardLike(node, attributes)) return candidate('card', 0.86, 'heuristic', [`tag:${tagName}`, 'card_signal']);
        return candidate(tagName === 'section' ? 'article' : 'article', tagName === 'section' ? 0.78 : 0.96, tagName === 'section' ? 'heuristic' : 'tag', [`tag:${tagName}`]);
      case 'iframe':
        return candidate('iframe', 0.99, 'tag', ['tag:iframe']);
      case 'video':
        return candidate('video', 0.99, 'tag', ['tag:video']);
      case 'audio':
        return candidate('audio', 0.99, 'tag', ['tag:audio']);
      case 'dialog':
        return candidate(attributes.open !== undefined || attributes['aria-modal'] === 'true' ? 'modal' : 'dialog', 0.98, 'tag', ['tag:dialog']);
      case 'progress':
      case 'meter':
        return candidate('progress', 0.98, 'tag', [`tag:${tagName}`]);
      case 'hr':
        return candidate('separator', 0.98, 'tag', ['tag:hr']);
      case 'details':
        return candidate('accordion', 0.92, 'tag', ['tag:details']);
      default:
        return undefined;
    }
  }

  private classifyByHeuristic(node: any, attributes: Record<string, string>): Candidate | undefined {
    // v2: Use classAndIdText for CSS class matching (NOT label — prevents contamination)
    const classes = classAndIdText(node);
    const allText = joinedSignals(node, attributes);
    const role = normalize(node.role ?? attributes.role);
    const tagName = normalize(node.tagName);
    const computed = node.computed ?? {};
    const componentKind = normalize(node.component?.kind);

    const componentMap: Record<string, ElementType> = {
      card: 'card',
      pagination: 'pagination',
      breadcrumb: 'breadcrumb',
      accordion: 'accordion',
      chart: 'chart',
      carousel: 'carousel',
      rating: 'rating',
      stepper: 'stepper',
      skeleton: 'skeleton',
      modal: 'modal',
      dialog: 'dialog',
      menu: 'menu',
      badge: 'badge',
    };
    if (componentKind && componentMap[componentKind]) {
      return candidate(componentMap[componentKind], 0.9, 'heuristic', [`component:${componentKind}`]);
    }
    if (node.media?.kind === 'audio') return candidate('audio', 0.94, 'heuristic', ['media:audio']);
    if (node.media?.kind === 'video') return candidate('video', 0.94, 'heuristic', ['media:video']);
    if (node.media?.kind === 'chart') return candidate('chart', 0.88, 'heuristic', ['media:chart']);

    const classRules: Array<{ type: ElementType; pattern: RegExp; confidence: number; signal: string }> = [
      // v2: Added heading-link class patterns before generic card/modal
      { type: 'heading', pattern: /\b(titleline|storylink|headline|post-title|entry-title|article-title|page-title|section-title)\b/, confidence: 0.90, signal: 'class:heading_link' },
      { type: 'card', pattern: /\b(athing|post|story-item|feed-item|list-item|search-result)\b/, confidence: 0.88, signal: 'class:post_card' },
      { type: 'skeleton', pattern: /\b(skeleton|shimmer|placeholder-loading|loading-placeholder|react-loading-skeleton)\b/, confidence: 0.94, signal: 'class:skeleton' },
      { type: 'breadcrumb', pattern: /\b(breadcrumb|breadcrumbs|crumbs|trail)\b/, confidence: 0.93, signal: 'class:breadcrumb' },
      { type: 'pagination', pattern: /\b(pagination|pager|page-nav|pages|paginator)\b/, confidence: 0.92, signal: 'class:pagination' },
      { type: 'accordion', pattern: /\b(accordion|collapse|collapsible|disclosure|faq-item|expander)\b/, confidence: 0.9, signal: 'class:accordion' },
      { type: 'carousel', pattern: /\b(carousel|slider|slideshow|swiper|glide|splide)\b/, confidence: 0.89, signal: 'class:carousel' },
      { type: 'rating', pattern: /\b(rating|stars|star-rating|review-score|score-stars)\b/, confidence: 0.9, signal: 'class:rating' },
      { type: 'stepper', pattern: /\b(stepper|steps|wizard|progress-steps|timeline-steps)\b/, confidence: 0.88, signal: 'class:stepper' },
      { type: 'chart', pattern: /\b(chart|graph|plot|sparkline|visualization|viz)\b/, confidence: 0.88, signal: 'class:chart' },
      { type: 'card', pattern: /\b(card|product-card|profile-card|news-card|article-card|tile|result-card|item-card)\b/, confidence: 0.86, signal: 'class:card' },
      { type: 'modal', pattern: /\b(modal|overlay|drawer|lightbox)\b/, confidence: 0.86, signal: 'class:modal' },
      { type: 'dialog', pattern: /\b(dialog|popover|sheet)\b/, confidence: 0.84, signal: 'class:dialog' },
      { type: 'menu', pattern: /\b(menu|dropdown-menu|context-menu|command-palette)\b/, confidence: 0.84, signal: 'class:menu' },
      { type: 'badge', pattern: /\b(badge|pill|tag|chip|status)\b/, confidence: 0.82, signal: 'class:badge' },
      { type: 'tooltip', pattern: /\b(tooltip|popover-content|hint)\b/, confidence: 0.82, signal: 'class:tooltip' },
      { type: 'tab_group', pattern: /\b(tabs|tab-list|tablist|segmented-control)\b/, confidence: 0.82, signal: 'class:tabs' },
    ];
    for (const rule of classRules) {
      if (rule.pattern.test(classes)) return candidate(rule.type, rule.confidence, 'heuristic', [rule.signal]);
    }

    if (isBreadcrumbLike(node, attributes)) return candidate('breadcrumb', 0.88, 'heuristic', ['aria-label:breadcrumb']);
    if (isPaginationLike(node, attributes)) return candidate('pagination', 0.85, 'heuristic', ['pagination_structure']);
    if (isStepperLike(node, attributes)) return candidate('stepper', 0.8, 'heuristic', ['stepper_structure']);
    if (isRatingLike(node, attributes)) return candidate('rating', 0.82, 'heuristic', ['rating_pattern']);
    if (isCardLike(node, attributes)) return candidate('card', 0.78, 'heuristic', ['card_structure']);
    if (isChartLike(node, attributes)) return candidate('chart', 0.78, 'heuristic', ['chart_attributes']);

    if (
      attributes.onclick ||
      attributes['data-semantic-action'] ||
      attributes.tabindex === '0' ||
      attributes.role === 'button' ||
      computed.cursor === 'pointer' ||
      /\b(btn|button|cta|action|submit|clickable)\b/.test(classes) ||
      /^(buy|submit|send|search|save|add|remove|delete|continue|next|previous|back|login|sign in|checkout|apply|cancel|close|open|play|pause)\b/i.test(String(node.text ?? node.label ?? '').trim())
    ) {
      return candidate('button', 0.78, 'heuristic', ['interactive_signal']);
    }

    if (role === 'presentation' || attributes['aria-hidden'] === 'true') {
      return candidate('separator', 0.55, 'ml_fallback', ['presentation_fallback']);
    }

    const text = String(node.text ?? node.label ?? '');
    const fontSize = Number(computed.font_size_px ?? 0);
    const fontWeight = Number(computed.font_weight ?? 0);
    if (tagName === 'div' || tagName === 'span' || tagName === 'p') {
      // v3: Stricter thresholds + navigation/interactive exclusions.
      // Previous v2 (fontSize>=16 || fontWeight>=550) caused massive over-classification:
      //   Wikipedia: "Main menu Search Donate Create account Log in" (fontWeight 600, many interactive children)
      //   NYTimes: "SKIP ADVERTISEMENT" (bold text, skip link)
      //   NYTimes: "U.S.INTERNATIONALCANADAESPAÑOL中文" (nav bar with bold text)
      // These are NOT headings — they're navigation/interactive elements with bold styling.
      const interactiveCount = Number(node.dom?.descendant_interactive_count ?? 0);
      const isNavContext = /\b(nav|menu|toolbar|sidebar|footer|header|breadcrumb|pagination|skip|jump)\b/.test(classes);
      const isSkipText = /^(skip|jump)\s/i.test(text);
      const hasManyInteractive = interactiveCount >= 3;
      // Only classify as heading if: not nav-like, not skip text, not dense interactive,
      // AND meets stricter visual thresholds (fontSize>=20 OR fontWeight>=700)
      if (!isNavContext && !isSkipText && !hasManyInteractive &&
          text.length >= 3 && text.length <= 120 &&
          (fontSize >= 20 || fontWeight >= 700)) {
        return candidate('heading', fontSize >= 24 || fontWeight >= 800 ? 0.77 : 0.68, 'heuristic', ['style:heading']);
      }
    }

    if (/\b(nav|navbar|sidebar|footer-links|header-links)\b/.test(allText)) {
      return candidate('navigation', 0.74, 'heuristic', ['navigation_terms']);
    }

    return undefined;
  }

  private classifyByDecisionTree(
    node: any,
    attributes: Record<string, string>,
    previous?: Candidate
  ): Candidate {
    const scores = new Map<ElementType, number>();
    const add = (type: ElementType, amount: number) => scores.set(type, (scores.get(type) ?? 0) + amount);
    const classes = classAndIdText(node);
    const text = String(node.text ?? node.label ?? '');
    const tagName = normalize(node.tagName);
    const computed = node.computed ?? {};
    const childCount = Number(node.dom?.child_element_count ?? 0);
    const interactiveCount = Number(node.dom?.descendant_interactive_count ?? 0);
    const imageCount = Number(node.dom?.descendant_image_count ?? 0);
    const linkCount = Number(node.dom?.descendant_link_count ?? 0);

    if (previous) add(previous.type, previous.confidence);
    if (text) add('text', Math.min(0.35, text.length / 400));
    if (text.length > 5 && text.length < 120 && Number(computed.font_weight ?? 0) >= 600) add('heading', 0.3);
    if (interactiveCount > 0 && imageCount > 0 && text.length > 20) add('card', 0.45);
    if (childCount >= 3 && linkCount >= 2) add('navigation', 0.25);
    if (linkCount >= 3 && /(^|\D)(1|2|3|next|prev|previous)(\D|$)/i.test(text)) add('pagination', 0.45);
    if (/\$|€|£|₴|price|sku|product|article|profile|card/.test(`${classes} ${text}`.toLowerCase())) add('card', 0.35);
    if (/[★☆]/.test(text)) add('rating', 0.45);
    if (computed.cursor === 'pointer') add('button', 0.35);
    if (attributes.href) add('link', 0.45);
    if (attributes.title && !text) add('tooltip', 0.2);
    if (tagName === 'canvas' || tagName === 'svg') add('chart', 0.25);

    const candidates = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, score]) => ({ type, score: Number(score.toFixed(3)) }));
    const [bestType, bestScore] = Array.from(scores.entries()).sort((a, b) => b[1] - a[1])[0] ?? ['text', 0.3];
    const confidence = Math.max(0.5, Math.min(0.69, 0.48 + bestScore));
    return candidate(bestType, confidence, 'ml_fallback', ['decision_tree_fallback'], candidates);
  }
}

function candidate(
  type: ElementType,
  confidence: number,
  level: ClassificationLevel,
  signals: string[],
  candidates?: Array<{ type: ElementType; score: number }>
): Candidate {
  return {
    type,
    confidence: Number(confidence.toFixed(3)),
    level,
    signals,
    candidates,
  };
}

function finalize(value: Candidate): ClassificationResult {
  return {
    ...value,
    low_confidence: value.confidence < 0.7 || undefined,
  };
}

function normalize(value: string | undefined): string | undefined {
  return value?.toLowerCase();
}

/**
 * classAndIdText — ONLY class names and IDs, NOT label text.
 * Used for CSS class-based matching (classRules, role classification).
 * Label text can contain words like "modal", "card", "menu" that cause
 * false-positive classRule matches (e.g., HN post from "modal.com" → modal).
 */
function classAndIdText(node: any): string {
  const attributes = node.attributes ?? {};
  const values = [
    attributes.class,
    attributes.id,
    node.dom?.id,
    Array.isArray(node.dom?.classes) ? node.dom.classes.join(' ') : undefined,
  ];
  return values.filter(Boolean).join(' ').toLowerCase();
}

/**
 * classText — class names, IDs, AND label text.
 * Used for structural detection (isBreadcrumbLike, etc.) where
 * label context is meaningful. NOT used for classRules matching.
 */
function classText(node: any): string {
  const attributes = node.attributes ?? {};
  const values = [
    attributes.class,
    attributes.id,
    node.dom?.id,
    Array.isArray(node.dom?.classes) ? node.dom.classes.join(' ') : undefined,
    node.label,
  ];
  return values.filter(Boolean).join(' ').toLowerCase();
}

function joinedSignals(node: any, attributes: Record<string, string>): string {
  return [
    classAndIdText(node),
    attributes['aria-label'],
    attributes.title,
    attributes.name,
    attributes.href,
    attributes['data-chart-type'],
    attributes['data-chart-data'],
    attributes['data-title'],
    attributes['data-subtitle'],
    node.text,
    node.label,
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * isHeadingLink — Detect links that serve as headings/titles.
 * A link is a heading-link when:
 *   1. It has a title-related CSS class (titleline, storylink, headline, etc.)
 *   2. It has prominent visual styling (large font or bold) with short text
 *   3. It's inside a card-like structure and looks like the primary title
 */
function isHeadingLink(node: any, attributes: Record<string, string>): boolean {
  const classes = classAndIdText(node);
  const computed = node.computed ?? {};
  const fontSize = Number(computed.font_size_px ?? 0);
  const fontWeight = Number(computed.font_weight ?? 0);
  const text = String(node.text ?? node.label ?? '').trim();

  // Signal 1: Title-related CSS class
  if (/\b(titleline|storylink|headline|post-title|entry-title|article-title|page-title|section-title|heading|post-link)\b/.test(classes)) {
    return true;
  }

  // Signal 2: Prominent styling + short text (link acting as a heading)
  // Larger threshold than generic heading detection: 18px or 600 weight
  if (text.length >= 5 && text.length <= 200 && (fontSize >= 18 || fontWeight >= 600)) {
    return true;
  }

  return false;
}

function isBreadcrumbLike(node: any, attributes: Record<string, string>): boolean {
  const value = joinedSignals(node, attributes);
  return /breadcrumb|breadcrumbs|crumbs|you are here|trail/.test(value);
}

function isPaginationLike(node: any, attributes: Record<string, string>): boolean {
  const value = joinedSignals(node, attributes);
  const component = normalize(node.component?.kind);
  const pages = Number(node.component?.pagination?.pages?.length ?? 0);
  const linkCount = Number(node.dom?.descendant_link_count ?? 0);
  return component === 'pagination' || /pagination|pager|paginator|next page|previous page|page \d/.test(value) || pages >= 2 || (linkCount >= 3 && /\b(next|prev|previous|1|2|3)\b/i.test(String(node.text ?? '')));
}

function isStepperLike(node: any, attributes: Record<string, string>): boolean {
  const value = joinedSignals(node, attributes);
  return /stepper|steps|wizard|checkout steps|progress steps|step \d/.test(value);
}

function isRatingLike(node: any, attributes: Record<string, string>): boolean {
  const value = joinedSignals(node, attributes);
  return /rating|stars?|reviews?|aria-valuenow|out of 5/.test(value) || /[★☆]{2,}/.test(String(node.text ?? node.label ?? ''));
}

function isCardLike(node: any, attributes: Record<string, string>): boolean {
  const value = joinedSignals(node, attributes);
  const childCount = Number(node.dom?.child_element_count ?? 0);
  const interactiveCount = Number(node.dom?.descendant_interactive_count ?? 0);
  const imageCount = Number(node.dom?.descendant_image_count ?? 0);
  return /card|product|profile|article-card|tile|result-item|listing-item|news-item/.test(value) ||
    (childCount >= 2 && (interactiveCount > 0 || imageCount > 0) && String(node.text ?? node.label ?? '').length > 20);
}

function isChartLike(node: any, attributes: Record<string, string>): boolean {
  const value = joinedSignals(node, attributes);
  return node.media?.kind === 'chart' ||
    Boolean(attributes['data-chart-type'] || attributes['data-chart-data']) ||
    /chart|graph|plot|sparkline|visualization|data-chart|d3|chartjs/.test(value);
}