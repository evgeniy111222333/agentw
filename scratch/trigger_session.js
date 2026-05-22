const http = require('http');

const data = JSON.stringify({});

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/api/v2/sessions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Session creation response:', body);
    try {
      const parsed = JSON.parse(body);
      const sessionId = parsed.session_id;
      if (sessionId) {
        console.log(`Successfully created session ${sessionId}!`);
        // Navigate to google.com to show it works
        const navData = JSON.stringify({
          action: 'navigate',
          params: {
            url: 'https://google.com'
          }
        });
        const navOptions = {
          hostname: 'localhost',
          port: 3001,
          path: `/api/v2/sessions/${sessionId}/actions`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': navData.length
          }
        };
        const navReq = http.request(navOptions, (navRes) => {
          let navBody = '';
          navRes.on('data', (c) => navBody += c);
          navRes.on('end', () => {
            console.log('Navigation response:', navBody);
          });
        });
        navReq.write(navData);
        navReq.end();
      }
    } catch (e) {
      console.error('Failed to parse response:', e);
    }
  });
});

req.on('error', (error) => {
  console.error('Error connecting to server:', error);
});

req.write(data);
req.end();
