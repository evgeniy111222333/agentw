import { ElementClassifier } from '../../src/layer4_semantic/classifier/ElementClassifier';

describe('ElementClassifier', () => {
  const classifier = new ElementClassifier();

  it('classifies based on ARIA role', () => {
    const node = { role: 'button', tagName: 'div', attributes: {} };
    expect(classifier.classify(node)).toBe('button');
  });

  it('classifies based on tagName if role is missing', () => {
    const node = { tagName: 'h1', attributes: {} };
    expect(classifier.classify(node)).toBe('heading');
  });

  it('uses heuristics (onclick) as fallback', () => {
    const node = { tagName: 'div', attributes: { onclick: 'doSomething()' } };
    expect(classifier.classify(node)).toBe('button');
  });

  it('classifies richer ARIA roles', () => {
    expect(classifier.classify({ role: 'menuitem', tagName: 'div', attributes: {} })).toBe('menu_item');
    expect(classifier.classify({ role: 'progressbar', tagName: 'div', attributes: {} })).toBe('progress');
    expect(classifier.classify({ role: 'combobox', tagName: 'div', attributes: {} })).toBe('select');
  });

  it('produces the full concept component vocabulary from heuristic signals', () => {
    const cases: Array<[string, Record<string, any>]> = [
      ['card', { tagName: 'div', text: 'Product card $99 Add to cart', attributes: { class: 'product-card' } }],
      ['pagination', { tagName: 'div', text: 'Previous 1 2 3 Next', attributes: { class: 'pagination' } }],
      ['accordion', { tagName: 'div', attributes: { class: 'accordion-item' } }],
      ['breadcrumb', { tagName: 'nav', attributes: { 'aria-label': 'Breadcrumb' } }],
      ['chart', { tagName: 'canvas', attributes: { 'data-chart-type': 'line' } }],
      ['dialog', { tagName: 'div', attributes: { class: 'dialog-popover' } }],
      ['carousel', { tagName: 'div', attributes: { class: 'swiper carousel' } }],
      ['rating', { tagName: 'div', text: '★★★★☆ 4 out of 5', attributes: {} }],
      ['stepper', { tagName: 'ol', attributes: { class: 'checkout steps' } }],
      ['skeleton', { tagName: 'div', attributes: { class: 'skeleton shimmer' } }],
      ['textarea', { tagName: 'textarea', attributes: {} }],
      ['audio', { tagName: 'audio', attributes: { controls: '' } }],
    ];

    for (const [expected, node] of cases) {
      expect(classifier.classify(node)).toBe(expected);
    }
  });

  it('returns classification confidence, level, and fallback candidates', () => {
    const heuristic = classifier.classifyDetailed({
      tagName: 'div',
      text: 'Buy now',
      attributes: {},
      computed: { cursor: 'pointer' },
    });
    expect(heuristic).toEqual(expect.objectContaining({
      type: 'button',
      level: 'heuristic',
      confidence: expect.any(Number),
      signals: expect.arrayContaining(['interactive_signal']),
    }));

    const fallback = classifier.classifyDetailed({
      tagName: 'div',
      text: 'Quarterly revenue trend',
      attributes: {},
      dom: { child_element_count: 1, descendant_interactive_count: 0, descendant_image_count: 0 },
    });
    expect(fallback.level).toBe('ml_fallback');
    expect(fallback.candidates?.length).toBeGreaterThan(0);
  });

  it('defaults to text for unknown elements', () => {
    const node = { tagName: 'span', attributes: {} };
    expect(classifier.classify(node)).toBe('text');
  });
});
