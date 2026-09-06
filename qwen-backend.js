const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname)));
app.use(express.json());

let cbSocket = null;
let upstreamStatus = 'CLOSED';
const clients = new Set();

function connectUpstream() {
  console.log('[qwen-backend] Connecting to Coinbase Advanced Trade WS...');
  upstreamStatus = 'CONNECTING';
  
  try {
    cbSocket = new WebSocket('wss://advanced-trade-ws.coinbase.com');

    cbSocket.on('open', () => {
      console.log('[qwen-backend] upstream OPEN');
      upstreamStatus = 'OPEN';
      const subscribeMsg = {
        type: 'subscribe',
        product_ids: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
        channel: 'ticker'
      };
      cbSocket.send(JSON.stringify(subscribeMsg));
    });

    cbSocket.on('message', (data) => {
      const msg = data.toString();
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    });

    cbSocket.on('close', () => {
      console.log('[qwen-backend] upstream CLOSED');
      upstreamStatus = 'CLOSED';
      setTimeout(connectUpstream, 5000);
    });

    cbSocket.on('error', (err) => {
      console.error('[qwen-backend] upstream ERROR:', err.message);
      upstreamStatus = 'ERROR';
    });
  } catch (err) {
    console.error('[qwen-backend] Exception during connect:', err.message);
    upstreamStatus = 'ERROR';
    setTimeout(connectUpstream, 5000);
  }
}

connectUpstream();

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/feed') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    upstream: upstreamStatus,
    clientCount: clients.size,
    timestamp: new Date().toISOString()
  });
});

server.listen(PORT, () => {
  console.log(`[qwen-backend] Server listening on port ${PORT}`);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
