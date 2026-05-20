const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const sessionId = '31034855-eeb5-4846-a889-4b95687ba590';
const wsUrl = `ws://localhost:3001/api/v2/ws?session_id=${sessionId}`;
const ws = new WebSocket(wsUrl);

const events = [];
const logPath = path.join(__dirname, 'events_log.json');

ws.on('open', () => {
  console.log('Connected to WS server');
  const subscribeMsg = {
    type: 'subscribe',
    events: ['page_changed', 'action_completed'],
    replay: true
  };
  ws.send(JSON.stringify(subscribeMsg));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    console.log('Received event:', msg.type || msg.event);
    events.push(msg);
    fs.writeFileSync(logPath, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error('Error parsing message:', err);
  }
});

ws.on('error', (err) => {
  console.error('WS Error:', err);
});

ws.on('close', () => {
  console.log('WS Connection closed');
});
