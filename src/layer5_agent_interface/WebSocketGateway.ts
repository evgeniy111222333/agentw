import { randomUUID } from 'crypto';
import { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { CommandRouter } from './CommandRouter';
import { normalizeError } from '../common/errors';
import { globalEventBus } from '../common/EventBus';
import { RuntimeEventKind, StreamEvent, StreamEventType } from '../common/types';

interface ClientState {
  sessionId?: string;
  subscriptions: Set<string>;
}

const runtimeEventKinds: RuntimeEventKind[] = [
  'request',
  'response',
  'request_failed',
  'console',
  'page_error',
  'navigation',
  'dialog',
  'download',
];
const runtimeEventKindSet = new Set<string>(runtimeEventKinds);

export class WebSocketGateway {
  private server: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();
  private streamBuffer: StreamEvent[] = [];
  private heartbeat: NodeJS.Timeout;
  private readonly maxBufferedEvents = 1000;
  private readonly onStreamEvent = (event: any) => this.recordAndBroadcast(event);

  constructor(httpServer: Server, private commandRouter: CommandRouter) {
    this.server = new WebSocketServer({ server: httpServer, path: '/api/v2/ws' });
    this.server.on('connection', (socket, request) => {
      const requestUrl = new URL(request.url ?? '/api/v2/ws', 'http://127.0.0.1');
      const defaultSessionId = requestUrl.searchParams.get('session_id') ?? undefined;
      const initialEvents = eventSet(requestUrl.searchParams.getAll('events'));
      const state: ClientState = {
        sessionId: defaultSessionId,
        subscriptions: initialEvents,
      };
      this.clients.set(socket, state);

      this.send(socket, {
        type: 'connected',
        protocol: 'llm-browser.ws.v2',
        session_id: defaultSessionId,
        stream: {
          subscribe: true,
          replay: true,
          heartbeat_ms: 30000,
        },
        subscriptions: Array.from(initialEvents),
      });

      socket.on('message', (raw) => {
        void this.handleMessage(socket, raw.toString(), state);
      });
      socket.on('close', () => this.clients.delete(socket));
    });
    globalEventBus.subscribe('stream_event', this.onStreamEvent);
    this.heartbeat = setInterval(() => this.broadcastHeartbeat(), 30000);
    this.heartbeat.unref?.();
  }

  close(): void {
    globalEventBus.unsubscribe('stream_event', this.onStreamEvent);
    clearInterval(this.heartbeat);
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }

  private async handleMessage(socket: WebSocket, raw: string, state: ClientState): Promise<void> {
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

    if (message && typeof message.type === 'string' && message.jsonrpc === undefined) {
      this.handleControlMessage(socket, state, message);
      return;
    }

    if (Array.isArray(message)) {
      const responses = [];
      for (const entry of message) {
        responses.push(await this.handleJsonRpc(entry, state.sessionId));
      }
      this.send(socket, responses);
      return;
    }

    this.send(socket, await this.handleJsonRpc(message, state.sessionId));
  }

  private handleControlMessage(socket: WebSocket, state: ClientState, message: any): void {
    switch (message.type) {
      case 'subscribe': {
        if (message.session_id) state.sessionId = String(message.session_id);
        const requested = eventSet(message.events ?? message.event ?? '*');
        for (const event of requested) state.subscriptions.add(event);
        this.send(socket, {
          type: 'subscribed',
          id: message.id,
          session_id: state.sessionId,
          events: Array.from(state.subscriptions),
        });
        if (message.replay) {
          this.replay(socket, state, message);
        }
        return;
      }

      case 'unsubscribe': {
        const requested = eventSet(message.events ?? message.event ?? []);
        if (requested.size === 0) state.subscriptions.clear();
        else for (const event of requested) state.subscriptions.delete(event);
        this.send(socket, {
          type: 'unsubscribed',
          id: message.id,
          session_id: state.sessionId,
          events: Array.from(state.subscriptions),
        });
        return;
      }

      case 'replay':
        this.replay(socket, state, message);
        return;

      case 'ping':
        this.send(socket, {
          type: 'pong',
          id: message.id,
          timestamp: new Date().toISOString(),
          session_id: state.sessionId,
        });
        return;

      default:
        this.send(socket, {
          type: 'error',
          id: message.id,
          timestamp: new Date().toISOString(),
          session_id: state.sessionId,
          error: {
            code: 'INVALID_MESSAGE',
            message: `Unsupported WebSocket message type: ${message.type}`,
          },
        });
    }
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

  private recordAndBroadcast(input: any): void {
    const event = normalizeStreamEvent(input);
    this.streamBuffer.push(event);
    this.streamBuffer = this.streamBuffer.slice(-this.maxBufferedEvents);

    for (const [socket, state] of this.clients) {
      if (this.matches(event, state, state.subscriptions)) {
        this.send(socket, event);
      }
    }
  }

  private replay(socket: WebSocket, state: ClientState, message: any): void {
    const requestedEvents = eventSet(message.events ?? message.event ?? Array.from(state.subscriptions));
    const effectiveEvents = requestedEvents.size > 0 ? requestedEvents : state.subscriptions;
    const since = typeof message.since === 'string' ? Date.parse(message.since) : undefined;
    const afterEventId = message.after_event_id ?? message.last_event_id;
    const limit = Math.min(Math.max(Number(message.limit ?? 100), 1), this.maxBufferedEvents);
    let afterSeen = !afterEventId;

    const events = this.streamBuffer.filter((event) => {
      if (afterEventId && event.event_id === afterEventId) {
        afterSeen = true;
        return false;
      }
      if (!afterSeen) return false;
      if (Number.isFinite(since) && Date.parse(event.timestamp) < Number(since)) return false;
      return this.matches(event, state, effectiveEvents);
    }).slice(-limit);

    this.send(socket, {
      type: 'replay_started',
      id: message.id,
      session_id: state.sessionId,
      count: events.length,
    });
    for (const event of events) this.send(socket, event);
    this.send(socket, {
      type: 'replay_done',
      id: message.id,
      session_id: state.sessionId,
      count: events.length,
    });
  }

  private matches(event: StreamEvent, state: ClientState, events: Set<string>): boolean {
    if (state.sessionId && event.session_id && event.session_id !== state.sessionId) return false;
    if (events.size === 0) return false;
    if (events.has('*') || events.has('all')) return true;
    if (events.has(String(event.type))) return true;
    if (events.has('runtime') && runtimeEventKindSet.has(String(event.type))) return true;
    return false;
  }

  private broadcastHeartbeat(): void {
    for (const [socket, state] of this.clients) {
      this.send(socket, {
        event_id: randomUUID(),
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        session_id: state.sessionId,
        data: {
          subscriptions: Array.from(state.subscriptions),
        },
      });
    }
  }
}

function normalizeStreamEvent(input: any): StreamEvent {
  const type = String(input?.type ?? input?.kind ?? 'runtime_event') as StreamEventType;
  return {
    event_id: input?.event_id ?? randomUUID(),
    type,
    timestamp: input?.timestamp ?? new Date().toISOString(),
    session_id: input?.session_id,
    tab_id: input?.tab_id,
    data: input?.data ?? streamData(input),
  };
}

function streamData(input: any): Record<string, any> {
  const data = { ...(input ?? {}) };
  delete data.event_id;
  delete data.type;
  delete data.kind;
  delete data.timestamp;
  delete data.session_id;
  delete data.tab_id;
  return data;
}

function eventSet(value: unknown): Set<string> {
  const raw = Array.isArray(value)
    ? value.flatMap((entry) => String(entry).split(','))
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return new Set(raw.map((entry) => String(entry).trim()).filter(Boolean));
}
