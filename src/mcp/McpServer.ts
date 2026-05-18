/**
 * MCP (Model Context Protocol) Server Adapter
 *
 * Exposes the LLM Browser as an MCP tool server, allowing any MCP-compatible
 * LLM client (Claude Desktop, Cursor, etc.) to directly use the browser.
 *
 * MCP Protocol: https://spec.modelcontextprotocol.io/
 *
 * Tools exposed:
 *   - browser_navigate   → navigate to URL
 *   - browser_snapshot   → get semantic snapshot of current page
 *   - browser_action     → execute an action (click, type, fill_form, etc.)
 *   - browser_list_tabs  → list open tabs
 *   - browser_screenshot → capture screenshot
 *
 * Usage: The MCP server runs on stdio or SSE transport alongside the main API server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BrowserCore } from '../layer1_browser_core/BrowserCore';
import { StateManagementLayer } from '../layer3_state_management/StateManagementLayer';
import { ActionExecutor } from '../layer2_action_execution/ActionExecutor';
import { SemanticLayer } from '../layer4_semantic/SemanticLayer';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { createDefaultPluginRegistry } from '../plugins/PluginRegistry';
import { SemanticSnapshot } from '../common/types';
import { randomUUID } from 'crypto';
import { DiagnosticsDashboard } from '../obs/DiagnosticsDashboard';
import { StateReconciler } from '../layer3_state_management/StateReconciler';

export class McpServer {
  private server: Server;
  private browserCore: BrowserCore;
  private stateManager: StateManagementLayer;
  private actionExecutor: ActionExecutor;
  private semanticLayer: SemanticLayer;
  private activeSessionId: string | null = null;
  private initialized = false;
  private lastSnapshots: Map<string, SemanticSnapshot> = new Map();
  private dashboard: DiagnosticsDashboard;

  constructor() {
    this.browserCore = new BrowserCore();
    this.stateManager = new StateManagementLayer();
    this.actionExecutor = new ActionExecutor(this.browserCore);
    const pluginRegistry = createDefaultPluginRegistry(
      ConfigurationManager.getInstance().getConfig().plugin_registry
    );
    this.semanticLayer = new SemanticLayer({ pluginRegistry });
    this.dashboard = new DiagnosticsDashboard(
      this.browserCore,
      this.stateManager,
      new StateReconciler(),
      this.lastSnapshots
    );

    this.server = new Server(
      {
        name: 'llm-browser',
        version: '2.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigate the browser to a URL. Returns the page title and URL after loading.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The URL to navigate to' },
            },
            required: ['url'],
          },
        },
        {
          name: 'browser_snapshot',
          description:
            'Get a semantic snapshot of the current page. Returns structured JSON with elements, ' +
            'available actions, forms, navigation info, and auth state. Use this to understand what ' +
            'is on the page before taking actions. Supports compact/standard/detailed modes.',
          inputSchema: {
            type: 'object',
            properties: {
              max_elements: {
                type: 'number',
                description: 'Max elements to include (default: 500, max: 2000)',
              },
              snapshot_mode: {
                type: 'string',
                enum: ['compact', 'standard', 'detailed'],
                description: 'Detail level: compact (minimal), standard (default), detailed (all fields)',
              },
              from_snapshot_id: {
                type: 'string',
                description: 'ID of the last snapshot received. Used to generate a delta.',
              },
              checksum: {
                type: 'string',
                description: 'Checksum of the last snapshot received. Required for strict delta consistency.',
              },
              delta_only: {
                type: 'boolean',
                description: 'If true, returns only the delta operations instead of the full elements array (saves tokens).',
              },
            },
          },
        },
        {
          name: 'browser_action',
          description:
            'Execute a browser action. Available actions: click, type, submit, select, hover, scroll, ' +
            'keyboard, fill_form, go_back, refresh, wait, screenshot, upload, download. ' +
            'Use browser_snapshot first to discover element IDs and available actions.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description:
                  'The action to execute: click, type, submit, select, hover, scroll, keyboard, ' +
                  'fill_form, go_back, refresh, wait, screenshot, upload, download',
              },
              target_id: {
                type: 'string',
                description: 'Element ID to target (from snapshot elements)',
              },
              params: {
                type: 'object',
                description:
                  'Action parameters. For "type": {text: "hello"}. For "fill_form": {form_id, fields: {name: value}}. ' +
                  'For "scroll": {direction: "down", amount: 720}. For "keyboard": {key: "Enter"}.',
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'browser_list_tabs',
          description: 'List all open browser tabs with their URLs and titles.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'browser_screenshot',
          description: 'Take a screenshot of the current page. Returns base64-encoded PNG image.',
          inputSchema: {
            type: 'object',
            properties: {
              full_page: {
                type: 'boolean',
                description: 'Capture full scrollable page (default: true)',
              },
            },
          },
        },
        {
          name: 'browser_diagnostics',
          description: 'Get real-time system diagnostics, health scores, performance metrics, and session states.',
          inputSchema: {
            type: 'object',
            properties: {
              summary_only: {
                type: 'boolean',
                description: 'If true, returns a compact LLM-friendly summary instead of the full report (default: false)',
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Ensure browser is initialized
        await this.ensureSession();

        switch (name) {
          case 'browser_navigate':
            return await this.handleNavigate(args as any);
          case 'browser_snapshot':
            return await this.handleSnapshot(args as any);
          case 'browser_action':
            return await this.handleAction(args as any);
          case 'browser_list_tabs':
            return await this.handleListTabs();
          case 'browser_screenshot':
            return await this.handleScreenshot(args as any);
          case 'browser_diagnostics':
            return await this.handleDiagnostics(args as any);
          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });
  }

  private async ensureSession(): Promise<string> {
    if (this.activeSessionId && this.browserCore.hasSession(this.activeSessionId)) {
      return this.activeSessionId;
    }
    if (!this.initialized) {
      await this.browserCore.initialize();
      this.initialized = true;
    }
    const sessionId = randomUUID();
    await this.browserCore.createSession(sessionId);
    this.stateManager.registerSession(sessionId);
    const page = this.browserCore.getPage(sessionId);
    await this.stateManager.injectAllTrackers(page, sessionId);
    this.activeSessionId = sessionId;
    return sessionId;
  }

  private async handleNavigate(args: { url: string }): Promise<any> {
    const sessionId = await this.ensureSession();
    await this.browserCore.navigate(sessionId, args.url);
    const page = this.browserCore.getPage(sessionId);
    this.stateManager.recordPageState(sessionId, {
      url: page.url(),
      title: await page.title(),
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'navigated',
            url: page.url(),
            title: await page.title(),
          }),
        },
      ],
    };
  }

  private async handleSnapshot(args: {
    max_elements?: number;
    snapshot_mode?: 'compact' | 'standard' | 'detailed';
    from_snapshot_id?: string;
    checksum?: string;
    delta_only?: boolean;
  }): Promise<any> {
    const sessionId = await this.ensureSession();
    const page = this.browserCore.getPage(sessionId);
    const tabs = await this.browserCore.listTabs(sessionId);
    const tabId = this.browserCore.getActiveTabId(sessionId);

    let previousSnapshot: SemanticSnapshot | undefined;
    if (args.from_snapshot_id) {
       const cached = this.lastSnapshots.get(sessionId);
       if (cached && cached.snapshot_id === args.from_snapshot_id) {
           // Concept §6.4 Checksum validation
           if (!args.checksum || cached.checksum === args.checksum) {
               previousSnapshot = cached;
           }
       }
    }

    const snapshot = await this.semanticLayer.createSnapshot(page, {
      session: {
        session_id: sessionId,
        tab_id: tabId,
        tabs_count: tabs.length,
        history_length: 0,
        cookies_count: 0,
      },
      maxElements: args.max_elements,
      previousSnapshot,
    });

    // Save for next delta request
    this.lastSnapshots.set(sessionId, snapshot);

    if (args.delta_only && snapshot.delta) {
       // Return conservative update
       const deltaResponse: any = {
          snapshot_id: snapshot.snapshot_id,
          version: snapshot.version,
          url: snapshot.url,
          title: snapshot.title,
          timestamp: snapshot.timestamp,
          checksum: snapshot.checksum,
          delta: snapshot.delta,
       };
       if (snapshot.delta.stats.actions_changed) {
          deltaResponse.available_actions = snapshot.available_actions;
       }
       return {
         content: [
           {
             type: 'text',
             text: JSON.stringify(deltaResponse, null, 2),
           },
         ],
       };
    }

    // For MCP clients, strip large binary data from full snapshot
    const cleanSnapshot = {
      ...snapshot,
      elements: snapshot.elements.map((el) => {
        const { boundingBox, options, rows, ...rest } = el as any;
        return rest;
      }),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(cleanSnapshot, null, 2),
        },
      ],
    };
  }

  private async handleAction(args: {
    action: string;
    target_id?: string;
    params?: any;
  }): Promise<any> {
    const sessionId = await this.ensureSession();
    const result = await this.actionExecutor.executeAction(
      sessionId,
      args.action,
      args.target_id,
      args.params
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleListTabs(): Promise<any> {
    const sessionId = await this.ensureSession();
    const tabs = await this.browserCore.listTabs(sessionId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ tabs }, null, 2),
        },
      ],
    };
  }

  private async handleScreenshot(args: { full_page?: boolean }): Promise<any> {
    const sessionId = await this.ensureSession();
    const result = await this.actionExecutor.executeAction(
      sessionId,
      'screenshot',
      undefined,
      { full_page: args.full_page ?? true }
    );

    return {
      content: [
        {
          type: 'image',
          data: result.data?.image,
          mimeType: 'image/png',
        },
      ],
    };
  }

  private async handleDiagnostics(args: { summary_only?: boolean }): Promise<any> {
    const report = args.summary_only ? this.dashboard.summary() : this.dashboard.report();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(report, null, 2),
        },
      ],
    };
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('LLM Browser MCP Server running on stdio');
  }

  async stop(): Promise<void> {
    if (this.activeSessionId) {
      await this.browserCore.closeSession(this.activeSessionId).catch(() => undefined);
    }
    await this.browserCore.close().catch(() => undefined);
  }
}
