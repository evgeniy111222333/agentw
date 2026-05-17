import { ActionDiscovery } from '../../src/layer4_semantic/action_discovery/ActionDiscovery';
import { SemanticElement } from '../../src/common/types';

describe('ActionDiscovery', () => {
  const discovery = new ActionDiscovery();

  it('discovers actions based on semantic elements', () => {
    const elements: SemanticElement[] = [
      { id: 'btn-1', type: 'button', text: 'Submit' },
      { id: 'link-1', type: 'link', text: 'Home', url: '/home' },
      { id: 'download-1', type: 'link', text: 'Report', url: '/report.csv', download: 'report.csv' },
      { id: 'input-1', type: 'input', placeholder: 'Enter name' },
      { id: 'file-1', type: 'input', input_type: 'file', label: 'Upload report' },
      { id: 'form-1', type: 'form', fields: ['input-1'] }
    ];

    const actions = discovery.discover(elements);
    
    expect(actions).toContainEqual(expect.objectContaining({
      action: 'click', target: 'btn-1'
    }));
    
    expect(actions).toContainEqual(expect.objectContaining({
      action: 'navigate', target: 'link-1'
    }));

    expect(actions).toContainEqual(expect.objectContaining({
      action: 'download', target: 'download-1'
    }));
    
    expect(actions).toContainEqual(expect.objectContaining({
      action: 'type', target: 'input-1'
    }));

    expect(actions).toContainEqual(expect.objectContaining({
      action: 'upload', target: 'file-1'
    }));

    expect(actions).toContainEqual(expect.objectContaining({
      action: 'submit', target: 'form-1'
    }));

    // Should include global actions
    expect(actions).toContainEqual(expect.objectContaining({
      action: 'go_back'
    }));

    expect(actions).toContainEqual(expect.objectContaining({
      action: 'scroll',
      params: expect.objectContaining({ direction: 'down' })
    }));

    expect(actions).toContainEqual(expect.objectContaining({
      action: 'screenshot_file'
    }));

    expect(actions).toContainEqual(expect.objectContaining({
      action: 'fs'
    }));

    expect(actions).toContainEqual(expect.objectContaining({
      action: 'invalidate_cache'
    }));
  });

  it('does not expose targeted actions for disabled elements', () => {
    const elements: SemanticElement[] = [
      { id: 'btn-1', type: 'button', text: 'Submit', disabled: true }
    ];

    const actions = discovery.discover(elements);

    expect(actions).not.toContainEqual(expect.objectContaining({
      action: 'click',
      target: 'btn-1'
    }));
  });
});
