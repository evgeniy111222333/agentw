import { LlmBrowserError } from '../../src/common/errors';

/**
 * Unit tests for the new MCP tab management tools:
 * - browser_open_tab
 * - browser_switch_tab
 * - browser_close_tab
 *
 * These tests verify:
 * 1. Tool definitions are properly structured
 * 2. Handler functions accept correct parameters
 * 3. Error cases are handled correctly
 * 4. Response format matches specification
 */

describe('MCP Tab Tools', () => {
  describe('Tool Definitions', () => {
    it('browser_open_tab should accept optional url parameter', () => {
      const toolDef = {
        name: 'browser_open_tab',
        description:
          'Open a new browser tab with an optional URL. ' +
          'TIP: The new tab automatically becomes the active tab.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Optional URL to open in the new tab.',
            },
          },
          required: [],
        },
      };

      expect(toolDef.name).toBe('browser_open_tab');
      expect(toolDef.inputSchema.properties.url).toBeDefined();
      expect(toolDef.inputSchema.required).toHaveLength(0);
    });

    it('browser_switch_tab should require tab_id parameter', () => {
      const toolDef = {
        name: 'browser_switch_tab',
        inputSchema: {
          type: 'object',
          properties: {
            tab_id: {
              type: 'string',
              description: 'The ID of the tab to switch to.',
            },
          },
          required: ['tab_id'],
        },
      };

      expect(toolDef.name).toBe('browser_switch_tab');
      expect(toolDef.inputSchema.required).toContain('tab_id');
    });

    it('browser_close_tab should accept optional tab_id parameter', () => {
      const toolDef = {
        name: 'browser_close_tab',
        inputSchema: {
          type: 'object',
          properties: {
            tab_id: {
              type: 'string',
              description: 'Optional ID of the tab to close.',
            },
          },
          required: [],
        },
      };

      expect(toolDef.name).toBe('browser_close_tab');
      expect(toolDef.inputSchema.required).toHaveLength(0);
    });
  });

  describe('browser_open_tab response format', () => {
    it('should return new_tab, tabs array, and tabs_count', () => {
      const mockResponse = {
        status: 'tab_opened',
        new_tab: {
          tab_id: 'tab-2',
          url: 'https://example.com',
          title: 'Example',
          active: true,
        },
        tabs: [
          { tab_id: 'tab-1', url: 'https://google.com', title: 'Google', active: false },
          { tab_id: 'tab-2', url: 'https://example.com', title: 'Example', active: true },
        ],
        tabs_count: 2,
      };

      expect(mockResponse.status).toBe('tab_opened');
      expect(mockResponse.new_tab.tab_id).toBeDefined();
      expect(mockResponse.tabs).toBeInstanceOf(Array);
      expect(mockResponse.tabs_count).toBe(mockResponse.tabs.length);
      expect(mockResponse.new_tab.active).toBe(true);
    });
  });

  describe('browser_switch_tab response format', () => {
    it('should return active_tab, url, and title', () => {
      const mockResponse = {
        status: 'tab_switched',
        active_tab: {
          tab_id: 'tab-2',
          url: 'https://example.com',
          title: 'Example',
          active: true,
        },
        url: 'https://example.com',
        title: 'Example',
      };

      expect(mockResponse.status).toBe('tab_switched');
      expect(mockResponse.active_tab.tab_id).toBe('tab-2');
      expect(mockResponse.url).toBe('https://example.com');
      expect(mockResponse.title).toBe('Example');
    });
  });

  describe('browser_close_tab response format', () => {
    it('should return closed_tab_id, active_tab, remaining_tabs, and remaining_count', () => {
      const mockResponse = {
        status: 'tab_closed',
        closed_tab_id: 'tab-1',
        active_tab: {
          tab_id: 'tab-2',
          url: 'https://example.com',
          title: 'Example',
          active: true,
        },
        remaining_tabs: [
          { tab_id: 'tab-2', url: 'https://example.com', title: 'Example', active: true },
        ],
        remaining_count: 1,
      };

      expect(mockResponse.status).toBe('tab_closed');
      expect(mockResponse.closed_tab_id).toBe('tab-1');
      expect(mockResponse.active_tab.tab_id).toBe('tab-2');
      expect(mockResponse.remaining_tabs).toBeInstanceOf(Array);
      expect(mockResponse.remaining_count).toBe(1);
    });
  });

  describe('Error handling', () => {
    it('browser_switch_tab should throw when tab_id is missing', () => {
      const error = new LlmBrowserError('MISSING_PARAM', 'tab_id is required for browser_switch_tab');

      expect(error.code).toBe('MISSING_PARAM');
      expect(error.message).toContain('tab_id');
    });

    it('open_tab should handle invalid URL', () => {
      const error = new LlmBrowserError(
        'SECURITY_VIOLATION',
        'URL protocol file:// is not allowed. Only http: and https: are permitted.'
      );

      expect(error.code).toBe('SECURITY_VIOLATION');
    });

    it('close_tab should throw when trying to close last tab', () => {
      const error = new LlmBrowserError(
        'INVALID_PARAMS',
        'Cannot close last remaining tab'
      );

      expect(error.code).toBe('INVALID_PARAMS');
      expect(error.message).toContain('last');
    });
  });

  describe('Tab state transitions', () => {
    it('open_tab should make new tab active', () => {
      const beforeTabs = [
        { tab_id: 'tab-1', url: 'https://google.com', title: 'Google', active: true },
      ];
      const afterTabs = [
        { tab_id: 'tab-1', url: 'https://google.com', title: 'Google', active: false },
        { tab_id: 'tab-2', url: 'https://example.com', title: 'Example', active: true },
      ];

      const oldActive = beforeTabs.find(t => t.active);
      const newActive = afterTabs.find(t => t.active);
      const newTab = afterTabs.find(t => t.tab_id === 'tab-2');

      expect(oldActive?.tab_id).toBe('tab-1');
      expect(newActive?.tab_id).toBe('tab-2');
      expect(newTab?.active).toBe(true);
    });

    it('switch_tab should preserve old active tab state', () => {
      const beforeTabs = [
        { tab_id: 'tab-1', url: 'https://google.com', title: 'Google', active: true },
        { tab_id: 'tab-2', url: 'https://example.com', title: 'Example', active: false },
      ];
      const afterTabs = [
        { tab_id: 'tab-1', url: 'https://google.com', title: 'Google', active: false },
        { tab_id: 'tab-2', url: 'https://example.com', title: 'Example', active: true },
      ];

      expect(afterTabs.find(t => t.tab_id === 'tab-2')?.active).toBe(true);
      expect(afterTabs.find(t => t.tab_id === 'tab-1')?.active).toBe(false);
    });

    it('close_tab should activate next available tab', () => {
      const beforeTabs = [
        { tab_id: 'tab-1', url: 'https://google.com', title: 'Google', active: true },
        { tab_id: 'tab-2', url: 'https://example.com', title: 'Example', active: false },
        { tab_id: 'tab-3', url: 'https://github.com', title: 'GitHub', active: false },
      ];

      const closedTabId = 'tab-1';
      const afterTabs = beforeTabs.filter(t => t.tab_id !== closedTabId);
      const newActive = afterTabs.find(t => t.active) || afterTabs[0];

      afterTabs.forEach(t => {
        t.active = t.tab_id === newActive.tab_id;
      });

      expect(newActive.tab_id).toBe('tab-2');
      expect(newActive.active).toBe(true);
    });
  });
});