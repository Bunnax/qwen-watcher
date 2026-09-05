const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online', service: 'qwen-watcher' }));
});

server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
