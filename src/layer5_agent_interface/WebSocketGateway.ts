import { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { CommandRouter } from './CommandRouter';
import { normalizeError } from '../common/errors';

export class WebSocketGateway {
  private server: WebSocketServer;

  constructor(httpServer: Server, private commandRouter: CommandRouter) {
    this.server = new WebSocketServer({ server: httpServer, path: '/api/v2/ws' });
    this.server.on('connection', (socket, request) => {
      const requestUrl = new URL(request.url ?? '/api/v2/ws', 'http://127.0.0.1');
      const defaultSessionId = requestUrl.searchParams.get('session_id') ?? undefined;

      this.send(socket, {
        type: 'connected',
        protocol: 'llm-browser.ws.v2',
        session_id: defaultSessionId,
      });

      socket.on('message', (raw) => {
        void this.handleMessage(socket, raw.toString(), defaultSessionId);
      });
    });
  }

  close(): void {
    this.server.close();
  }

  private async handleMessage(socket: WebSocket, raw: string, defaultSessionId?: string): Promise<void> {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      this.send(socket, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Invalid JSON' },
        id: null,
      });
      return;
    }

    if (Array.isArray(message)) {
      const responses = [];
      for (const entry of message) {
        responses.push(await this.handleJsonRpc(entry, defaultSessionId));
      }
      this.send(socket, responses);
      return;
    }

    this.send(socket, await this.handleJsonRpc(message, defaultSessionId));
  }

  private async handleJsonRpc(message: any, defaultSessionId?: string): Promise<Record<string, any>> {
    const { jsonrpc, method, params, id } = message ?? {};
    if (jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Invalid JSON-RPC' },
        id,
      };
    }

    try {
      const command = this.commandRouter.normalizeJsonRpc(method, {
        ...(params ?? {}),
        session_id: params?.session_id ?? defaultSessionId,
      });
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
          code: normalized.code === 'SESSION_NOT_FOUND' ? -32001 : -32603,
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

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}
