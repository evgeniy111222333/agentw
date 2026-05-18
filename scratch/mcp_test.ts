import { McpServer } from '../src/mcp/McpServer';
import { BrowserCore } from '../src/layer1_browser_core/BrowserCore';

async function run() {
  const server = new (McpServer as any)();
  
  // Directly access the handler map for testing
  const listResponse = await server.server.requestHandlers.get('tools/list')();
  console.log('Tools:', listResponse.tools.map((t: any) => t.name));

  const handler = server.server.requestHandlers.get('tools/call');

  // 1. Navigate
  console.log('Navigating...');
  await handler({
    params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } }
  } as any);

  // 2. Snapshot 1
  console.log('Fetching initial snapshot...');
  const snap1 = await handler({
    params: { name: 'browser_snapshot', arguments: {} }
  } as any);
  
  const snap1Data = JSON.parse(snap1.content[0].text);
  const snap1Size = snap1.content[0].text.length;
  console.log(`Snapshot 1 size: ${snap1Size} chars, Elements: ${snap1Data.elements.length}`);
  
  // 3. Snapshot 2 (Delta Only)
  console.log('Fetching delta snapshot...');
  const snap2 = await handler({
    params: { name: 'browser_snapshot', arguments: { from_snapshot_id: snap1Data.snapshot_id, delta_only: true } }
  } as any);

  const snap2Data = JSON.parse(snap2.content[0].text);
  const snap2Size = snap2.content[0].text.length;
  console.log(`Snapshot 2 (Delta) size: ${snap2Size} chars`);
  
  console.log(`Savings: ${((1 - snap2Size / snap1Size) * 100).toFixed(2)}%`);
  
  await server.stop();
  process.exit(0);
}

run().catch(console.error);
