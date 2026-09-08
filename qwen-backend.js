const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;

let PERF;
try {
  PERF = require('./qwen-signal-performance.js');
  PERF.init({
    log: function (...args) { console.log('[PERF]', ...args); },
    broadcast: function (obj) {
      if (wss && wss.clients) {
        for (const c of wss.clients) {
          if (c.readyState === 1) c.send(JSON.stringify(obj));
        }
      }
    }
  });
} catch (e) {
  console.warn('PERF module load warning:', e.message);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Performance API route
  if (url.pathname === '/api/performance') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const data = (PERF && typeof PERF.snapshotJSON === 'function') 
      ? PERF.snapshotJSON() 
      : { status: 'ok', open: [], closed: [] };
    res.end(JSON.stringify(data));
    return;
  }

  // Health check route
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Serve Dashboard UI (HTML)
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/qwen-watcher.html') {
    const htmlPath = path.join(__dirname, 'qwen-watcher.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf8'));
      return;
    }
  }

  // 404 Fallback
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const wss = new WebSocketServer({ server, path: '/feed' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'INIT', msg: 'Connected to Qwen Watcher Feed' }));
});

server.listen(PORT, () => {
  console.log(`Qwen Backend active on port ${PORT}`);
});
