import { ApiServer } from '../src/layer5_agent_interface/ApiServer';
import { BrowserClient } from '../src/sdk/BrowserClient';

async function run() {
  const server = new ApiServer();
  await server.start();
  
  try {
    const client = new BrowserClient({ baseUrl: 'http://127.0.0.1:3001' });
    const session = await client.createSession();
    
    console.log('Navigating to Amazon search...');
    await session.navigate('https://www.amazon.com/s?k=Sony+WH-1000XM5');
    
    console.log('Waiting for load...');
    await session.wait(3000);
    
    console.log('Taking snapshot...');
    const snap = await session.snapshot({ max_elements: 2000 });
    
    const elements = snap.snapshot.elements;
    
    // Check if we hit a captcha
    const isCaptcha = elements.some(e => e.text && e.text.toLowerCase().includes('type the characters you see in this image'));
    if (isCaptcha) {
      console.log('CAPTCHA detected. Amazon blocked the headless browser.');
    } else {
      console.log('Page loaded successfully. Searching for product information...');
      
      const products = [];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el.text && el.text.toLowerCase().includes('wh-1000xm5')) {
          // Exclude generic strings that just repeat the search query
          if (el.text.length < 15) continue;
          
          let price = 'Price not found near this element';
          // Look ahead up to 15 elements for a price
          for (let j = 1; j <= 15; j++) {
            if (i+j < elements.length) {
              const nearby = elements[i+j];
              if (nearby.text && (nearby.text.includes('$') || /^\d+\.\d{2}$/.test(nearby.text))) {
                price = nearby.text.trim();
                break;
              }
            }
          }
          products.push({ title: el.text.substring(0, 100), price });
        }
      }
      
      // Filter out duplicate titles
      const uniqueProducts = [];
      const seen = new Set();
      for (const p of products) {
        if (!seen.has(p.title) && p.price !== 'Price not found near this element') {
          seen.add(p.title);
          uniqueProducts.push(p);
        }
      }
      
      if (uniqueProducts.length > 0) {
        console.log('\nFound products:');
        uniqueProducts.slice(0, 5).forEach((p, idx) => {
          console.log(`${idx + 1}. ${p.title.replace(/\n/g, ' ')}\n   Price: ${p.price}`);
        });
      } else {
        console.log('Could not find the product or prices. Here are some element texts:');
        console.log(elements.filter(e => e.text && e.text.includes('$')).slice(0, 10).map(e => e.text));
      }
    }
    
    await session.close();
  } finally {
    await server.stop();
  }
}

run().catch(console.error);
