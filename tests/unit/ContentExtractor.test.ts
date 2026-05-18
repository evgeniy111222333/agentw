import { ContentExtractor } from '../../src/layer4_semantic/extractor/ContentExtractor';
import { TraversedNode } from '../../src/layer4_semantic/traverser/DOMTraverser';

describe('ContentExtractor', () => {
  const extractor = new ContentExtractor();

  it('extracts form metadata and field relationships', () => {
    const node: TraversedNode = {
      id: 'form-1',
      tagName: 'form',
      label: 'Checkout',
      attributes: {},
      visible: true,
      disabled: false,
      required: false,
      selector: '[id="form-1"]',
      origin: 'main',
      form: {
        action: '/checkout',
        method: 'POST',
        fields: ['email', 'address'],
        submit_button_id: 'submit',
      },
    };

    expect(extractor.extract(node, 'form')).toEqual(expect.objectContaining({
      label: 'Checkout',
      action: '/checkout',
      method: 'POST',
      fields: ['email', 'address'],
      submit_button_id: 'submit',
    }));
  });

  it('masks sensitive input values', () => {
    const node: TraversedNode = {
      id: 'password',
      tagName: 'input',
      attributes: { type: 'password', value: 'secret' },
      visible: true,
      disabled: false,
      required: true,
      selector: '[id="password"]',
      origin: 'main',
    };

    expect(extractor.extract(node, 'input')).toEqual(expect.objectContaining({
      input_type: 'password',
      value: '[masked]',
      required: true,
    }));
  });
});
