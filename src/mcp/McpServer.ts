/**
 * MCP (Model Context Protocol) Server - Enhanced & Stabilized
 * ============================================================
 *
 * Full production-ready MCP server for LLM Browser with:
 * - Session cleanup on disconnect
 * - Browser crash recovery with respawn
 * - Action timeout with global timeout
 * - Snapshot size limit with chunking
 * - Resource limits (sessions, tabs, screenshots)
 * - Rate limiting with throttling
 * - Enhanced error context with LLM hints
 * - Multi-session support
 * - Smart tool descriptions
 * - Auto-snapshot after action
 * - Pagination helper tool
 * - Element search tool
 * - Config validation
 * - Health check improvements
 * - Structured JSON logging
 * - SSE transport support
 * - Security policy
 * - Cookie/persistence
 * - Request deduplication
 * - Progress events
 * - Connection health (ping/keepalive)
 * - Prometheus-compatible metrics
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EventEmitter } from 'events';
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
import { SemanticSnapshot, SemanticElement } from '../common/types';
import { randomUUID } from 'crypto';
import { DiagnosticsDashboard } from '../obs/DiagnosticsDashboard';
import { StateReconciler } from '../layer3_state_management/StateReconciler';
import { LlmBrowserError, classifyActionError } from '../common/errors';
import { globalMetrics } from '../common/MetricsRegistry';
import { globalEventBus } from '../common/EventBus';
import type { Request as ExpressRequest } from 'express';
import { Bouncer } from '../layer2_action_execution/Bouncer';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface SessionInfo {
  id: string;
  createdAt: number;
  lastActivity: number;
  actionCount: number;
  snapshotCount: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RequestDeduplicationEntry {
  hash: string;
  timestamp: number;
  result: any;
}

interface HealthStatus {
  status: 'ok' | 'degraded' | 'critical';
  browserAlive: boolean;
  sessionsActive: number;
  lastRecovery?: string;
  issues: string[];
}

interface ProgressEvent {
  tool: string;
  progress: number;
  message: string;
  startedAt: number;
}

interface SecurityPolicy {
  blockedDomains: Set<string>;
  allowedProtocols: Set<string>;
  maxRedirects: number;
}

interface MetricsSnapshot {
  timestamps: { uptime_seconds: number; server_start: string };
  requests: {
    total: number;
    by_tool: Record<string, number>;
    rate_limited: number;
    deduplicated: number;
  };
  browser: {
    crashes: number;
    recoveries: number;
    restarts: number;
  };
  sessions: {
    created: number;
    closed: number;
    active: number;
    max_concurrent: number;
  };
  errors: {
    total: number;
    by_code: Record<string, number>;
    by_class: Record<string, number>;
  };
  actions: {
    total: number;
    succeeded: number;
    failed: number;
    retries: number;
    avg_duration_ms: number;
  };
  snapshots: {
    total: number;
    cached: number;
    bytes_avg: number;
    truncated: number;
  };
}

// ============================================================================
// MCP SERVER - ENHANCED & STABILIZED
// ============================================================================

class McpServer {
  // Core components
  private server: Server;
  private browserCore: BrowserCore;
  private stateManager: StateManagementLayer;
  private actionExecutor: ActionExecutor;
  private semanticLayer: SemanticLayer;
  private dashboard: DiagnosticsDashboard;
  private bouncer: Bouncer;

  // Session management - Enhanced
  private activeSessionId: string | null = null;
  private sessions: Map<string, SessionInfo> = new Map();
  private initialized = false;
  private lastSnapshots: Map<string, SemanticSnapshot> = new Map();

  // Browser crash recovery
  private browserRestartAttempts = 0;
  private maxRestartAttempts = 3;
  private restartCooldownMs = 5000;
  private lastBrowserCrash: string | null = null;
  private browserHealthCheckInterval: ReturnType<typeof setTimeout> | null = null;

  // Timeouts
  private actionTimeoutMs = 30000; // 30 seconds default
  private snapshotTimeoutMs = 15000; // 15 seconds default
  private healthCheckIntervalMs = 30000; // 30 seconds

  // Resource limits
  private maxConcurrentSnapshots = 3;
  private activeSnapshotCount = 0;
  private maxScreenshotCache = 10;
  private screenshotCache: Map<string, { data: string; timestamp: number }> = new Map();

  // Rate limiting
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  private rateLimitWindowMs = 60000; // 1 minute
  private snapshotRateLimit = 60; // snapshots per minute
  private navigateRateLimit = 10; // navigates per minute
  private actionRateLimit = 120; // actions per minute

  // Request deduplication
  private requestCache: Map<string, RequestDeduplicationEntry> = new Map();
  private requestCacheTtlMs = 5000; // 5 seconds

  // Progress tracking
  private progressEmitter = new EventEmitter();
  private activeOperations: Map<string, ProgressEvent> = new Map();

  // Security policy
  private securityPolicy: SecurityPolicy = {
    blockedDomains: new Set([
      '0.0.0.0',
      'file://',
      'chrome://',
      'about:',
    ]),
    allowedProtocols: new Set(['http:', 'https:']),
    maxRedirects: 5,
  };

  // Configurable localhost setting
  private allowLocalhost = true;

  // Structured logging
  private logBuffer: any[] = [];
  private logFlushInterval: ReturnType<typeof setTimeout> | null = null;
  private structuredLoggingEnabled = true;

  // Metrics
  private serverStartTime = Date.now();
  private requestCount = 0;
  private errorCount = 0;
  private errorsByCode: Record<string, number> = {};
  private errorsByClass: Record<string, number> = {};
  private maxConcurrentSessions = 0;

  // SSE Transport support
  private sseConnections: Map<string, any> = new Map();
  private keepaliveInterval: ReturnType<typeof setTimeout> | null = null;

  // Graceful shutdown
  private isShuttingDown = false;
  private shutdownTimeout: ReturnType<typeof setTimeout> | null = null;

  // ============================================================
  // MEMORY MANAGEMENT - Multi-level Cleanup Strategy
  // ============================================================

  // Memory pressure tracking
  private memoryPressureLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
  private lastGcTimestamp = 0;
  private gcCooldownMs = 30000; // 30 seconds between GC attempts

  // Aggressive cleanup thresholds
  private memoryThresholds = {
    warning: 512 * 1024 * 1024,    // 512MB - start being careful
    critical: 1024 * 1024 * 1024, // 1GB - trigger cleanup
    maxElementsSoftLimit: 800,     // Soft limit for snapshots
    maxElementsHardLimit: 400,     // Hard limit under memory pressure
  };

  // Critical system tools that bypass resource limits for self-healing
  private readonly RESCUE_TOOLS = new Set([
    'browser_diagnostics',
    'browser_close_session',
    'browser_restart',
    'browser_ping',
    'browser_metrics',
    'browser_session_info',
  ]);

  constructor() {
    this.browserCore = new BrowserCore();
    this.stateManager = new StateManagementLayer();
    this.actionExecutor = new ActionExecutor(this.browserCore);
    this.bouncer = new Bouncer();

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
        version: '2.3.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.loadConfiguration();
    this.setupHandlers();
    this.setupEventHandlers();
    this.startHealthCheck();
    this.startStructuredLogging();
  }

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  private loadConfiguration(): void {
    const config = ConfigurationManager.getInstance().getConfig();

    this.actionTimeoutMs = config.server.timeout_ms || 30000;
    this.maxConcurrentSessions = config.server.max_sessions || 8;

    // Rate limits from config
    this.snapshotRateLimit = config.security.rate_limit_per_minute || 60;
    this.navigateRateLimit = config.security.navigate_rate_limit_per_minute || 10;
    this.actionRateLimit = config.security.rate_limit_per_minute || 120;

    // Domain blacklist from config
    const blacklist = config.security.domain_blacklist || [];
    blacklist.forEach((domain: string) => this.securityPolicy.blockedDomains.add(domain));

    // Configure localhost allowance based on environment
    this.allowLocalhost = process.env.NODE_ENV !== 'production';
    if (!this.allowLocalhost) {
      this.securityPolicy.blockedDomains.add('localhost');
      this.securityPolicy.blockedDomains.add('127.0.0.1');
      this.securityPolicy.blockedDomains.add('::1');
    }
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  private setupEventHandlers(): void {
    // Browser crash detection
    globalEventBus.subscribe('browser_crash', (event: any) => {
      this.handleBrowserCrash(event);
    });

    // Session close detection
    globalEventBus.subscribe('session_closed', (event: any) => {
      this.cleanupSession(event.session_id);
    });

    // Progress events
    this.progressEmitter.on('progress', (event: ProgressEvent) => {
      this.sendProgressNotification(event);
    });
  }

  // ============================================================================
  // TOOL DEFINITIONS - ENHANCED WITH SMART DESCRIPTIONS
  // ============================================================================

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // -------------------------------------------------------------------------
        // browser_navigate - Navigate to URL
        // -------------------------------------------------------------------------
        {
          name: 'browser_navigate',
          description:
            'Navigate the browser to a URL. ' +
            'TIP: For forms or search pages, combine with browser_action (type/submit) in sequence. ' +
            'TIP: After navigation, always use browser_snapshot to verify page loaded correctly. ' +
            'TIP: If navigation fails, check URL format and internet connection first. ' +
            'TIP: For SPAs or JavaScript-heavy pages, try wait_until: "networkidle" to wait for full load. ' +
            'TIP: Use timeout_ms to increase timeout for slow pages. ' +
            'Common use cases: Open search engine, navigate to product page, access login form.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The URL to navigate to. Must be http:// or https:// protocol.',
              },
              wait_until: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle'],
                description:
                  'When to consider navigation complete: ' +
                  '"load" (default) - wait for full page load including images/stylesheets, ' +
                  '"domcontentloaded" - wait for DOM parsed but not subresources, ' +
                  '"networkidle" - wait for no network requests for 500ms (best for SPAs).',
              },
              timeout_ms: {
                type: 'number',
                description:
                  'Navigation timeout in milliseconds (default: 30000). ' +
                  'Increase for slow pages, streaming content, or large SPAs.',
              },
            },
            required: ['url'],
          },
        },

        // -------------------------------------------------------------------------
        // browser_snapshot - Get semantic snapshot
        // -------------------------------------------------------------------------
        {
          name: 'browser_snapshot',
          description:
            'Get a semantic snapshot of the current page. Returns structured JSON with elements, ' +
            'available actions, forms, navigation info, and auth state. ' +
            'TIP: Use compact mode (max_elements: 100) for repeated calls to save tokens. ' +
            'TIP: Use delta_only with from_snapshot_id for incremental updates after actions. ' +
            'TIP: Check available_actions to find clickable elements, forms, links. ' +
            'TIP: If page is dynamic, wait 500ms after navigation before snapshot. ' +
            'TIP: Use element search first if you know what you need, then get detailed snapshot.',
          inputSchema: {
            type: 'object',
            properties: {
              max_elements: {
                type: 'number',
                description:
                  'Max elements to include (default: 500, max: 1500). ' +
                  'Lower values save tokens; higher values give more context.',
              },
              snapshot_mode: {
                type: 'string',
                enum: ['compact', 'standard', 'detailed'],
                description:
                  'Detail level: compact (minimal elements + actions), ' +
                  'standard (default balance), detailed (all fields including boundingBox).',
              },
              from_snapshot_id: {
                type: 'string',
                description:
                  'ID of the last snapshot received. Used to generate delta. ' +
                  'Include checksum for strict consistency validation.',
              },
              checksum: {
                type: 'string',
                description:
                  'Checksum of the last snapshot. Required for reliable delta mode. ' +
                  'Found in previous snapshot.meta.checksum field.',
              },
              delta_only: {
                type: 'boolean',
                description:
                  'If true, returns only changes since from_snapshot_id. ' +
                  'Saves 70-90% tokens on stable pages. Always returns available_actions.',
              },
              actionable_only: {
                type: 'boolean',
                description:
                  'If true, returns only actionable controls plus compact decision context ' +
                  '(forms, buttons, links, inputs, headings, cards, errors). Use for heavy sites.',
              },
              affordances: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Filter page by affordance: clickable, navigable, fillable, selectable, submittable, media, readable, visible.',
              },
              include_types: {
                type: 'array',
                items: { type: 'string' },
                description: 'Keep only these semantic element types in addition to affordance matches.',
              },
              exclude_types: {
                type: 'array',
                items: { type: 'string' },
                description: 'Drop these semantic element types from the response.',
              },
auto_bounce: {
                type: 'boolean',
                description:
                  'Automatically dismiss safe popups before extracting (default true). ' +
                  'Dismisses: cookie consent banners, newsletter sign-up popups, region/language selectors, ' +
                  'age verification modals, and similar non-critical overlays. ' +
                  'TIP: Disable (false) only when you need to interact with these elements intentionally.',
              },
            },
          },
        },

        // -------------------------------------------------------------------------
        // browser_action - Execute browser actions
        // -------------------------------------------------------------------------
{
          name: 'browser_action',
          description:
            'Execute a browser action on an element or page. This is the primary way to interact with web pages. ' +
            'TIP: First use browser_snapshot to find element IDs, then target them here. ' +
            'TIP: target_semantic allows zero-shot targeting without prior snapshot: "button with text Submit". ' +
            'TIP: Actions that modify DOM return an auto-snapshot (delta) for confirmation. ' +
            'TIP: Use go_back, refresh, scroll without target_id (page-level actions).',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description:
                  'The action to execute. Full list: ' +
                  'click, type, submit, select, hover, scroll, keyboard, interact, ' +
                  'fill_form, reset_form, clear_form, validate_form, ' +
                  'check, clear, clear_search, append, set_value, set_color, set_date, ' +
                  'go_back, go_forward, refresh, ' +
                  'screenshot, media_control, ' +
                  'open_tab, switch_tab, close_tab, set_viewport, ' +
                  'upload, download, wait, wait_for, evaluate, ' +
                  'multi_click, sequence, parallel, loop, if, try, ' +
                  'fill_and_verify, navigate_and_extract, login_flow, ' +
                  'define_script, call_script, ' +
                  'invalidate_cache, visual',
              },
              target_id: {
                type: 'string',
                description:
                  'Element ID from snapshot elements array. ' +
                  'Omit for page-level actions: go_back, go_forward, refresh, scroll, wait, list_tabs, set_viewport.',
              },
              target_semantic: {
                type: ['string', 'object'],
                description:
                  'Zero-shot target query without needing snapshot. ' +
                  'Examples: "button with text Add to Cart", {type:"input", label:"Email"}.',
              },
              params: {
                type: 'object',
                description:
                  'Action-specific parameters: ' +
                  'click: {button: "left"|"right"|"middle", click_count: 1|2} ' +
                  'type: {text: string, clear: boolean, delay: number, press_enter: boolean} ' +
                  'select: {value: string} or {label: string} ' +
                  'check: {checked: boolean} ' +
                  'clear/clear_search: {} (clears input field) ' +
                  'append: {text: string, delay: number} ' +
                  'set_value/set_color/set_date: {value: string} ' +
                  'fill_form: {form_id, fields: {name: value}, submit: boolean} ' +
                  'scroll: {direction: "up"|"down"|"left"|"right", amount: pixels} or {mode: "auto_scroll"} ' +
                  'keyboard: {key: "Enter"|"Escape"|"Tab"|"Backspace"|"F5"|"Control+A"} ' +
                  'screenshot: {full_page: boolean} (in-memory, see browser_screenshot for file download) ' +
                  'media_control: {command: "play"|"pause"|"seek", time_seconds?: number, volume?: number} ' +
                  'open_tab: {url?: string} ' +
                  'switch_tab: {tab_id: string} ' +
                  'close_tab: {tab_id?: string} ' +
                  'set_viewport: {width: number, height: number} ' +
                  'upload: {file_path: string} ' +
                  'download: {file_name: string} ' +
                  'wait/wait_for: {condition: string, timeout_ms: number} ' +
                  'evaluate: {script: string, args?: object} ' +
                  'go_back/go_forward: {} (no params needed) ' +
                  'refresh: {} (no params needed)',
              },
              auto_snapshot: {
                type: 'boolean',
                description:
                  'If true (default), automatically return snapshot after action. ' +
                  'Set to false to skip snapshot for faster sequential actions.',
              },
              delta_only: {
                type: 'boolean',
                description: 'When auto_snapshot is true, return only post-action delta when possible.',
              },
              actionable_only: {
                type: 'boolean',
                description: 'When auto_snapshot is true, use actionable-only post-action snapshot.',
              },
              affordances: {
                type: 'array',
                items: { type: 'string' },
                description: 'When auto_snapshot is true, filter post-action snapshot by affordances.',
              },
            },
            required: ['action'],
          },
        },

        // -------------------------------------------------------------------------
        // browser_run_flow - Run action chain in one round trip
        // -------------------------------------------------------------------------
{
          name: 'browser_run_flow',
          description:
            'Run a sequence of browser actions in one MCP call. Use this to avoid repeated LLM↔browser round trips. ' +
            'TIP: Steps support ALL browser_action actions: click, type, select, check, fill_form, etc. ' +
            'TIP: Use target_id or target_semantic for element targeting within each step. ' +
            'TIP: Useful for multi-step workflows like login, checkout, or form submission. ' +
            'TIP: Use stop_on_error: false to attempt all steps even if one fails.',
          inputSchema: {
            type: 'object',
            properties: {
              steps: {
                type: 'array',
                items: { type: 'object' },
                description: 'Array of steps: {action, target_id?, target_semantic?, params?}. Supports all browser_action actions.',
              },
              actions: {
                type: 'array',
                items: { type: 'object' },
                description: 'Alias for steps.',
              },
              stop_on_error: {
                type: 'boolean',
                description: 'Stop flow at first failed step (default true). Set false to attempt all steps.',
              },
              auto_snapshot: {
                type: 'boolean',
                description: 'Return final semantic snapshot after flow (default true).',
              },
              actionable_only: {
                type: 'boolean',
                description: 'Use actionable-only final snapshot.',
              },
              affordances: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter final snapshot by affordances.',
              },
              delta_only: {
                type: 'boolean',
                description: 'Return only final delta when possible.',
              },
            },
          },
        },

        // -------------------------------------------------------------------------
        // browser_evaluate - Execute JS snippet without snapshot
        // -------------------------------------------------------------------------
{
          name: 'browser_evaluate',
          description:
            'Evaluate a JavaScript expression/snippet in the page and return the serializable result without taking a snapshot. ' +
            'TIP: Access passed args in code via args.myKey (for example with args: {myKey: "value"}). ' +
            'TIP: Returns only serializable values (strings, numbers, arrays, objects). ' +
            'TIP: Use read_only: false only when you intentionally need to modify the page.',
          inputSchema: {
            type: 'object',
            properties: {
              script: {
                type: 'string',
                description: 'JavaScript expression or snippet to evaluate. Use return statement for multi-line.',
              },
              expression: {
                type: 'string',
                description: 'Alias for script.',
              },
              javascript: {
                type: 'string',
                description: 'Alias for script.',
              },
              args: {
                type: 'object',
                description:
                  'Optional parameters passed to the snippet. ' +
                  'Access in code: args.myParam (e.g. args.url, args.selector). ' +
                  'Example: script: "document.querySelector(args.selector).textContent" with args: {selector: ".title"}',
              },
              read_only: {
                type: 'boolean',
                description: 'Block mutating snippets when true (default true). Set false to allow DOM changes.',
              },
              timeout_ms: {
                type: 'number',
                description: 'Max runtime in ms (default: 1000). Increase for complex scripts.',
              },
            },
          },
        },

        // -------------------------------------------------------------------------
        // browser_visual - Visual screen with cursor overlay
        // -------------------------------------------------------------------------
        {
          name: 'browser_visual',
          description:
            'Return a viewport screenshot with the agent cursor overlay and last pointer position. ' +
            'Use to visually inspect what the browser is doing; set LLM_BROWSER_HEADLESS=false for a headed Playwright window.',
          inputSchema: {
            type: 'object',
            properties: {
              full_page: { type: 'boolean', description: 'Capture full page instead of viewport (default false).' },
              show_cursor: { type: 'boolean', description: 'Draw cursor overlay before capture (default true).' },
              timeout_ms: { type: 'number', description: 'Screenshot timeout.' },
            },
          },
        },

        // -------------------------------------------------------------------------
        // browser_list_tabs - List open tabs
        // -------------------------------------------------------------------------
        {
          name: 'browser_list_tabs',
          description:
            'List all open browser tabs with their URLs and titles. ' +
            'TIP: Use to find tab_id values for browser_switch_tab. ' +
            'TIP: Each tab has a unique tab_id like "tab-1", "tab-2", etc. — pass this to switch_tab. ' +
            'TIP: Active tab has active: true. Use this to confirm which tab you are in. ' +
            'TIP: Returns array sorted by creation order; most recently active is last.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },

        // -------------------------------------------------------------------------
        // browser_open_tab - Open new tab
        // -------------------------------------------------------------------------
        {
          name: 'browser_open_tab',
          description:
            'Open a new browser tab with an optional URL. ' +
            'TIP: The new tab automatically becomes the active tab. ' +
            'TIP: If URL is omitted, opens a blank tab. ' +
            'TIP: Returns the new tab info and updated list of all tabs. ' +
            'NOTE: Shares rate limit bucket with browser_navigate (navigating to a URL counts against the same limit). ' +
            'Common use cases: Open multiple search results, navigate to additional pages without losing current context.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description:
                  'Optional URL to open in the new tab. ' +
                  'Must be http:// or https:// if provided. ' +
                  'If omitted, opens a blank tab.',
              },
            },
            required: [],
          },
        },

        // -------------------------------------------------------------------------
        // browser_switch_tab - Switch to a different tab
        // -------------------------------------------------------------------------
        {
          name: 'browser_switch_tab',
          description:
            'Switch the browser to a different open tab. ' +
            'TIP: Use browser_list_tabs first to find the tab_id of the target tab. ' +
            'TIP: Returns the URL and title of the newly active tab. ' +
            'TIP: Use after browser_open_tab or when you need to work in a different tab. ' +
            'Common use cases: Review a previously opened tab, switch between multiple tasks.',
          inputSchema: {
            type: 'object',
            properties: {
              tab_id: {
                type: 'string',
                description:
                  'The ID of the tab to switch to. ' +
                  'Obtain this from browser_list_tabs response (tab_id field).',
              },
            },
            required: ['tab_id'],
          },
        },

        // -------------------------------------------------------------------------
        // browser_close_tab - Close a tab
        // -------------------------------------------------------------------------
        {
          name: 'browser_close_tab',
          description:
            'Close a browser tab. ' +
            'TIP: If tab_id is omitted, closes the currently active tab. ' +
            'TIP: Cannot close the last remaining tab. ' +
            'TIP: Returns which tab became active after closing. ' +
            'TIP: Use browser_list_tabs to confirm which tabs remain. ' +
            'Common use cases: Clean up temporary tabs, close finished tasks.',
          inputSchema: {
            type: 'object',
            properties: {
              tab_id: {
                type: 'string',
                description:
                  'Optional ID of the tab to close. ' +
                  'If omitted, closes the currently active tab.',
              },
            },
            required: [],
          },
        },

        // -------------------------------------------------------------------------
        // browser_screenshot - Take screenshot
        // -------------------------------------------------------------------------
        {
          name: 'browser_screenshot',
          description:
            'Take a screenshot of the current page. Returns base64-encoded PNG. ' +
            'TIP: Use full_page: false for faster viewport-only screenshot. ' +
            'TIP: Cache screenshots to avoid repeated captures of same page.',
          inputSchema: {
            type: 'object',
            properties: {
              full_page: {
                type: 'boolean',
                description: 'Capture full scrollable page (default: true).',
              },
              cache_key: {
                type: 'string',
                description:
                  'Optional cache key to avoid duplicate screenshots. ' +
                  'Cached screenshots are returned instantly.',
              },
            },
          },
        },

        // -------------------------------------------------------------------------
        // browser_diagnostics - System health
        // -------------------------------------------------------------------------
        {
          name: 'browser_diagnostics',
          description:
            'Get real-time system diagnostics, health scores, and session states. ' +
            'TIP: Use when encountering errors to check browser health. ' +
            'TIP: summary_only: true returns compact LLM-friendly format. ' +
            'Indicators: score > 0.8 (ok), 0.5-0.8 (degraded), < 0.5 (critical).',
          inputSchema: {
            type: 'object',
            properties: {
              summary_only: {
                type: 'boolean',
                description: 'If true, returns compact LLM-friendly summary (default: false).',
              },
            },
          },
        },

        // -------------------------------------------------------------------------
        // browser_element_search - NEW: Find elements without full snapshot
        // -------------------------------------------------------------------------
        {
          name: 'browser_element_search',
          description:
            'Find specific elements on the page by text, type, or attribute without reading full snapshot. ' +
            'TIP: Use for targeted searches when you know what you need. ' +
            'TIP: Much faster than full snapshot for simple lookups. ' +
            'TIP: Returns element IDs that can be used in browser_action. ' +
            'TIP: Searches across text, label, id, name, placeholder, and ariaLabel attributes.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'Search query to match against element text, label, id, name, placeholder, or ariaLabel.',
              },
              element_type: {
                type: 'string',
                description:
                  'Filter by element type: button, link, input, select, text, heading, ' +
                  'form, table, list, image, navigation, article, card, modal.',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return (default: 10, max: 50).',
              },
            },
            required: ['query'],
          },
        },

        // -------------------------------------------------------------------------
        // browser_paginate - NEW: Scroll and collect all items
        // -------------------------------------------------------------------------
        {
          name: 'browser_paginate',
          description:
            'Scroll through a list/pagination and collect all items. Use for infinite scroll pages. ' +
            'TIP: item_container is a CSS selector (e.g., ".product-item", "[data-product-id]"), NOT an element ID from snapshot. ' +
            'TIP: Without next_button, fetches only the first page of items. ' +
            'TIP: next_button: "infinite" enables automatic infinite scroll detection. ' +
            'TIP: Returns all collected items, page count, and has_more flag. ' +
            'TIP: Use wait_between_ms for pages that load content dynamically.',
          inputSchema: {
            type: 'object',
            properties: {
              item_container: {
                type: 'string',
                description:
                  'CSS selector for item container (e.g., ".product-item", "tr[data-id]", "[class*=card]"). ' +
                  'IMPORTANT: This is a CSS selector, not an element ID from browser_snapshot.',
              },
              next_button: {
                type: 'string',
                description:
                  'CSS selector for next/load-more button. ' +
                  'Set to "infinite" for auto-detection of infinite scroll pages. ' +
                  'Omit to collect items from current page only.',
              },
              max_pages: {
                type: 'number',
                description: 'Maximum pages to scroll through (default: 10, max: 50).',
              },
              wait_between_ms: {
                type: 'number',
                description: 'Wait time between scrolls in ms (default: 1000). Increase for slow-loading pages.',
              },
            },
            required: ['item_container'],
          },
        },

        // -------------------------------------------------------------------------
        // browser_wait_for - NEW: Smart waiting for element/condition
        // -------------------------------------------------------------------------
        {
          name: 'browser_wait_for',
          description:
            'Wait for a specific condition before proceeding. ' +
            'TIP: Use after actions that trigger async loading (clicks, submissions). ' +
            'TIP: More reliable than fixed delays - waits only as long as needed.',
          inputSchema: {
            type: 'object',
            properties: {
              condition: {
                type: 'string',
                description:
                  'Wait condition: ' +
                  'element_visible, element_hidden, element_enabled, element_stable, ' +
                  'page_loaded, network_idle, text_contains, url_contains. ' +
                  'element_enabled: wait until element is not disabled. ' +
                  'element_stable: wait until element stops animating/moving.',
              },
              target: {
                type: 'string',
                description: 'Element ID or CSS selector for element-based conditions.',
              },
              value: {
                type: 'string',
                description: 'Expected value for text_contains or url_contains conditions.',
              },
              timeout_ms: {
                type: 'number',
                description: 'Maximum wait time in ms (default: 10000, max: 60000).',
              },
            },
            required: ['condition'],
          },
        },

        // -------------------------------------------------------------------------
        // browser_session_info - NEW: Get current session state
        // -------------------------------------------------------------------------
        {
          name: 'browser_session_info',
          description:
            'Get current session information: session ID, URL, tab count, auth state. ' +
            'TIP: Useful to verify session is active before performing actions. ' +
            'TIP: Check authenticated flag for login-required pages.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },

        // -------------------------------------------------------------------------
        // browser_metrics - NEW: Prometheus-compatible metrics
        // -------------------------------------------------------------------------
        {
          name: 'browser_metrics',
          description:
            'Get Prometheus-compatible metrics in text format. ' +
            'Use for monitoring dashboards (Grafana, Datadog, etc.). ' +
            'TIP: Metrics include request counts, latencies, error rates, cache stats.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },

        // -------------------------------------------------------------------------
        // browser_close_session - NEW: Explicitly close session
        // -------------------------------------------------------------------------
        {
          name: 'browser_close_session',
          description:
            'Explicitly close the current browser session and cleanup resources. ' +
            'TIP: Call when done with task to free browser resources. ' +
            'TIP: New session will be created on next request.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },

        // -------------------------------------------------------------------------
        // browser_restart - NEW: Restart browser if stuck
        // -------------------------------------------------------------------------
        {
          name: 'browser_restart',
          description:
            'Restart the browser instance. Use when browser is stuck or unresponsive. ' +
            'TIP: Last resort action - try browser_diagnostics first. ' +
            'TIP: Current session will be lost; new session will be created.',
          inputSchema: {
            type: 'object',
            properties: {
              reason: {
                type: 'string',
                description: 'Optional reason for restart (for logging).',
              },
            },
          },
        },

        // -------------------------------------------------------------------------
        // browser_ping - NEW: Connection health check
        // -------------------------------------------------------------------------
        {
          name: 'browser_ping',
          description:
            'Check connection health and get server status. ' +
            'TIP: Use to verify MCP server is responsive. ' +
            'TIP: Returns server uptime and active session count.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    // ============================================================================
    // TOOL EXECUTION HANDLER
    // ============================================================================

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const startTime = Date.now();
      const { name, arguments: args } = request.params;

      this.requestCount++;
      globalMetrics.increment('llm_browser_mcp_requests_total');

      // Structured log request
      this.logStructured('request_start', {
        tool: name,
        args: this.sanitizeForLogging(args),
        timestamp: new Date().toISOString(),
      });

      try {
        // ============================================================
        // RESCUE TOOLS - Always allowed, bypass all checks
        // ============================================================
        const isRescue = this.isRescueTool(name);

        // Check rate limits (skip for rescue tools)
        if (!isRescue && !this.checkRateLimit(name)) {
          const error = this.createRateLimitedError(name);
          this.recordError(error);
          return this.formatErrorResponse(error);
        }

        // For heavy operations, check memory and potentially cleanup
        if (!isRescue && (name === 'browser_snapshot' || name === 'browser_paginate')) {
          // Assess memory pressure before heavy operation
          this.memoryPressureLevel = this.assessMemoryPressure();

          // Perform smart cleanup if needed
          if (this.memoryPressureLevel !== 'low') {
            this.logStructured('pre_operation_memory_check', {
              tool: name,
              pressure: this.memoryPressureLevel,
              memory: this.getMemoryUsage(),
            });
            await this.performSmartCleanup();
          }
        }

        // Ensure session exists (skip for rescue tools that don't need browser)
        if (!isRescue || name === 'browser_close_session' || name === 'browser_restart') {
          await this.ensureSession();
        } else if (name === 'browser_session_info' || name === 'browser_ping' || name === 'browser_metrics' || name === 'browser_diagnostics') {
          // These tools can work even without a session
        }

        // Execute with timeout
        let result;
        const timeoutMs = this.getTimeoutForTool(name);

        const resultPromise = this.executeTool(name, args || {});
        const timeoutPromise = this.timeoutPromise(timeoutMs, name);

        try {
          result = await Promise.race([resultPromise, timeoutPromise]);
        } catch (error: any) {
          if (error.name === 'TimeoutError') {
            const timeoutError = this.createTimeoutError(name, timeoutMs);
            this.recordError(timeoutError);
            return this.formatErrorResponse(timeoutError);
          }
          throw error;
        }

        // Record success metrics
        const durationMs = Date.now() - startTime;
        this.recordSuccess(name, durationMs);

        // Log success
        this.logStructured('request_complete', {
          tool: name,
          duration_ms: durationMs,
          timestamp: new Date().toISOString(),
        });

        return result;

      } catch (error: any) {
        const durationMs = Date.now() - startTime;

        // Record error metrics
        this.recordError(error);

        // Log error
        this.logStructured('request_error', {
          tool: name,
          error: error.message,
          error_code: error.code,
          duration_ms: durationMs,
          timestamp: new Date().toISOString(),
        });

        return this.formatErrorResponse(error);

      } finally {
        // Cleanup progress tracking
        this.activeOperations.delete(name);
      }
    });
  }

  // ============================================================================
  // TOOL EXECUTION
  // ============================================================================

  private async executeTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'browser_navigate':
        return await this.handleNavigate(args);

      case 'browser_snapshot':
        return await this.handleSnapshot(args);

      case 'browser_action':
        return await this.handleAction(args);

      case 'browser_run_flow':
        return await this.handleRunFlow(args);

      case 'browser_evaluate':
        return await this.handleEvaluate(args);

      case 'browser_visual':
        return await this.handleVisual(args);

      case 'browser_list_tabs':
        return await this.handleListTabs();

      case 'browser_open_tab':
        return await this.handleOpenTab(args);

      case 'browser_switch_tab':
        return await this.handleSwitchTab(args);

      case 'browser_close_tab':
        return await this.handleCloseTab(args);

      case 'browser_screenshot':
        return await this.handleScreenshot(args);

      case 'browser_diagnostics':
        return await this.handleDiagnostics(args);

      case 'browser_element_search':
        return await this.handleElementSearch(args);

      case 'browser_paginate':
        return await this.handlePaginate(args);

      case 'browser_wait_for':
        return await this.handleWaitFor(args);

      case 'browser_session_info':
        return await this.handleSessionInfo();

      case 'browser_metrics':
        return await this.handleMetrics();

      case 'browser_close_session':
        return await this.handleCloseSession();

      case 'browser_restart':
        return await this.handleRestart(args);

      case 'browser_ping':
        return await this.handlePing();

      default:
        throw this.createUnknownToolError(name);
    }
  }

  // ============================================================================
  // TOOL HANDLERS
  // ============================================================================

  private async handleNavigate(args: { url: string }): Promise<any> {
    this.emitProgress('browser_navigate', 0, 'Validating URL...');

    // Security check
    this.validateUrl(args.url);

    // Rate limit check for navigation (using consistent tool name)
    if (!this.checkRateLimit('browser_navigate')) {
      throw this.createRateLimitedError('browser_navigate');
    }

    const sessionId = await this.ensureSession();

    this.emitProgress('browser_navigate', 25, 'Navigating...');

    try {
      await this.browserCore.navigate(sessionId, args.url);
      const page = this.browserCore.getPage(sessionId);

      this.emitProgress('browser_navigate', 75, 'Page loaded, recording state...');
      const bouncer = await this.bouncer.dismiss(page).catch(() => undefined);

      this.stateManager.recordPageState(sessionId, {
        url: page.url(),
        title: await page.title(),
      });

      this.emitProgress('browser_navigate', 100, 'Navigation complete');

      // Update session activity
      this.updateSessionActivity(sessionId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'navigated',
              url: page.url(),
              title: await page.title(),
              bouncer,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      };
    } catch (error: any) {
      throw this.enhanceError(error, 'navigation', {
        url: args.url,
        suggestion: 'Check URL format (must start with http:// or https://) and internet connection',
      });
    }
  }

  private async handleSnapshot(args: {
    max_elements?: number;
    snapshot_mode?: 'compact' | 'standard' | 'detailed';
    from_snapshot_id?: string;
    checksum?: string;
    delta_only?: boolean;
    actionable_only?: boolean;
    actionableOnly?: boolean;
    affordances?: string[];
    include_types?: string[];
    includeTypes?: string[];
    exclude_types?: string[];
    excludeTypes?: string[];
    auto_bounce?: boolean;
  }): Promise<any> {
    // Check concurrent snapshot limit
    if (this.activeSnapshotCount >= this.maxConcurrentSnapshots) {
      throw new LlmBrowserError(
        'RATE_LIMIT_EXCEEDED',
        'Too many concurrent snapshot requests. Please wait for current snapshot to complete.',
        { max_concurrent: this.maxConcurrentSnapshots }
      );
    }

    this.activeSnapshotCount++;
    this.emitProgress('browser_snapshot', 0, 'Capturing snapshot...');

    try {
      const sessionId = await this.ensureSession();
      const page = this.browserCore.getPage(sessionId);
      const tabs = await this.browserCore.listTabs(sessionId);
      const tabId = this.browserCore.getActiveTabId(sessionId);
      const bouncer = await this.bouncer.dismiss(page, { enabled: args.auto_bounce !== false }).catch(() => undefined);

      this.emitProgress('browser_snapshot', 25, 'Extracting semantic data...');

      // Get previous snapshot for delta
      let previousSnapshot: SemanticSnapshot | undefined;
      if (args.from_snapshot_id) {
        const cached = this.lastSnapshots.get(sessionId);
        if (cached && cached.snapshot_id === args.from_snapshot_id) {
          if (!args.checksum || cached.checksum === args.checksum) {
            previousSnapshot = cached;
          }
        }
      }

      // Check request deduplication
      const requestHash = this.hashSnapshotRequest(args);
      const cachedResult = this.getCachedResult(requestHash);
      if (cachedResult) {
        this.logStructured('snapshot_cache_hit', { from_snapshot_id: args.from_snapshot_id });
        return cachedResult;
      }

      // Apply adaptive max elements based on memory pressure
      const adaptiveMaxElements = this.getAdaptiveMaxElements(args.max_elements);

      // For heavy sites (Amazon-like), use aggressive limits
      const isHeavySite = this.isHeavySite(page.url());
      const effectiveMaxElements = isHeavySite
        ? Math.min(adaptiveMaxElements, 300) // Heavy sites cap at 300
        : adaptiveMaxElements;

      this.logStructured('snapshot_config', {
        requested_max_elements: args.max_elements,
        adaptive_max_elements: adaptiveMaxElements,
        effective_max_elements: effectiveMaxElements,
        is_heavy_site: isHeavySite,
        memory_pressure: this.memoryPressureLevel,
      });

      const snapshot = await this.semanticLayer.createSnapshot(page, {
        session: {
          session_id: sessionId,
          tab_id: tabId,
          tabs_count: tabs.length,
          history_length: 0,
          cookies_count: 0,
        },
        maxElements: effectiveMaxElements,
        previousSnapshot,
        snapshotMode: args.snapshot_mode || 'standard',
        ...this.snapshotFilters(args),
      });
      if (bouncer && snapshot.meta) {
        snapshot.meta.bouncer = {
          attempted: bouncer.attempted,
          closed: bouncer.closed,
          duration_ms: bouncer.duration_ms,
          actions: bouncer.actions,
        };
      }

      this.emitProgress('browser_snapshot', 75, 'Processing snapshot...');

      // Save for delta
      this.lastSnapshots.set(sessionId, snapshot);

      // Check snapshot size and truncate if needed
      const snapshotJson = JSON.stringify(snapshot);
      const snapshotBytes = new TextEncoder().encode(snapshotJson).length;

      let cleanSnapshot = snapshot;
      let truncatedCount = 0;

      if (snapshotBytes > 900_000) { // ~1MB limit for MCP messages
        cleanSnapshot = this.truncateSnapshot(snapshot, args.snapshot_mode || 'standard');
        truncatedCount = snapshot.elements.length;
        globalMetrics.increment('llm_browser_snapshots_truncated_total');
      }

      // Strip internal fields
      cleanSnapshot = this.stripInternalFields(cleanSnapshot);

      // Add metadata
      cleanSnapshot.meta = cleanSnapshot.meta || {};
      cleanSnapshot.meta.snapshot_bytes = snapshotBytes;
      cleanSnapshot.meta.truncated = truncatedCount;

      this.emitProgress('browser_snapshot', 100, 'Snapshot complete');

      // Handle delta_only mode
      if (args.delta_only && previousSnapshot && cleanSnapshot.delta) {
        const deltaOnlyResult = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                meta: cleanSnapshot.meta,
                delta: cleanSnapshot.delta,
                available_actions: cleanSnapshot.available_actions,
              }, null, 2),
            },
          ],
        };
        this.cacheResult(requestHash, deltaOnlyResult);
        return deltaOnlyResult;
      }

      // Cache for deduplication
      const result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(cleanSnapshot, null, 2),
          },
        ],
      };
      this.cacheResult(requestHash, result);

      // Update session metrics
      const session = this.sessions.get(sessionId);
      if (session) {
        session.snapshotCount++;
      }

      globalMetrics.increment('llm_browser_snapshots_total');

      return result;

    } catch (error: any) {
      throw this.enhanceError(error, 'snapshot', {
        suggestion: 'Try reducing max_elements or using compact mode',
      });
    } finally {
      this.activeSnapshotCount--;
    }
  }

  private async handleAction(args: {
    action: string;
    target_id?: string;
    target_semantic?: string | Record<string, any>;
    params?: any;
    auto_snapshot?: boolean;
    delta_only?: boolean;
    actionable_only?: boolean;
    actionableOnly?: boolean;
    affordances?: string[];
  }): Promise<any> {
    const autoSnapshot = args.auto_snapshot !== false;

    this.emitProgress('browser_action', 0, `Executing ${args.action}...`);

    const sessionId = await this.ensureSession();

    try {
      this.emitProgress('browser_action', 25, 'Validating action...');

      const result = await this.actionExecutor.executeAction(
        sessionId,
        args.action,
        args.target_id,
        {
          ...(args.params ?? {}),
          ...(args.target_semantic !== undefined ? { target_semantic: args.target_semantic } : {}),
        }
      );

      this.emitProgress('browser_action', 75, 'Action completed');

      // Update session activity
      this.updateSessionActivity(sessionId);

      const response: any = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              action: args.action,
              target_id: args.target_id,
              duration_ms: result.duration_ms,
              ...result.data,
            }),
          },
        ],
      };

      // Auto-snapshot if requested
      if (autoSnapshot) {
        this.emitProgress('browser_action', 85, 'Capturing post-action snapshot...');

        try {
          const snapshot = await this.getQuickSnapshot(sessionId, args);
          response.content[0].text = JSON.stringify({
            action_result: JSON.parse(response.content[0].text),
            ...(args.delta_only && snapshot.delta
              ? { post_action_delta: { meta: snapshot.meta, delta: snapshot.delta, available_actions: snapshot.available_actions } }
              : { post_action_snapshot: snapshot }),
          }, null, 2);
        } catch (snapshotError: any) {
          // Include error but don't fail the action
          response.content[0].text = JSON.stringify({
            action_result: JSON.parse(response.content[0].text),
            snapshot_warning: `Auto-snapshot failed: ${snapshotError.message}`,
          }, null, 2);
        }
      }

      this.emitProgress('browser_action', 100, 'Complete');

      globalMetrics.increment('llm_browser_actions_succeeded_total');

      return response;

    } catch (error: any) {
      globalMetrics.increment('llm_browser_actions_failed_total');

      const enhancedError = this.enhanceError(error, args.action, {
        action: args.action,
        target_id: args.target_id,
        suggestion: this.getActionSuggestion(args.action, args.target_id),
      });

      throw enhancedError;
    }
  }

  private async handleRunFlow(args: {
    steps?: any[];
    actions?: any[];
    stop_on_error?: boolean;
    auto_snapshot?: boolean;
    delta_only?: boolean;
    actionable_only?: boolean;
    actionableOnly?: boolean;
    affordances?: string[];
  }): Promise<any> {
    const sessionId = await this.ensureSession();
    const steps = args.steps ?? args.actions;
    if (!Array.isArray(steps)) {
      throw new LlmBrowserError('MISSING_PARAM', 'browser_run_flow requires steps or actions');
    }

    const previousSnapshot = this.lastSnapshots.get(sessionId);
    const result = await this.actionExecutor.executeAction(sessionId, 'sequence', undefined, {
      steps: steps.map((step) => ({
        ...step,
        params: {
          ...(step.params ?? step.action_params ?? step.parameters ?? {}),
          ...(step.target_semantic !== undefined ? { target_semantic: step.target_semantic } : {}),
        },
      })),
      stop_on_error: args.stop_on_error,
    });

    this.updateSessionActivity(sessionId);

    const payload: Record<string, any> = {
      status: 'success',
      mode: 'flow',
      duration_ms: result.duration_ms,
      ...result.data,
    };

    if (args.auto_snapshot !== false) {
      const snapshot = await this.getQuickSnapshot(sessionId, {
        ...args,
        previousSnapshot,
      } as any);
      if (args.delta_only && snapshot.delta) {
        payload.final_delta = {
          meta: snapshot.meta,
          delta: snapshot.delta,
          available_actions: snapshot.available_actions,
        };
      } else {
        payload.final_snapshot = snapshot;
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async handleEvaluate(args: {
    script?: string;
    expression?: string;
    javascript?: string;
    args?: Record<string, any>;
    read_only?: boolean;
    timeout_ms?: number;
  }): Promise<any> {
    const sessionId = await this.ensureSession();
    const result = await this.actionExecutor.executeAction(sessionId, 'evaluate', undefined, args);
    this.updateSessionActivity(sessionId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            ...result.data,
          }, null, 2),
        },
      ],
    };
  }

  private async handleVisual(args: {
    full_page?: boolean;
    show_cursor?: boolean;
    timeout_ms?: number;
  }): Promise<any> {
    const sessionId = await this.ensureSession();
    const result = await this.actionExecutor.executeAction(sessionId, 'visual', undefined, args);
    const config = ConfigurationManager.getInstance().getConfig().browser;
    return {
      content: [
        {
          type: 'image',
          data: result.data?.image,
          mimeType: 'image/png',
        },
        {
          type: 'text',
          text: JSON.stringify({
            cursor: result.data?.cursor,
            viewport: result.data?.viewport,
            url: result.data?.url,
            title: result.data?.title,
            headless: config.headless,
            headed_hint: config.headless ? 'Set LLM_BROWSER_HEADLESS=false before starting MCP to see a live Playwright window.' : undefined,
          }, null, 2),
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
          text: JSON.stringify({
            tabs,
            count: tabs.length,
            active_tab: this.browserCore.getActiveTabId(sessionId),
          }, null, 2),
        },
      ],
    };
  }

  private async handleOpenTab(args: { url?: string }): Promise<any> {
    // Validate URL if provided
    if (args.url) {
      this.validateUrl(args.url);
      if (!this.checkRateLimit('browser_open_tab')) {
        throw this.createRateLimitedError('browser_open_tab');
      }
    }

    const sessionId = await this.ensureSession();

    try {
      const newTab = await this.browserCore.openTab(sessionId, args.url);
      const allTabs = await this.browserCore.listTabs(sessionId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'tab_opened',
              new_tab: newTab,
              tabs: allTabs,
              tabs_count: allTabs.length,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw this.enhanceError(error, 'open_tab', {
        suggestion: 'Check if URL is valid. Ensure you haven\'t reached maximum tab limit.',
      });
    }
  }

  private async handleSwitchTab(args: { tab_id: string }): Promise<any> {
    if (!args.tab_id) {
      throw new LlmBrowserError('MISSING_PARAM', 'tab_id is required for browser_switch_tab');
    }

    const sessionId = await this.ensureSession();

    try {
      const switchedTab = await this.browserCore.switchTab(sessionId, args.tab_id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'tab_switched',
              active_tab: switchedTab,
              url: switchedTab.url,
              title: switchedTab.title,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw this.enhanceError(error, 'switch_tab', {
        suggestion: 'Use browser_list_tabs to get valid tab IDs first.',
      });
    }
  }

  private async handleCloseTab(args: { tab_id?: string }): Promise<any> {
    const sessionId = await this.ensureSession();

    try {
      const result = await this.browserCore.closeTab(sessionId, args.tab_id);
      const allTabs = await this.browserCore.listTabs(sessionId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'tab_closed',
              closed_tab_id: result.closed_tab_id,
              active_tab: result.active_tab,
              remaining_tabs: allTabs,
              remaining_count: allTabs.length,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw this.enhanceError(error, 'close_tab', {
        suggestion: 'You cannot close the last remaining tab. Use browser_list_tabs to check your tabs.',
      });
    }
  }

  private async handleScreenshot(args: { full_page?: boolean; cache_key?: string }): Promise<any> {
    // Check cache
    if (args.cache_key && this.screenshotCache.has(args.cache_key)) {
      const cached = this.screenshotCache.get(args.cache_key)!;
      if (Date.now() - cached.timestamp < 30000) { // 30 second cache
        return {
          content: [
            {
              type: 'image',
              data: cached.data,
              mimeType: 'image/png',
            },
          ],
          _cached: true,
        };
      }
    }

    const sessionId = await this.ensureSession();
    const result = await this.actionExecutor.executeAction(
      sessionId,
      'screenshot',
      undefined,
      { full_page: args.full_page ?? true }
    );

    // Cache if key provided
    if (args.cache_key && result.data?.image) {
      this.screenshotCache.set(args.cache_key, {
        data: result.data.image,
        timestamp: Date.now(),
      });

      // Cleanup old cache entries
      if (this.screenshotCache.size > this.maxScreenshotCache) {
        const oldestKey = this.screenshotCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.screenshotCache.delete(oldestKey);
        }
      }
    }

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
    const health = this.getHealthStatus();
    const memory = this.getMemoryUsage();
    this.memoryPressureLevel = this.assessMemoryPressure();

    if (args.summary_only) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: health.status,
              score: health.browserAlive ? (health.sessionsActive > 0 ? 0.9 : 0.7) : 0.3,
              browser: health.browserAlive ? 'ok' : 'dead',
              sessions: health.sessionsActive,
              memory: {
                pressure: this.memoryPressureLevel,
                heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024),
                rss_mb: Math.round(memory.rss / 1024 / 1024),
              },
              issues: health.issues.length > 0 ? health.issues : undefined,
              recommendations: this.getMemoryRecommendations(),
            }, null, 2),
          },
        ],
      };
    }

    const report = this.dashboard.report();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...report,
            memory: {
              pressure: this.memoryPressureLevel,
              heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024),
              heap_total_mb: Math.round(memory.heapTotal / 1024 / 1024),
              rss_mb: Math.round(memory.rss / 1024 / 1024),
              threshold_warning_mb: Math.round(this.memoryThresholds.warning / 1024 / 1024),
              threshold_critical_mb: Math.round(this.memoryThresholds.critical / 1024 / 1024),
            },
            caches: {
              snapshots: this.lastSnapshots.size,
              screenshots: this.screenshotCache.size,
              requests: this.requestCache.size,
            },
            recommendations: this.getMemoryRecommendations(),
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Get memory-related recommendations for the user
   */
  private getMemoryRecommendations(): string[] {
    const recommendations: string[] = [];

    switch (this.memoryPressureLevel) {
      case 'critical':
        recommendations.push('CRITICAL: Memory nearly exhausted. Use browser_restart immediately.');
        recommendations.push('Consider using browser_close_session to free resources.');
        break;
      case 'high':
        recommendations.push('HIGH: Memory pressure detected.');
        recommendations.push('Use compact snapshots (max_elements: 100) to reduce memory usage.');
        recommendations.push('browser_restart recommended if performance degrades.');
        break;
      case 'medium':
        recommendations.push('MEDIUM: Moderate memory usage.');
        recommendations.push('Consider using delta_only snapshots to reduce data transfer.');
        break;
      default:
        recommendations.push('LOW: Memory usage normal.');
    }

    return recommendations;
  }

  private async handleElementSearch(args: {
    query: string;
    element_type?: string;
    limit?: number;
  }): Promise<any> {
    const sessionId = await this.ensureSession();

    // Get a quick snapshot focused on finding elements
    const snapshot = await this.semanticLayer.createSnapshot(
      this.browserCore.getPage(sessionId),
      {
        session: {
          session_id: sessionId,
          tab_id: this.browserCore.getActiveTabId(sessionId),
          tabs_count: 1,
          history_length: 0,
          cookies_count: 0,
        },
        maxElements: 500, // Limited to speed up search
      }
    );

    const query = args.query.toLowerCase();
    const limit = Math.min(args.limit || 10, 50);

    const matches = snapshot.elements
      .filter(el => {
        // Filter by type
        if (args.element_type && el.type !== args.element_type) {
          return false;
        }

        // Search in text, label, id
        const searchText = [
          el.text,
          el.label,
          el.id,
          (el as any).name,
          (el as any).placeholder,
          (el as any).ariaLabel,
        ].filter(Boolean).join(' ').toLowerCase();

        return searchText.includes(query);
      })
      .slice(0, limit)
      .map(el => ({
        id: el.id,
        type: el.type,
        label: el.label,
        text: el.text?.substring(0, 100), // Truncate long text
        visible: el.visible,
        disabled: el.disabled,
      }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            matches: matches.length,
            results: matches,
          }, null, 2),
        },
      ],
    };
  }

  private async handlePaginate(args: {
    item_container: string;
    next_button?: string;
    max_pages?: number;
    wait_between_ms?: number;
  }): Promise<any> {
    const sessionId = await this.ensureSession();
    const page = this.browserCore.getPage(sessionId);
    const maxPages = Math.min(args.max_pages || 10, 50);
    const waitMs = args.wait_between_ms || 1000;

    const allItems: any[] = [];

    for (let i = 0; i < maxPages; i++) {
      this.emitProgress('browser_paginate', (i / maxPages) * 100, `Scrolling page ${i + 1}/${maxPages}...`);

      // Use SemanticLayer for proper semantic extraction
      const snapshot = await this.semanticLayer.createSnapshot(page, {
        session: {
          session_id: sessionId,
          tab_id: this.browserCore.getActiveTabId(sessionId),
          tabs_count: 1,
          history_length: 0,
          cookies_count: 0,
        },
        maxElements: 500,
      });

      // Find items matching the container selector
      const containerElement = snapshot.elements.find(el =>
        (el as any).selector?.includes(args.item_container) ||
        el.id?.includes(args.item_container.replace(/[.#]/g, ''))
      );

      if (containerElement) {
        // Find all child elements of the container
        const childElements = snapshot.elements.filter(el =>
          el.parent_id === containerElement.id ||
          (el as any).container_id === containerElement.id
        );

        allItems.push(...childElements.slice(0, 50).map((el, idx) => ({
          index: allItems.length + idx,
          id: el.id,
          type: el.type,
          label: el.label,
          text: el.text?.substring(0, 200),
        })));
      }

      // Check for next button
      if (args.next_button === 'infinite') {
        // Infinite scroll detection
        const sentinel = await page.locator('[data-infinite-sentinel], .infinite-sentinel').first();
        if (await sentinel.count() === 0) {
          // No more content indicator
          break;
        }
      } else if (args.next_button) {
        const nextBtn = page.locator(args.next_button);
        if (await nextBtn.count() === 0) {
          break; // No next button found
        }

        const isDisabled = await nextBtn.isDisabled();
        if (isDisabled) {
          break; // Next button is disabled, end of pagination
        }

        await nextBtn.click();
      }

      // Wait for new content
      await page.waitForTimeout(waitMs);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            items_collected: allItems.length,
            pages_scrolled: maxPages,
            has_more: allItems.length >= maxPages * 20, // Estimate
            items: allItems,
          }, null, 2),
        },
      ],
    };
  }

  private async handleWaitFor(args: {
    condition: string;
    target?: string;
    value?: string;
    timeout_ms?: number;
  }): Promise<any> {
    const sessionId = await this.ensureSession();
    const page = this.browserCore.getPage(sessionId);
    const timeoutMs = Math.min(args.timeout_ms || 10000, 60000);

    try {
      switch (args.condition) {
        case 'element_visible':
          await page.waitForSelector(args.target!, { timeout: timeoutMs, state: 'visible' });
          break;

        case 'element_hidden':
          await page.waitForSelector(args.target!, { timeout: timeoutMs, state: 'hidden' });
          break;

        case 'page_loaded':
          await page.waitForLoadState('load', { timeout: timeoutMs });
          break;

        case 'network_idle':
          await page.waitForLoadState('networkidle', { timeout: timeoutMs });
          break;

        case 'text_contains':
          await page.waitForFunction(
            (text: string | undefined) => text && document.body.innerText.includes(text),
            args.value,
            { timeout: timeoutMs }
          );
          break;

        case 'url_contains':
          await page.waitForFunction(
            (text: string | undefined) => text && window.location.href.includes(text),
            args.value,
            { timeout: timeoutMs }
          );
          break;

        default:
          throw new Error(`Unknown wait condition: ${args.condition}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'condition_met',
              condition: args.condition,
              target: args.target,
              wait_time_ms: timeoutMs,
            }),
          },
        ],
      };

    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'condition_not_met',
              condition: args.condition,
              target: args.target,
              timeout_ms: timeoutMs,
              error: error.message,
            }),
          },
        ],
        isError: false, // Don't mark as error - it's a valid state
      };
    }
  }

  private async handleSessionInfo(): Promise<any> {
    if (!this.activeSessionId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              has_session: false,
              sessions_available: true,
            }),
          },
        ],
      };
    }

    const session = this.sessions.get(this.activeSessionId);
    const page = this.browserCore.getPage(this.activeSessionId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            has_session: true,
            session_id: this.activeSessionId,
            current_url: page.url(),
            title: await page.title(),
            tabs_count: (await this.browserCore.listTabs(this.activeSessionId)).length,
            action_count: session?.actionCount || 0,
            snapshot_count: session?.snapshotCount || 0,
            idle_seconds: session
              ? Math.round((Date.now() - session.lastActivity) / 1000)
              : undefined,
          }, null, 2),
        },
      ],
    };
  }

  private async handleMetrics(): Promise<any> {
    const metrics = this.getPrometheusMetrics();

    return {
      content: [
        {
          type: 'text',
          text: metrics,
        },
      ],
    };
  }

  private async handleCloseSession(): Promise<any> {
    if (this.activeSessionId) {
      await this.browserCore.closeSession(this.activeSessionId).catch(() => undefined);
      this.sessions.delete(this.activeSessionId);
      this.lastSnapshots.delete(this.activeSessionId);
      this.activeSessionId = null;
      this.initialized = false;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'session_closed',
            message: 'Browser session closed. New session will be created on next request.',
          }),
        },
      ],
    };
  }

  private async handleRestart(args: { reason?: string }): Promise<any> {
    this.logStructured('browser_restart_requested', {
      reason: args.reason,
      timestamp: new Date().toISOString(),
      memory_before: this.getMemoryUsage(),
    });

    // Close existing sessions
    if (this.activeSessionId) {
      await this.browserCore.closeSession(this.activeSessionId).catch(() => undefined);
    }

    // Close browser
    await this.browserCore.close().catch(() => undefined);

    // ============================================================
    // FULL MEMORY CLEANUP ON RESTART
    // ============================================================

    // Reset state - clear all components
    this.activeSessionId = null;
    this.initialized = false;
    this.sessions.clear();
    this.lastSnapshots.clear();
    this.rateLimits.clear();
    this.requestCache.clear();
    this.screenshotCache.clear();
    this.sseConnections.clear();
    this.logBuffer = [];

    // Clear semantic layer caches
    try {
      const { globalSemCache } = await import('../cache/Sem');
      globalSemCache.clear();
      this.logStructured('semantic_cache_cleared', {});
    } catch {
      // Cache module may not be available
    }

    // Re-initialize browser
    await this.browserCore.initialize();
    this.initialized = true;

    // Re-create actionExecutor (it holds ref to browserCore)
    this.actionExecutor = new ActionExecutor(this.browserCore);
    this.browserRestartAttempts = 0;

    // Reset memory pressure
    this.memoryPressureLevel = 'low';

    // Trigger garbage collection
    this.triggerGarbageCollection();

    this.logStructured('browser_restart_complete', {
      memory_after: this.getMemoryUsage(),
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'restarted',
            message: 'Browser restarted successfully. New session available.',
          }),
        },
      ],
    };
  }

  private async handlePing(): Promise<any> {
    const health = this.getHealthStatus();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime_seconds: Math.round((Date.now() - this.serverStartTime) / 1000),
            server_version: '2.3.0',
            health: health.status,
            active_sessions: health.sessionsActive,
          }, null, 2),
        },
      ],
    };
  }

  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================

  private async ensureSession(): Promise<string> {
    if (this.activeSessionId && this.browserCore.hasSession(this.activeSessionId)) {
      return this.activeSessionId;
    }

    if (!this.initialized) {
      await this.initializeBrowser();
    }

    // Check resource limits
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new LlmBrowserError(
        'RATE_LIMIT_EXCEEDED',
        'Maximum concurrent sessions reached. Please close existing session first.',
        {
          max_sessions: this.maxConcurrentSessions,
          active_sessions: this.sessions.size,
        }
      );
    }

    const sessionId = randomUUID();
    await this.browserCore.createSession(sessionId);
    this.stateManager.registerSession(sessionId);

    const page = this.browserCore.getPage(sessionId);
    await this.stateManager.injectAllTrackers(page, sessionId);

    this.activeSessionId = sessionId;
    this.sessions.set(sessionId, {
      id: sessionId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      actionCount: 0,
      snapshotCount: 0,
    });

    globalMetrics.increment('llm_browser_sessions_created_total');

    this.logStructured('session_created', {
      session_id: sessionId,
      active_sessions: this.sessions.size,
    });

    return sessionId;
  }

  private async initializeBrowser(): Promise<void> {
    try {
      await this.browserCore.initialize();
      this.initialized = true;
      this.browserRestartAttempts = 0;

      this.logStructured('browser_initialized', {
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      // Browser crash recovery
      if (this.shouldAttemptRecovery()) {
        await this.attemptBrowserRecovery();
      } else {
        throw new LlmBrowserError(
          'INTERNAL_ERROR',
          'Failed to initialize browser. Please try restarting the MCP server.',
          { error: error.message }
        );
      }
    }
  }

  private async attemptBrowserRecovery(): Promise<void> {
    this.browserRestartAttempts++;
    this.lastBrowserCrash = new Date().toISOString();

    this.logStructured('browser_recovery_attempt', {
      attempt: this.browserRestartAttempts,
      max_attempts: this.maxRestartAttempts,
      timestamp: this.lastBrowserCrash,
    });

    globalMetrics.increment('llm_browser_browser_crashes_total');

    // Wait cooldown
    await new Promise(resolve => setTimeout(resolve, this.restartCooldownMs));

    try {
      // Attempt to reinitialize
      await this.browserCore.initialize();
      this.initialized = true;

      globalMetrics.increment('llm_browser_browser_recoveries_total');

      this.logStructured('browser_recovered', {
        attempt: this.browserRestartAttempts,
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      if (this.browserRestartAttempts < this.maxRestartAttempts) {
        // Retry
        await this.attemptBrowserRecovery();
      } else {
        throw new LlmBrowserError(
          'INTERNAL_ERROR',
          'Browser failed to recover after maximum restart attempts. Please restart MCP server manually.',
          {
            restart_attempts: this.browserRestartAttempts,
            last_error: error.message,
          }
        );
      }
    }
  }

  private shouldAttemptRecovery(): boolean {
    return this.browserRestartAttempts < this.maxRestartAttempts;
  }

  private cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastSnapshots.delete(sessionId);

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this.initialized = false;
    }

    globalMetrics.increment('llm_browser_sessions_closed_total');

    this.logStructured('session_closed', {
      session_id: sessionId,
      remaining_sessions: this.sessions.size,
    });
  }

  private updateSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  private handleBrowserCrash(event: any): void {
    this.logStructured('browser_crash_detected', {
      session_id: event.session_id,
      timestamp: new Date().toISOString(),
    });

    if (this.shouldAttemptRecovery()) {
      this.attemptBrowserRecovery();
    }
  }

  // ============================================================================
  // RATE LIMITING
  // ============================================================================

  private checkRateLimit(tool: string): boolean {
    const now = Date.now();
    let entry = this.rateLimits.get(tool);

    if (!entry || now >= entry.resetAt) {
      // Initialize or reset window
      const limit = this.getRateLimitForTool(tool);
      entry = {
        count: 0,
        resetAt: now + this.rateLimitWindowMs,
      };
      this.rateLimits.set(tool, entry);
    }

    const limit = this.getRateLimitForTool(tool);

    if (entry.count >= limit) {
      this.logStructured('rate_limit_exceeded', {
        tool,
        count: entry.count,
        limit,
        reset_at: new Date(entry.resetAt).toISOString(),
      });
      return false;
    }

    entry.count++;
    return true;
  }

  private getRateLimitForTool(tool: string): number {
    switch (tool) {
      case 'browser_navigate':
      case 'browser_open_tab':
        return this.navigateRateLimit;
      case 'browser_snapshot':
        return this.snapshotRateLimit;
      case 'browser_action':
      case 'browser_run_flow':
      case 'browser_evaluate':
      case 'browser_visual':
        return this.actionRateLimit;
      default:
        return this.actionRateLimit;
    }
  }

  private getTimeoutForTool(tool: string): number {
    switch (tool) {
      case 'browser_snapshot':
        return this.snapshotTimeoutMs;
      case 'browser_navigate':
        return this.actionTimeoutMs;
      case 'browser_action':
        return this.actionTimeoutMs;
      case 'browser_run_flow':
        return 120000;
      case 'browser_evaluate':
      case 'browser_visual':
        return this.snapshotTimeoutMs;
      case 'browser_paginate':
        return 120000; // 2 minutes for pagination
      default:
        return this.actionTimeoutMs;
    }
  }

  // ============================================================================
  // REQUEST DEDUPLICATION
  // ============================================================================

  private hashSnapshotRequest(args: any): string {
    const normalized = JSON.stringify(args, Object.keys(args).sort());
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  private getCachedResult(hash: string): any | null {
    const entry = this.requestCache.get(hash);
    if (entry && Date.now() - entry.timestamp < this.requestCacheTtlMs) {
      globalMetrics.increment('llm_browser_request_deduplicated_total');
      return entry.result;
    }
    return null;
  }

  private cacheResult(hash: string, result: any): void {
    this.requestCache.set(hash, {
      hash,
      timestamp: Date.now(),
      result,
    });

    // Cleanup old entries
    const now = Date.now();
    for (const [key, entry] of this.requestCache.entries()) {
      if (now - entry.timestamp > this.requestCacheTtlMs) {
        this.requestCache.delete(key);
      }
    }
  }

  // ============================================================================
  // ERROR HANDLING & ENHANCEMENT
  // ============================================================================

  private enhanceError(error: any, context: string, metadata: any): LlmBrowserError {
    if (error instanceof LlmBrowserError) {
      // Add context and hints to existing error
      return new LlmBrowserError(error.code, error.message, {
        ...error.context,
        ...metadata,
        context,
        hint: this.getErrorHint(error.code, context),
      });
    }

    // Classify and wrap unknown errors
    const { code, errorClass } = classifyActionError(error);
    return new LlmBrowserError(code, error.message, {
      ...metadata,
      context,
      error_class: errorClass,
      hint: this.getErrorHint(code, context),
    });
  }

  private getErrorHint(code: string, context: string): string {
    const hints: Record<string, Record<string, string>> = {
      ELEMENT_NOT_FOUND: {
        action: 'Element may have changed. Run browser_snapshot to get current element IDs.',
        snapshot: 'Snapshot may be stale. Request a fresh snapshot before taking actions.',
      },
      ELEMENT_NOT_VISIBLE: {
        action: 'Element may be hidden by overlay or modal. Try waiting or scrolling first.',
      },
      ELEMENT_DISABLED: {
        action: 'Element is disabled. Wait for it to become enabled or check if form is complete.',
      },
      NAVIGATION_FAILED: {
        navigate: 'Check URL format (must be http:// or https://). Try with www prefix if bare domain fails.',
      },
      RATE_LIMIT_EXCEEDED: {
        action: 'Too many requests. Wait a moment and retry with fewer snapshots.',
      },
      TIMEOUT_ACTION: {
        action: 'Action timed out. Page may be slow to respond. Retry or try browser_wait_for.',
      },
    };

    return hints[code]?.[context] || hints[code]?.action ||
      'Check browser_diagnostics for system health. Try restarting the session.';
  }

  private createRateLimitedError(tool: string): LlmBrowserError {
    const limit = this.getRateLimitForTool(tool);
    return new LlmBrowserError(
      'RATE_LIMIT_EXCEEDED',
      `Rate limit exceeded for ${tool}. Maximum ${limit} requests per minute.`,
      {
        tool,
        limit,
        retry_after_seconds: Math.ceil(this.rateLimitWindowMs / 1000),
        suggestion: 'Wait a few seconds before retrying or reduce request frequency.',
      }
    );
  }

  private createTimeoutError(tool: string, timeoutMs: number): LlmBrowserError {
    return new LlmBrowserError(
      'TIMEOUT_ACTION',
      `Tool ${tool} timed out after ${timeoutMs}ms`,
      {
        tool,
        timeout_ms: timeoutMs,
        suggestion: 'Page may be slow or unresponsive. Try browser_restart if problem persists.',
      }
    );
  }

  private createUnknownToolError(tool: string): LlmBrowserError {
    return new LlmBrowserError(
      'INVALID_ACTION',
      `Unknown tool: ${tool}`,
      {
        tool,
        available_tools: [
          'browser_navigate', 'browser_snapshot', 'browser_action',
          'browser_list_tabs', 'browser_open_tab', 'browser_switch_tab', 'browser_close_tab',
          'browser_screenshot', 'browser_diagnostics', 'browser_element_search',
          'browser_paginate', 'browser_wait_for', 'browser_session_info', 'browser_metrics',
          'browser_close_session', 'browser_restart', 'browser_ping'
        ],
      }
    );
  }

  private formatErrorResponse(error: any): any {
    const code = error.code || 'INTERNAL_ERROR';
    const hint = error.context?.hint || this.getErrorHint(code, 'action');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: true,
            code,
            message: error.message,
            hint,
            context: {
              ...error.context,
              timestamp: new Date().toISOString(),
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  private recordError(error: any): void {
    this.errorCount++;
    globalMetrics.increment('llm_browser_errors_total');

    const code = error.code || classifyActionError(error).code;
    const errorClass = error.errorClass || classifyActionError(error).errorClass;

    this.errorsByCode[code] = (this.errorsByCode[code] || 0) + 1;
    this.errorsByClass[errorClass] = (this.errorsByClass[errorClass] || 0) + 1;
  }

  private recordSuccess(tool: string, durationMs: number): void {
    globalMetrics.increment(`llm_browser_tool_${tool}_succeeded_total`);
    globalMetrics.histogram('llm_browser_tool_duration_ms', durationMs, { tool });
  }

  // ============================================================================
  // SECURITY
  // ============================================================================

  private validateUrl(url: string): void {
    try {
      const parsed = new URL(url);

      // Check protocol
      if (!this.securityPolicy.allowedProtocols.has(parsed.protocol)) {
        throw new LlmBrowserError(
          'SECURITY_VIOLATION',
          `URL protocol ${parsed.protocol} is not allowed. Only http: and https: are permitted.`,
          {
            url,
            protocol: parsed.protocol,
            suggestion: 'Use URLs starting with http:// or https://',
          }
        );
      }

      // Check hostname against blacklist
      const hostname = parsed.hostname.toLowerCase();
      for (const blocked of this.securityPolicy.blockedDomains) {
        if (hostname === blocked || hostname.endsWith('.' + blocked)) {
          throw new LlmBrowserError(
            'SECURITY_VIOLATION',
            `Access to ${blocked} is blocked for security reasons.`,
            {
              url,
              blocked_domain: blocked,
              suggestion: 'Access to local addresses and file:// URLs is not permitted.',
            }
          );
        }
      }

      // Check for private IP ranges
      if (this.isPrivateIp(parsed.hostname)) {
        throw new LlmBrowserError(
          'SECURITY_VIOLATION',
          'Access to private IP addresses is blocked for security reasons.',
          {
            url,
            hostname: parsed.hostname,
          }
        );
      }

    } catch (error: any) {
      if (error instanceof LlmBrowserError) {
        throw error;
      }
      throw new LlmBrowserError(
        'INVALID_PARAMS',
        `Invalid URL format: ${error.message}`,
        { url }
      );
    }
  }

  private isPrivateIp(hostname: string): boolean {
    // Basic private IP detection
    const privatePatterns = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^127\./,
      /^localhost$/,
      /^::1$/,
    ];

    return privatePatterns.some(pattern => pattern.test(hostname));
  }

  // ============================================================================
  // SNAPSHOT HELPERS
  // ============================================================================

  private async getQuickSnapshot(sessionId: string, options: any = {}): Promise<any> {
    const page = this.browserCore.getPage(sessionId);
    const tabs = await this.browserCore.listTabs(sessionId);
    const tabId = this.browserCore.getActiveTabId(sessionId);
    const previousSnapshot = options.previousSnapshot ?? this.lastSnapshots.get(sessionId);
    const bouncer = await this.bouncer.dismiss(page, { enabled: options.auto_bounce !== false }).catch(() => undefined);

    const snapshot = await this.semanticLayer.createSnapshot(page, {
      session: {
        session_id: sessionId,
        tab_id: tabId,
        tabs_count: tabs.length,
        history_length: 0,
        cookies_count: 0,
      },
      maxElements: 300, // Limited for speed
      previousSnapshot,
      ...this.snapshotFilters(options),
    });
    if (bouncer && snapshot.meta) {
      snapshot.meta.bouncer = {
        attempted: bouncer.attempted,
        closed: bouncer.closed,
        duration_ms: bouncer.duration_ms,
        actions: bouncer.actions,
      };
    }
    this.lastSnapshots.set(sessionId, snapshot);

    return this.stripInternalFields(snapshot);
  }

  private stripInternalFields(snapshot: any): any {
    return {
      ...snapshot,
      elements: (snapshot.elements || []).map((el: any) => {
        const { boundingBox, options, rows, _hash, ...rest } = el;
        return rest;
      }),
    };
  }

  private truncateSnapshot(snapshot: any, mode: string): any {
    const maxElements = mode === 'compact' ? 100 : mode === 'detailed' ? 800 : 400;

    return {
      ...snapshot,
      elements: (snapshot.elements || []).slice(0, maxElements),
    };
  }

  private snapshotFilters(args: any): {
    actionableOnly?: boolean;
    affordances?: string[];
    includeTypes?: string[];
    excludeTypes?: string[];
  } {
    return {
      actionableOnly: Boolean(args.actionable_only ?? args.actionableOnly),
      affordances: this.stringArray(args.affordances),
      includeTypes: this.stringArray(args.include_types ?? args.includeTypes),
      excludeTypes: this.stringArray(args.exclude_types ?? args.excludeTypes),
    };
  }

  private stringArray(value: unknown): string[] | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  }

  // ============================================================================
  // ACTION SUGGESTIONS
  // ============================================================================

  private getActionSuggestion(action: string, targetId?: string): string {
    switch (action) {
      case 'click':
        return 'Use browser_snapshot to find the element first. Element IDs may have changed after page reload.';
      case 'type':
        return 'Check if input is visible and enabled. Try clicking the input first to focus it.';
      case 'fill_form':
        return 'Verify form exists using browser_snapshot. Check required field names match.';
      case 'scroll':
        return 'If scrolling doesn\'t work, the page may use lazy-loading. Try browser_paginate instead.';
      case 'submit':
        return 'Verify all required fields are filled. Check for validation errors in snapshot.';
      case 'select':
        return 'Ensure the select element is visible and the option value exists.';
      default:
        return 'Run browser_snapshot to verify page state before retrying.';
    }
  }

  // ============================================================================
  // PROGRESS EVENTS
  // ============================================================================

  private emitProgress(tool: string, progress: number, message: string): void {
    const event: ProgressEvent = {
      tool,
      progress,
      message,
      startedAt: Date.now(),
    };

    this.activeOperations.set(tool, event);
    this.progressEmitter.emit('progress', event);
  }

  private sendProgressNotification(event: ProgressEvent): void {
    // In stdio mode, we can't send intermediate progress
    // but we log it for debugging
    if (event.progress > 0 && event.progress < 100) {
      this.logStructured('progress', event);
    }
  }

  // ============================================================================
  // HEALTH CHECK
  // ============================================================================

  private startHealthCheck(): void {
    this.browserHealthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.healthCheckIntervalMs);
  }

  private async performHealthCheck(): Promise<void> {
    try {
      // Check if browser is still alive using the proper method
      if (!this.browserCore.isAlive()) {
        this.logStructured('browser_disconnected_detected', {
          timestamp: new Date().toISOString(),
        });

        if (this.shouldAttemptRecovery()) {
          await this.attemptBrowserRecovery();
        }
      }

      // Cleanup stale sessions
      const now = Date.now();
      const idleTimeout = ConfigurationManager.getInstance()
        .getConfig().security.session_timeout_seconds * 1000;

      for (const [sessionId, session] of this.sessions.entries()) {
        if (now - session.lastActivity > idleTimeout) {
          this.cleanupSession(sessionId);
        }
      }

    } catch (error: any) {
      this.logStructured('health_check_error', {
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private getHealthStatus(): HealthStatus {
    const browserAlive = this.browserCore.isAlive();

    const issues: string[] = [];

    if (!browserAlive) {
      issues.push('Browser not connected');
    }

    if (this.sessions.size >= this.maxConcurrentSessions) {
      issues.push('Maximum sessions reached');
    }

    if (this.browserRestartAttempts > 0) {
      issues.push(`Browser restarted ${this.browserRestartAttempts} times`);
    }

    let status: 'ok' | 'degraded' | 'critical' = 'ok';
    if (issues.length > 0) {
      status = browserAlive ? 'degraded' : 'critical';
    }

    return {
      status,
      browserAlive,
      sessionsActive: this.sessions.size,
      lastRecovery: this.lastBrowserCrash || undefined,
      issues,
    };
  }

  // ============================================================================
  // STRUCTURED LOGGING
  // ============================================================================

  private startStructuredLogging(): void {
    this.logFlushInterval = setInterval(() => {
      this.flushLogs();
    }, 5000);
  }

  private logStructured(event: string, data: any): void {
    if (!this.structuredLoggingEnabled) {
      return;
    }

    this.logBuffer.push({
      event,
      timestamp: new Date().toISOString(),
      ...data,
    });

    // Also output to stderr for debugging
    console.error(`[${event}]`, JSON.stringify(data));
  }

  private flushLogs(): void {
    if (this.logBuffer.length > 0) {
      // In production, this would send to a logging service
      // For now, we just clear the buffer
      this.logBuffer = [];
    }
  }

  private sanitizeForLogging(args: any): any {
    // Remove sensitive data from logs
    const sanitized = { ...args };
    const sensitiveFields = ['password', 'token', 'secret', 'api_key'];

    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  // ============================================================================
  // METRICS
  // ============================================================================

  // ============================================================
  // MEMORY MANAGEMENT - Multi-level Cleanup Strategy
  // ============================================================

  /**
   * Check if a tool is a rescue tool (system tool that bypasses resource limits)
   */
  private isRescueTool(name: string): boolean {
    return this.RESCUE_TOOLS.has(name);
  }

  /**
   * Force garbage collection hint to Node.js
   * This is a hint, not a guarantee - Node will decide if GC is needed
   */
  private triggerGarbageCollection(): void {
    const now = Date.now();
    if (now - this.lastGcTimestamp < this.gcCooldownMs) {
      return; // Too soon, respect cooldown
    }

    this.lastGcTimestamp = now;

    // Request GC by dereferencing large objects
    // This is a soft hint - Node.js may or may not run GC
    if (global.gc) {
      try {
        global.gc(true); // Explicit GC if available
      } catch {
        // GC not exposed, ignore
      }
    }

    this.logStructured('gc_triggered', {
      memory_before: this.getMemoryUsage(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get current memory usage in bytes
   */
  private getMemoryUsage(): { rss: number; heapUsed: number; heapTotal: number } {
    const mem = process.memoryUsage();
    return {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    };
  }

  /**
   * Assess current memory pressure level
   */
  private assessMemoryPressure(): 'low' | 'medium' | 'high' | 'critical' {
    const mem = process.memoryUsage();
    const heapUsed = mem.heapUsed;

    if (heapUsed >= this.memoryThresholds.critical) {
      return 'critical';
    } else if (heapUsed >= this.memoryThresholds.warning) {
      return 'high';
    } else if (heapUsed >= this.memoryThresholds.warning / 2) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Level 1 Cleanup - Light (no restart required)
   * Clear caches and non-essential data
   */
  private level1Cleanup(): void {
    this.logStructured('memory_cleanup_level1', {
      memory_before: this.getMemoryUsage(),
    });

    // Clear screenshot cache
    this.screenshotCache.clear();

    // Clear request deduplication cache
    this.requestCache.clear();

    // Clear rate limits (they'll rebuild naturally)
    this.rateLimits.clear();

    // Clear old log buffer
    this.logBuffer = [];

    this.memoryPressureLevel = 'medium';

    this.logStructured('memory_cleanup_level1_complete', {
      memory_after: this.getMemoryUsage(),
    });
  }

  /**
   * Level 2 Cleanup - Medium (close sessions but keep browser)
   * Aggressive cache clearing and session cleanup
   */
  private level2Cleanup(): void {
    this.logStructured('memory_cleanup_level2', {
      memory_before: this.getMemoryUsage(),
    });

    // Level 1 cleanup first
    this.level1Cleanup();

    // Clear all snapshots
    this.lastSnapshots.clear();

    // Clear SSE connections
    this.sseConnections.clear();

    // Close all sessions (but keep browser open)
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      this.browserCore.closeSession(sessionId).catch(() => undefined);
    }
    this.sessions.clear();
    this.activeSessionId = null;
    this.initialized = false;

    // Trigger GC
    this.triggerGarbageCollection();

    this.memoryPressureLevel = 'high';

    this.logStructured('memory_cleanup_level2_complete', {
      memory_after: this.getMemoryUsage(),
    });
  }

  /**
   * Level 3 Cleanup - Deep (full restart)
   * Complete browser restart with full state reset
   */
  private async level3Cleanup(): Promise<void> {
    this.logStructured('memory_cleanup_level3', {
      memory_before: this.getMemoryUsage(),
    });

    // Full browser restart
    await this.handleRestart({ reason: 'memory_cleanup' });

    this.triggerGarbageCollection();

    this.memoryPressureLevel = 'low';

    this.logStructured('memory_cleanup_level3_complete', {
      memory_after: this.getMemoryUsage(),
    });
  }

  /**
   * Smart cleanup based on current memory pressure
   * Returns true if cleanup was performed
   */
  private async performSmartCleanup(): Promise<boolean> {
    this.memoryPressureLevel = this.assessMemoryPressure();

    switch (this.memoryPressureLevel) {
      case 'critical':
        this.logStructured('memory_pressure_critical', {
          memory: this.getMemoryUsage(),
        });
        await this.level3Cleanup();
        return true;

      case 'high':
        this.logStructured('memory_pressure_high', {
          memory: this.getMemoryUsage(),
        });
        this.level2Cleanup();
        return true;

      case 'medium':
        this.level1Cleanup();
        return true;

      default:
        return false; // No cleanup needed
    }
  }

  /**
   * Get adaptive max elements based on memory pressure
   */
  private getAdaptiveMaxElements(requested?: number): number {
    const base = requested || 500;

    switch (this.memoryPressureLevel) {
      case 'critical':
        return this.memoryThresholds.maxElementsHardLimit;
      case 'high':
        return Math.min(base, this.memoryThresholds.maxElementsSoftLimit);
      default:
        return base;
    }
  }

  /**
   * Detect if a site is "heavy" (complex DOM, ad-heavy, etc.)
   * These sites need special handling to avoid memory issues
   */
  private isHeavySite(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();

      // Known heavy e-commerce sites with complex DOM
      const heavyPatterns = [
        'amazon.',
        'ebay.',
        'walmart.',
        'target.',
        'bestbuy.',
        'alibaba.',
        'aliexpress.',
        'rakuten.',
        'yahoo.',
        'aol.',
        'msn.',
        'bing.',
        'cnn.',
        'bbc.',
        'forbes.',
        'huffpost.',
        'reddit.',
        'instagram.',
        'facebook.',
        'twitter.',
        'tiktok.',
        'youtube.',
        'pinterest.',
        'linkedin.',
        'tumblr.',
        'wikihow.',
        'zhihu.',
        'baidu.',
        'sina.',
        'qq.',
        'naver.',
        'daum.',
      ];

      for (const pattern of heavyPatterns) {
        if (hostname.includes(pattern)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private getPrometheusMetrics(): string {
    const uptime = Math.round((Date.now() - this.serverStartTime) / 1000);
    const lines: string[] = [
      '# HELP llm_browser_uptime_seconds Server uptime in seconds',
      '# TYPE llm_browser_uptime_seconds gauge',
      `llm_browser_uptime_seconds ${uptime}`,

      '# HELP llm_browser_requests_total Total MCP requests',
      '# TYPE llm_browser_requests_total counter',
      `llm_browser_requests_total ${this.requestCount}`,

      '# HELP llm_browser_errors_total Total errors',
      '# TYPE llm_browser_errors_total counter',
      `llm_browser_errors_total ${this.errorCount}`,

      '# HELP llm_browser_active_sessions Current active sessions',
      '# TYPE llm_browser_active_sessions gauge',
      `llm_browser_active_sessions ${this.sessions.size}`,

      '# HELP llm_browser_browser_crashes_total Browser crash count',
      '# TYPE llm_browser_browser_crashes_total counter',
      `llm_browser_browser_crashes_total ${globalMetrics.get('llm_browser_browser_crashes_total') || 0}`,

      '# HELP llm_browser_browser_recoveries_total Browser recovery count',
      '# TYPE llm_browser_browser_recoveries_total counter',
      `llm_browser_browser_recoveries_total ${globalMetrics.get('llm_browser_browser_recoveries_total') || 0}`,

      '# HELP llm_browser_sessions_created_total Total sessions created',
      '# TYPE llm_browser_sessions_created_total counter',
      `llm_browser_sessions_created_total ${globalMetrics.get('llm_browser_sessions_created_total') || 0}`,

      '# HELP llm_browser_snapshots_total Total snapshots taken',
      '# TYPE llm_browser_snapshots_total counter',
      `llm_browser_snapshots_total ${globalMetrics.get('llm_browser_snapshots_total') || 0}`,

      '# HELP llm_browser_actions_succeeded_total Total successful actions',
      '# TYPE llm_browser_actions_succeeded_total counter',
      `llm_browser_actions_succeeded_total ${globalMetrics.get('llm_browser_actions_succeeded_total') || 0}`,

      '# HELP llm_browser_actions_failed_total Total failed actions',
      '# TYPE llm_browser_actions_failed_total counter',
      `llm_browser_actions_failed_total ${globalMetrics.get('llm_browser_actions_failed_total') || 0}`,
    ];

    // Error codes
    for (const [code, count] of Object.entries(this.errorsByCode)) {
      lines.push(`# HELP llm_browser_errors_by_code_total Errors by code`);
      lines.push(`# TYPE llm_browser_errors_by_code_total counter`);
      lines.push(`llm_browser_errors_by_code_total{code="${code}"} ${count}`);
    }

    return lines.join('\n');
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  private async timeoutPromise<T>(ms: number, context: string): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        const error: any = new Error(`Operation ${context} timed out after ${ms}ms`);
        error.name = 'TimeoutError';
        reject(error);
      }, ms);
    });
  }

  // ============================================================================
  // SERVER LIFECYCLE
  // ============================================================================

  async start(transport: 'stdio' | 'sse' = 'stdio'): Promise<void> {
    if (transport === 'stdio') {
      const stdioTransport = new StdioServerTransport();
      await this.server.connect(stdioTransport);
      console.error('LLM Browser MCP Server running on stdio');
    } else {
      // SSE transport would be initialized here
      throw new Error('SSE transport not yet implemented');
    }
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    // Clear intervals
    if (this.browserHealthCheckInterval) {
      clearInterval(this.browserHealthCheckInterval);
    }

    if (this.logFlushInterval) {
      clearInterval(this.logFlushInterval);
    }

    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
    }

    // Flush logs
    this.flushLogs();

    // Close all sessions
    for (const sessionId of this.sessions.keys()) {
      try {
        await this.browserCore.closeSession(sessionId);
      } catch (e) {
        // Ignore errors during cleanup
      }
    }

    // Close browser
    try {
      await this.browserCore.close();
    } catch (e) {
      // Ignore errors during cleanup
    }

    this.logStructured('server_shutdown', {
      sessions_closed: this.sessions.size,
      uptime_seconds: Math.round((Date.now() - this.serverStartTime) / 1000),
    });
  }
}

// ============================================================================
// EXPORT
// ============================================================================

export { McpServer };
export default McpServer;
