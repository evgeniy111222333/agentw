import { ApiServer } from '../src/layer5_agent_interface/ApiServer';
import { BrowserClient } from '../src/sdk/BrowserClient';

async function run() {
  const server = new ApiServer();
  await server.start();
  
  try {
    const client = new BrowserClient({ baseUrl: 'http://127.0.0.1:3001' });
    const session = await client.createSession();
    
    console.log('Navigating to httpbin.org/forms/post...');
    await session.navigate('https://httpbin.org/forms/post');
    
    console.log('Taking snapshot...');
    const snap = await session.snapshot({ max_elements: 1000 });
    
    // Find the form
    const form = snap.snapshot.elements.find(e => e.type === 'form');
    console.log('Found form:', form?.id);
    
    // Let's use the declarative fillForm action
    // According to SDK, fillForm takes a record of field names to values.
    // In llm-browser, fill_form tries to match fields by semantic label, name, or placeholder.
    console.log('Using fill_form action...');
    const fillRes = await session.fillForm(form?.id || '', {
      'custname': 'Test',
      'comments': 'Hello from AgentW'
    }, true); // true = submit after filling
    
    console.log('Form fill result:', fillRes.status);
    
    console.log('Waiting for response...');
    await session.wait(2000);
    
    const resultSnap = await session.snapshot();
    const preText = resultSnap.snapshot.elements.find(e => e.type === 'text' && e.text?.includes('custname')) || resultSnap.snapshot.elements.find(e => e.type === 'text');
    
    console.log('\n--- Result Page Content ---');
    console.log(preText?.text || JSON.stringify(resultSnap.snapshot.elements.slice(0,5), null, 2));
    
    await session.close();
  } finally {
    await server.stop();
  }
}

run().catch(console.error);
