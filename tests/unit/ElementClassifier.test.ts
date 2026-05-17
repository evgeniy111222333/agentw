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

  it('defaults to text for unknown elements', () => {
    const node = { tagName: 'span', attributes: {} };
    expect(classifier.classify(node)).toBe('text');
  });
});
