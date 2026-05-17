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

  constructor() {
    this.app.use(express.json({ limit: '8mb' }));
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.get('/api/v2/health', (_req, res) => {
      res.json({
        status: 'ok',
        version: '2.2.0',
        plugins: this.pluginRegistry.listPlugins().map((plugin) => ({
          name: plugin.name,
          version: plugin.version,
          status: plugin.status,
        })),
        metrics: globalMetrics.snapshot(),
      });
    });

    this.app.get('/metrics', (_req, res) => {
      res.type('text/plain').send(globalMetrics.toPrometheus());
    });

    this.app.get('/api/v2/audit', (req, res) => {
      const session_id = stringQuery(req.query.session_id);
      const category = stringQuery(req.query.category) as any;
      res.json(paginate(globalAuditLog.list({ session_id, category }), req.query, '/api/v2/audit'));
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
