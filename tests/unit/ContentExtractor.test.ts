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

  it('extracts rich form field attributes for textarea and select optgroups', () => {
    const textarea: TraversedNode = {
      id: 'notes',
      tagName: 'textarea',
      attributes: {
        name: 'notes',
        placeholder: 'Internal notes',
        maxlength: '500',
        rows: '4',
        cols: '40',
        autocomplete: 'off',
      },
      visible: true,
      disabled: false,
      required: false,
      selector: '#notes',
      origin: 'main',
    };
    const select: TraversedNode = {
      id: 'country',
      tagName: 'select',
      attributes: { name: 'country', value: 'ua', multiple: '' },
      visible: true,
      disabled: false,
      required: true,
      selector: '#country',
      origin: 'main',
      options: [
        { value: 'ua', label: 'Ukraine', selected: true, disabled: false, optgroup: 'Europe' },
        { value: 'jp', label: 'Japan', selected: false, disabled: false, optgroup: 'Asia' },
      ],
    };

    expect(extractor.extract(textarea, 'textarea')).toEqual(expect.objectContaining({
      input_type: 'textarea',
      name: 'notes',
      maxlength: 500,
      rows: 4,
      cols: 40,
    }));
    expect(extractor.extract(select, 'select')).toEqual(expect.objectContaining({
      value: 'ua',
      multiple: true,
      optgroups: ['Europe', 'Asia'],
    }));
  });

  it('extracts component and multimedia fields', () => {
    const card: TraversedNode = {
      id: 'product-card',
      tagName: 'div',
      text: 'Pro Plan',
      attributes: { class: 'product-card primary' },
      visible: true,
      disabled: false,
      required: false,
      selector: '#product-card',
      origin: 'main',
      component: {
        kind: 'card',
        title: 'Pro Plan',
        subtitle: '$29 per month',
        image_id: 'plan-img',
        actions: ['buy'],
      },
    };
    const chart: TraversedNode = {
      id: 'revenue',
      tagName: 'canvas',
      attributes: { 'data-chart-type': 'line' },
      visible: true,
      disabled: false,
      required: false,
      selector: '#revenue',
      origin: 'main',
      media: {
        kind: 'chart',
        chart_type: 'line',
        data_summary: 'Revenue grew from 12 to 45',
        width: 640,
        height: 240,
        pixel_hash: 'abc',
      },
    };

    expect(extractor.extract(card, 'card')).toEqual(expect.objectContaining({
      title: 'Pro Plan',
      subtitle: '$29 per month',
      image_id: 'plan-img',
      actions: ['buy'],
    }));
    expect(extractor.extract(chart, 'chart')).toEqual(expect.objectContaining({
      chart_type: 'line',
      data_summary: 'Revenue grew from 12 to 45',
      width: 640,
      height: 240,
      pixel_hash: 'abc',
    }));
  });
});
