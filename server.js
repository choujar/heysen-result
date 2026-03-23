const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 9090;
const API_BASE = 'https://results-display-current-prod.azurewebsites.net';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function proxyRequest(apiPath, res) {
  const url = `${API_BASE}${apiPath}`;
  https.get(url, (apiRes) => {
    if (apiRes.statusCode === 304) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(apiRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    apiRes.pipe(res);
  }).on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
}

const server = http.createServer((req, res) => {
  // Proxy API requests
  if (req.url.startsWith('/api/')) {
    const apiPath = req.url.replace('/api', '');
    proxyRequest(apiPath, res);
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Heysen Results → http://localhost:${PORT}`);
});
