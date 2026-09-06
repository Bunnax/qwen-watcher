const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', service: 'qwen-watcher' }));
  } else {
    fs.readFile(path.join(__dirname, 'qwen-watcher.html'), (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading dashboard');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
