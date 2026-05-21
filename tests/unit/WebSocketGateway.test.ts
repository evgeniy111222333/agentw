import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { globalEventBus } from '../../src/common/EventBus';
import { WebSocketGateway } from '../../src/layer5_agent_interface/WebSocketGateway';

const sockets: WebSocket[] = [];

describe('WebSocketGateway', () => {
  let server: Server | undefined;
  let gateway: WebSocketGateway | undefined;

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    gateway?.close();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    gateway = undefined;
    server = undefined;
    await delay(10);
  });

  it('keeps JSON-RPC calls working', async () => {
    const router = {
      normalizeJsonRpc: jest.fn((method, params) => ({ action: method, session_id: params.session_id, action_params: params })),
      execute: jest.fn(async () => ({ status: 'success', action: 'snapshot' })),
    };
    const port = await start(router);
    const client = await connect(port, 'session-1');
    const { socket } = client;

    expect(await client.next()).toEqual(expect.objectContaining({ type: 'connected' }));
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'snapshot',
      params: { session_id: 'session-1' },
      id: 'rpc-1',
    }));

    expect(await client.next()).toEqual({
      jsonrpc: '2.0',
      result: { status: 'success', action: 'snapshot' },
      id: 'rpc-1',
    });
    socket.close();
  });

  it('streams subscribed events and can replay buffered events', async () => {
    const port = await start();
    const client = await connect(port, 'session-1');
    const { socket } = client;

    expect(await client.next()).toEqual(expect.objectContaining({ type: 'connected' }));
    socket.send(JSON.stringify({ type: 'subscribe', events: ['console', 'page_changed'], id: 'sub-1' }));
    expect(await client.next()).toEqual(expect.objectContaining({
      type: 'subscribed',
      id: 'sub-1',
      events: ['console', 'page_changed'],
    }));

    await globalEventBus.publish('stream_event', {
      type: 'console',
      session_id: 'session-1',
      tab_id: 'tab-1',
      timestamp: '2026-05-18T00:00:00.000Z',
      data: { text: 'ready' },
    });

    const streamed = await client.next();
    expect(streamed).toEqual(expect.objectContaining({
      type: 'console',
      session_id: 'session-1',
      tab_id: 'tab-1',
      data: { text: 'ready' },
    }));

    socket.send(JSON.stringify({ type: 'replay', events: ['console'], id: 'replay-1' }));
    expect(await client.next()).toEqual(expect.objectContaining({ type: 'replay_started', id: 'replay-1', count: 1 }));
    expect(await client.next()).toEqual(expect.objectContaining({ type: 'console', session_id: 'session-1' }));
    expect(await client.next()).toEqual(expect.objectContaining({ type: 'replay_done', id: 'replay-1', count: 1 }));
    socket.close();
  });

  it('responds to ping without requiring a subscription', async () => {
    const port = await start();
    const client = await connect(port, 'session-1');
    const { socket } = client;

    await client.next();
    socket.send(JSON.stringify({ type: 'ping', id: 'ping-1' }));
    expect(await client.next()).toEqual(expect.objectContaining({
      type: 'pong',
      id: 'ping-1',
      session_id: 'session-1',
    }));
    socket.close();
  });

  it('rejects session WebSocket connections without a valid token when enforced', async () => {
    const router = {
      ...fakeRouter(),
      verifyWebSocketToken: jest.fn((sessionId: string, token?: string) => token === `token:${sessionId}`),
    };
    const port = await start(router);

    await expect(connectClosed(port, 'session-1')).resolves.toBe(1008);

    const client = await connect(port, 'session-1', 'token:session-1');
    const { socket } = client;
    expect(await client.next()).toEqual(expect.objectContaining({
      type: 'connected',
      protocol: 'prism.ws.v2',
      protocol_aliases: ['llm-browser.ws.v2'],
    }));
    socket.close();
  });

  async function start(router: any = fakeRouter()): Promise<number> {
    server = createServer();
    gateway = new WebSocketGateway(server, router);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }
});

function fakeRouter(): any {
  return {
    normalizeJsonRpc: jest.fn((method, params) => ({ action: method, session_id: params.session_id, action_params: params })),
    execute: jest.fn(async () => ({ status: 'success' })),
  };
}

function connect(port: number, sessionId: string, token?: string): Promise<{ socket: WebSocket; next: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ session_id: sessionId });
    if (token) params.set('token', token);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws?${params}`);
    sockets.push(socket);
    const messages: any[] = [];
    const waiters: Array<(message: any) => void> = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    });
    socket.on('open', () => resolve({
      socket,
      next: () => {
        const next = messages.shift();
        if (next) return Promise.resolve(next);
        return new Promise((messageResolve, messageReject) => {
          const timer = setTimeout(() => messageReject(new Error('timed out waiting for WebSocket message')), 1000);
          waiters.push((message) => {
            clearTimeout(timer);
            messageResolve(message);
          });
        });
      },
    }));
    socket.on('error', reject);
  });
}

function connectClosed(port: number, sessionId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws?session_id=${encodeURIComponent(sessionId)}`);
    sockets.push(socket);
    socket.on('close', (code) => resolve(code));
    socket.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
