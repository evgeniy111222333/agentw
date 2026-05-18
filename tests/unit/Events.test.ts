import { EventEmitter } from 'events';
import { Events } from '../../src/obs/Events';

describe('Events', () => {
  it('records network, console, and page errors with redacted URLs', () => {
    const events = new Events(20);
    const page = new EventEmitter();
    events.attach('session', 'tab-1', page as any);

    const request = fakeRequest('https://app.test/api?token=secret&query=ok');
    page.emit('request', request);
    page.emit('response', fakeResponse(request, 200));
    page.emit('console', {
      type: () => 'error',
      text: () => 'client error',
      location: () => ({ url: 'https://app.test/app?code=secret', lineNumber: 3, columnNumber: 9 }),
    });
    page.emit('pageerror', new Error('boom'));

    const recorded = events.list('session', { limit: 10 });

    expect(recorded).toHaveLength(4);
    expect(JSON.stringify(recorded)).not.toContain('secret');
    expect(recorded.find((event) => event.kind === 'response')).toEqual(expect.objectContaining({
      status: 200,
      ok: true,
      request_id: recorded.find((event) => event.kind === 'request')?.request_id,
    }));
    expect(events.stats('session')).toEqual(expect.objectContaining({
      total: 4,
      recent_errors: 2,
    }));
  });

  it('filters by tab and event kind and enforces retention', () => {
    const events = new Events(2);
    const first = new EventEmitter();
    const second = new EventEmitter();
    events.attach('session', 'tab-1', first as any);
    events.attach('session', 'tab-2', second as any);

    first.emit('console', fakeConsole('log', 'one'));
    second.emit('console', fakeConsole('warning', 'two'));
    second.emit('pageerror', new Error('three'));

    expect(events.list('session')).toHaveLength(2);
    expect(events.list('session', { tab_id: 'tab-2' })).toHaveLength(2);
    expect(events.list('session', { kind: 'console' })).toHaveLength(1);

    events.clear('session');
    expect(events.stats('session').total).toBe(0);
  });

  it('records navigation, dialog, and download browser events', async () => {
    const events = new Events(20);
    const page: any = new EventEmitter();
    const mainFrame = { url: () => 'https://app.test/page?token=secret' };
    page.mainFrame = () => mainFrame;
    page.title = () => Promise.resolve('Page Title');
    page.url = () => 'https://app.test/page';
    events.attach('session', 'tab-1', page);

    const dismiss = jest.fn(() => Promise.resolve());
    page.emit('framenavigated', mainFrame);
    page.emit('dialog', {
      type: () => 'alert',
      message: () => 'confirm it',
      defaultValue: () => '',
      dismiss,
    });
    page.emit('download', {
      url: () => 'https://app.test/file.csv?code=secret',
      suggestedFilename: () => 'file.csv',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const recorded = events.list('session', { limit: 10 });
    expect(recorded.map((event) => event.kind)).toEqual(['dialog', 'download', 'navigation']);
    expect(recorded.find((event) => event.kind === 'dialog')).toEqual(expect.objectContaining({
      dialog_type: 'alert',
      text: 'confirm it',
      handled: 'dismissed',
    }));
    expect(recorded.find((event) => event.kind === 'download')).toEqual(expect.objectContaining({
      file_name: 'file.csv',
    }));
    expect(JSON.stringify(recorded)).not.toContain('secret');
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

function fakeRequest(url: string): any {
  return {
    method: () => 'GET',
    url: () => url,
    resourceType: () => 'fetch',
    failure: () => undefined,
  };
}

function fakeResponse(request: any, status: number): any {
  return {
    request: () => request,
    status: () => status,
    statusText: () => 'OK',
    url: () => request.url(),
  };
}

function fakeConsole(type: string, text: string): any {
  return {
    type: () => type,
    text: () => text,
    location: () => ({ url: '', lineNumber: 0, columnNumber: 0 }),
  };
}
