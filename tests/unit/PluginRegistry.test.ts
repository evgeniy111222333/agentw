import { PluginRegistry, SemanticPlugin } from '../../src/plugins/PluginRegistry';

describe('PluginRegistry', () => {
  it('keeps the highest-priority plugin when action registrations conflict', () => {
    const registry = new PluginRegistry();

    registry.register(pluginWithAction('low-priority', 1, 'checkout'));
    registry.register(pluginWithAction('high-priority', 10, 'checkout'));

    const plugins = registry.listPlugins();
    const high = plugins.find((plugin) => plugin.name === 'high-priority');
    const low = plugins.find((plugin) => plugin.name === 'low-priority');

    expect(high).toEqual(expect.objectContaining({
      status: 'enabled',
      actions: [expect.objectContaining({ name: 'checkout' })],
    }));
    expect(low).toEqual(expect.objectContaining({
      status: 'disabled',
      disabled_reason: expect.stringContaining('conflict on checkout'),
    }));
  });

  it('applies enabled page-load contributions in priority order', async () => {
    const registry = new PluginRegistry();
    registry.register(pagePlugin('second', 1, 'second_action'));
    registry.register(pagePlugin('first', 10, 'first_action'));

    const result = await registry.applyPageLoad({
      page: {} as any,
      url: 'https://example.test',
      title: 'Example',
      session: {
        session_id: 'session-1',
        tab_id: 'tab-1',
        tabs_count: 1,
        history_length: 0,
        cookies_count: 0,
      },
      elements: [],
      available_actions: [],
    });

    expect(result.available_actions.map((action) => action.action)).toEqual(['first_action', 'second_action']);
    expect(result.stats.actions).toBe(2);
  });
});

function pluginWithAction(name: string, priority: number, actionName: string): SemanticPlugin {
  return {
    metadata: { name, version: '1.0.0', priority },
    registerActions: () => [{ name: actionName }],
  };
}

function pagePlugin(name: string, priority: number, action: string): SemanticPlugin {
  return {
    metadata: { name, version: '1.0.0', priority },
    onPageLoad: () => ({
      actions: [
        {
          action_id: action,
          action,
          label: action,
          risk: 'low',
        },
      ],
    }),
  };
}
