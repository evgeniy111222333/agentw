
import { ApiServer } from '../src/layer5_agent_interface/ApiServer';
import { BrowserClient } from '../src/sdk/BrowserClient';
import * as fs from 'fs';

async function run() {
  const server = new ApiServer();
  await server.start();
  
  try {
    const client = new BrowserClient({ baseUrl: 'http://127.0.0.1:3001' });
    const session = await client.createSession();
    
    console.log('Navigating to Wikipedia (Штучний інтелект)...');
    await session.navigate('https://uk.wikipedia.org/wiki/%D0%A8%D1%82%D1%83%D1%87%D0%BD%D0%B8%D0%B9_%D1%96%D0%BD%D1%82%D0%B5%D0%BB%D0%B5%D0%BA%D1%82');
    
    console.log('Taking snapshot...');
    const snap = await session.snapshot({ max_elements: 1000 });
    
    fs.writeFileSync('scratch/wiki_snapshot.json', JSON.stringify(snap.snapshot.elements, null, 2));
    console.log('Snapshot saved to scratch/wiki_snapshot.json with ' + snap.snapshot.elements.length + ' elements.');
    
    await session.close();
  } finally {
    await server.stop();
  }
}
run().catch(console.error);

