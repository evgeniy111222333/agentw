import express from 'express';
import { Server } from 'http';
import { randomUUID } from 'crypto';
import { BrowserCore } from '../layer1_browser_core/BrowserCore';
import { StateManagementLayer } from '../layer3_state_management/StateManagementLayer';
import { ActionExecutor } from '../layer2_action_execution/ActionExecutor';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { SemanticLayer } from '../layer4_semantic/SemanticLayer';
import { SemanticSnapshot } from '../common/types';
import { globalMetrics } from '../common/MetricsRegistry';
import { LlmBrowserError, normalizeError } from '../common/errors';
import { CommandRouter } from './CommandRouter';
import { WebSocketGateway } from './WebSocketGateway';
import { globalAuditLog } from '../common/AuditLog';
import { createDefaultPluginRegistry } from '../plugins/PluginRegistry';
import { Probe } from '../health/Probe';
import { importedActions, importedSession, importedSnapshot, makePack, readPack } from '../session/Pack';
import { globalTraceStore } from '../trace/Trace';
import { globalSemCache } from '../cache/Sem';

export class ApiServer {
  private app = express();
  private httpServer: Server | null = null;
  private browserCore = new BrowserCore();
  private stateManager = new StateManagementLayer();
  private actionExecutor = new ActionExecutor(this.browserCore);
  private pluginRegistry = createDefaultPluginRegistry(ConfigurationManager.getInstance().getConfig().plugin_registry);
  private semanticLayer = new SemanticLayer({ pluginRegistry: this.pluginRegistry });
  private previousSnapshots: Map<string, SemanticSnapshot> = new Map();
  private wsGateway: WebSocketGateway | null = null;
  private commandRouter = new CommandRouter(
    this.browserCore,
    this.stateManager,
    this.actionExecutor,
    this.semanticLayer,
    this.previousSnapshots
  );
  private healthProbe = new Probe(this.browserCore, this.stateManager, this.pluginRegistry);

  constructor() {
    this.app.use(express.json({ limit: '8mb' }));
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.get('/api/v2/health', (_req, res) => {
      res.json(this.healthProbe.report());
    });

    this.app.get('/metrics', (_req, res) => {
      res.type('text/plain').send(globalMetrics.toPrometheus());
    });

    this.app.get('/api/v2/audit', (req, res) => {
      const session_id = stringQuery(req.query.session_id);
      const category = stringQuery(req.query.category) as any;
      res.json(paginate(globalAuditLog.list({ session_id, category }), req.query, '/api/v2/audit'));
    });

    this.app.get('/api/v2/traces', (req, res) => {
      const session_id = stringQuery(req.query.session_id);
      const status = stringQuery(req.query.status) as any;
      res.json(paginate(globalTraceStore.list({ session_id, status }), req.query, '/api/v2/traces'));
    });

    this.app.get('/api/v2/traces/:traceId', (req, res) => {
      const trace = globalTraceStore.get(req.params.traceId);
      if (!trace) {
        return this.sendRestError(res, new LlmBrowserError('ELEMENT_NOT_FOUND', 'Trace not found', { trace_id: req.params.traceId }));
      }
      res.json(trace);
    });

    this.app.get('/api/v2/cache/semantic', (_req, res) => {
      res.json({
        stats: globalSemCache.stats(),
        entries: globalSemCache.list(),
      });
    });

    this.app.delete('/api/v2/cache/semantic', (_req, res) => {
      globalSemCache.clear();
      globalMetrics.increment('llm_browser_semantic_cache_cleared_total');
      res.status(204).send();
    });

    this.app.get('/api/v2/plugins', (req, res) => {
      res.json(paginate(this.pluginRegistry.listPlugins(), req.query, '/api/v2/plugins'));
    });

    this.app.get('/api/v2/ops', (req, res) => {
      const session_id = stringQuery(req.query.session_id);
      res.json(paginate(this.commandRouter.listOps(session_id), req.query, '/api/v2/ops'));
    });

    this.app.get('/api/v2/ops/:operationId', (req, res) => {
      const status = this.commandRouter.getOp(req.params.operationId);
      if (!status) {
        return this.sendRestError(res, new LlmBrowserError('ELEMENT_NOT_FOUND', 'Operation not found'));
      }
      res.json(status);
    });

    this.app.post('/api/v2/ops/:operationId/cancel', (req, res) => {
      const status = this.commandRouter.cancelOp(req.params.operationId);
      if (!status) {
        return this.sendRestError(res, new LlmBrowserError('ELEMENT_NOT_FOUND', 'Operation not found'));
      }
      res.json(status);
    });

    this.app.get('/api/v2/sessions', (req, res) => {
      const sessions = this.stateManager.listSessions();
      res.json(paginate(sessions, req.query, '/api/v2/sessions'));
    });

    this.app.post('/api/v2/sessions', async (_req, res) => {
      try {
        const sessionId = randomUUID();
        await this.browserCore.createSession(sessionId);
        this.stateManager.registerSession(sessionId);

        const page = this.browserCore.getPage(sessionId);
        await this.stateManager.injectMutationObserver(page, sessionId);
        globalMetrics.increment('llm_browser_sessions_created_total');

        res.status(201).json({ session_id: sessionId });
      } catch (error: any) {
        this.sendRestError(res, normalizeError(error, { operation: 'create_session' }));
      }
    });

    this.app.post('/api/v2/sessions/import', async (req, res) => {
      let sessionId: string | undefined;
      try {
        const pack = readPack(req.body);
        sessionId = String(req.body?.session_id ?? randomUUID());
        if (this.stateManager.getSessionState(sessionId) || this.browserCore.hasSession(sessionId)) {
          throw new LlmBrowserError('INVALID_PARAMS', 'Session ID already exists', { session_id: sessionId });
        }

        await this.browserCore.createSession(sessionId, { storageState: pack.browser.storage_state });
        this.stateManager.registerSession(sessionId, importedSession(pack, sessionId));
        this.stateManager.setActionHistory(sessionId, importedActions(pack, sessionId));
        const snapshot = importedSnapshot(pack, sessionId);
        if (snapshot) this.previousSnapshots.set(sessionId, snapshot);

        const page = this.browserCore.getPage(sessionId);
        await this.stateManager.injectMutationObserver(page, sessionId);
        const targetUrl = String(req.body?.url ?? pack.page.url ?? pack.session.current_url ?? '');
        if (targetUrl && req.body?.navigate !== false) {
          await page.goto(targetUrl, { waitUntil: 'load' });
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
          this.stateManager.recordPageState(sessionId, {
            url: page.url(),
            title: await page.title(),
            snapshot_id: snapshot?.snapshot_id,
          });
        }

        globalMetrics.increment('llm_browser_sessions_imported_total');
        res.status(201).json({
          session_id: sessionId,
          imported_from_session_id: pack.session.session_id,
          current_url: this.stateManager.getSessionState(sessionId)?.current_url,
          actions_imported: pack.actions.length,
          snapshot_imported: Boolean(snapshot),
        });
      } catch (error: any) {
        if (sessionId) {
          await this.browserCore.closeSession(sessionId).catch(() => undefined);
          this.stateManager.closeSession(sessionId);
          this.previousSnapshots.delete(sessionId);
        }
        this.sendRestError(res, normalizeError(error, { operation: 'import_session' }));
      }
    });

    this.app.get('/api/v2/sessions/:id/export', async (req, res) => {
      try {
        const session = this.stateManager.getSessionState(req.params.id);
        if (!session) {
          return this.sendRestError(res, new LlmBrowserError('SESSION_NOT_FOUND', 'Session not found'));
        }
        const page = this.browserCore.getPage(req.params.id);
        const storageState = await this.browserCore.storageState(req.params.id);
        const pack = makePack({
          session: enrichSession(session, storageState, page.url()),
          actions: this.stateManager.getActionHistory(req.params.id),
          storageState,
          page: {
            url: page.url(),
            title: await page.title(),
          },
          snapshot: this.previousSnapshots.get(req.params.id),
        });
        globalMetrics.increment('llm_browser_sessions_exported_total');
        res.json(pack);
      } catch (error) {
        this.sendRestError(res, normalizeError(error, { operation: 'export_session' }));
      }
    });

    this.app.get('/api/v2/sessions/:id/diagnostics', async (req, res) => {
      try {
        const session = this.stateManager.getSessionState(req.params.id);
        if (!session) {
          return this.sendRestError(res, new LlmBrowserError('SESSION_NOT_FOUND', 'Session not found'));
        }
        const page = this.browserCore.getPage(req.params.id);
        const snapshot = this.previousSnapshots.get(req.params.id);
        res.json({
          session,
          page: {
            url: page.url(),
            title: await page.title(),
          },
          actions: {
            total: this.stateManager.getActionHistory(req.params.id).length,
            recent: this.stateManager.getActionHistory(req.params.id).slice(-10),
          },
          snapshot: snapshot
            ? {
                snapshot_id: snapshot.snapshot_id,
                elements: snapshot.elements.length,
                actions: snapshot.available_actions.length,
                meta: snapshot.meta,
              }
            : undefined,
          health: this.healthProbe.report(),
        });
      } catch (error) {
        this.sendRestError(res, normalizeError(error, { operation: 'session_diagnostics' }));
      }
    });

    this.app.get('/api/v2/sessions/:id/snapshot', async (req, res) => {
      try {
        const result = await this.commandRouter.execute({
          action: 'snapshot',
          session_id: req.params.id,
          trace_id: stringQuery(req.query.trace_id),
        });
        res.json(result);
      } catch (error) {
        this.sendRestError(res, normalizeError(error));
      }
    });

    this.app.post('/api/v2/sessions/:id/actions', async (req, res) => {
      try {
        const command = this.commandRouter.normalizeRest(req.params.id, req.body);
        const result = await this.commandRouter.execute(command);
        res.status(200).json(result);
      } catch (error) {
        this.sendRestError(res, normalizeError(error));
      }
    });

    this.app.get('/api/v2/sessions/:id/actions', (req, res) => {
      const session = this.stateManager.getSessionState(req.params.id);
      if (!session) {
        return this.sendRestError(res, new LlmBrowserError('SESSION_NOT_FOUND', 'Session not found'));
      }

      const records = this.stateManager.getActionHistory(req.params.id);
      res.json(paginate(records, req.query, `/api/v2/sessions/${req.params.id}/actions`));
    });

    this.app.get('/api/v2/sessions/:id/actions/:actionId', (req, res) => {
      const action = this.stateManager.getAction(req.params.id, req.params.actionId);
      if (!action) {
        return this.sendRestError(res, new LlmBrowserError('ELEMENT_NOT_FOUND', 'Action record not found'));
      }
      res.json(action);
    });

    this.app.get('/api/v2/sessions/:id', (req, res) => {
      const session = this.stateManager.getSessionState(req.params.id);
      if (!session) {
        return this.sendRestError(res, new LlmBrowserError('SESSION_NOT_FOUND', 'Session not found'));
      }
      res.json(session);
    });

    this.app.delete('/api/v2/sessions/:id', async (req, res) => {
      try {
        await this.browserCore.closeSession(req.params.id);
        this.stateManager.closeSession(req.params.id);
        this.previousSnapshots.delete(req.params.id);
        globalMetrics.increment('llm_browser_sessions_closed_total');
        res.status(204).send();
      } catch (error: any) {
        this.sendRestError(res, normalizeError(error, { operation: 'close_session' }));
      }
    });

    this.app.post('/api/v2/jsonrpc', async (req, res) => {
      if (Array.isArray(req.body)) {
        const responses = [];
        for (const message of req.body) {
          responses.push(await this.handleJsonRpcMessage(message));
        }
        return res.json(responses);
      }

      res.json(await this.handleJsonRpcMessage(req.body));
    });
  }

  async start() {
    await this.browserCore.initialize();
    const port = ConfigurationManager.getInstance().getConfig().server.port;
    await new Promise<void>((resolve) => {
      this.httpServer = this.app.listen(port, () => {
        this.wsGateway = new WebSocketGateway(this.httpServer!, this.commandRouter);
        console.log(`LLM-Browser API Server running on port ${port}`);
        resolve();
      });
    });
  }

  async stop() {
    this.wsGateway?.close();
    this.wsGateway = null;
    await this.browserCore.close();
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer?.close((error) => (error ? reject(error) : resolve()));
      });
      this.httpServer = null;
    }
  }

  private async handleJsonRpcMessage(message: any): Promise<Record<string, any>> {
    const { jsonrpc, method, params, id } = message ?? {};

    if (jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Invalid JSON-RPC' },
        id,
      };
    }

    try {
      const command = this.commandRouter.normalizeJsonRpc(method, params);
      const result = await this.commandRouter.execute(command);
      return {
        jsonrpc: '2.0',
        result,
        id,
      };
    } catch (error) {
      const normalized = normalizeError(error);
      return {
        jsonrpc: '2.0',
        error: {
          code: jsonRpcCode(normalized),
          message: normalized.message,
          data: {
            error_code: normalized.code,
            recoverable: normalized.recoverable,
            ...normalized.context,
          },
        },
        id,
      };
    }
  }

  private sendRestError(res: express.Response, error: LlmBrowserError): void {
    res.status(error.httpStatus).json({
      error: {
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
        context: error.context,
      },
    });
  }
}

function jsonRpcCode(error: LlmBrowserError): number {
  if (error.code === 'SESSION_NOT_FOUND') return -32001;
  if (error.code === 'INVALID_ACTION') return -32601;
  if (error.code === 'INVALID_PARAMS' || error.code === 'MISSING_PARAM') return -32602;
  return -32603;
}

function paginate<T>(items: T[], query: Record<string, any>, basePath: string) {
  const page = Math.max(1, Number(query.page ?? 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
  const totalCount = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const start = (page - 1) * limit;
  const data = items.slice(start, start + limit);

  const pageUrl = (targetPage: number) => `${basePath}?page=${targetPage}&limit=${limit}`;

  return {
    data,
    pagination: {
      total_count: totalCount,
      page,
      limit,
      total_pages: totalPages,
      links: {
        first: pageUrl(1),
        prev: page > 1 ? pageUrl(page - 1) : null,
        next: page < totalPages ? pageUrl(page + 1) : null,
        last: pageUrl(totalPages),
      },
    },
  };
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function enrichSession(session: any, storageState: any, pageUrl: string): any {
  const localStorage = currentLocalStorage(storageState, pageUrl);
  return {
    ...session,
    cookies: storageState.cookies ?? session.cookies ?? [],
    localStorage: Object.keys(localStorage).length > 0 ? localStorage : session.localStorage ?? {},
  };
}

function currentLocalStorage(storageState: any, pageUrl: string): Record<string, string> {
  const result: Record<string, string> = {};
  let origin = '';
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return result;
  }

  const match = (storageState.origins ?? []).find((entry: any) => entry.origin === origin);
  for (const entry of match?.localStorage ?? []) {
    result[entry.name] = entry.value;
  }
  return result;
}
