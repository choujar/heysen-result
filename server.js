const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 9090;
const API_BASE = 'https://apim-ecsa-production.azure-api.net/results-display';
const SHEET_ID = '1fOXmXo89xGFGk1EVtuRADdQuvoIPHcR-FncbTZDAMbk';

// Load Google credentials for sheet proxy
var googleCreds = null;
var googleToken = null;
try {
  var credsPath = path.join(require('os').homedir(), '.config/cosmo/google-credentials-web.json');
  var tokenPath = path.join(require('os').homedir(), '.config/cosmo/google-tokens/greens.json');
  googleCreds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  googleToken = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
} catch (e) { console.warn('Google creds not found, /api/sheet will be unavailable'); }

function refreshAccessToken() {
  return new Promise(function(resolve, reject) {
    if (!googleCreds || !googleToken) return reject(new Error('no creds'));
    var client = googleCreds.web || googleCreds.installed;
    var postData = new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: googleToken.refresh_token,
      grant_type: 'refresh_token'
    }).toString();
    var req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, function(r) {
      var body = '';
      r.on('data', function(c) { body += c; });
      r.on('end', function() {
        try { var d = JSON.parse(body); resolve(d.access_token || null); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function fetchSheetCSV(accessToken) {
  return new Promise(function(resolve, reject) {
    function follow(url, depth) {
      if (depth > 5) return reject(new Error('too many redirects'));
      https.get(url, { headers: { Authorization: 'Bearer ' + accessToken } }, function(r) {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          follow(r.headers.location, depth + 1);
          return;
        }
        var body = '';
        r.on('data', function(c) { body += c; });
        r.on('end', function() { resolve(body); });
      }).on('error', reject);
    }
    follow('https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/export?format=csv&gid=0', 0);
  });
}

function parseSheetCSV(csv) {
  var rows = []; var current = ''; var inQuote = false;
  for (var i = 0; i < csv.length; i++) {
    var ch = csv[i];
    if (ch === '"') { if (inQuote && csv[i+1] === '"') { current += '"'; i++; } else { inQuote = !inQuote; } }
    else if (ch === ',' && !inQuote) { if (rows.length === 0) rows.push([current]); else rows[rows.length-1].push(current); current = ''; }
    else if ((ch === '\n' || ch === '\r') && !inQuote) { if (ch === '\r' && csv[i+1] === '\n') i++; if (rows.length === 0) rows.push([current]); else rows[rows.length-1].push(current); current = ''; rows.push([]); }
    else { current += ch; }
  }
  if (current) { if (rows.length === 0) rows.push([current]); else rows[rows.length-1].push(current); }

  var heysen = null;
  for (var r = 0; r < Math.min(rows.length, 10); r++) {
    if (rows[r] && rows[r][1] && rows[r][1].trim() === 'Heysen') {
      var row = rows[r];
      heysen = {
        voters: (row[2]||'').trim(), booths: (row[3]||'').trim(), expectedVotes: (row[4]||'').trim(),
        postals: (row[5]||'').trim(), prepoll: (row[6]||'').trim(), electionDay: (row[7]||'').trim(),
        boothsCounted: (row[8]||'').trim(), votes: (row[9]||'').trim(), pctCounted: (row[11]||'').trim(),
        grnPct: (row[12]||'').trim(), alpPct: (row[13]||'').trim(), libPct: (row[14]||'').trim(),
        swing: (row[15]||'').trim(), tcp3_grn: (row[16]||'').trim(), tcp3_alp: (row[17]||'').trim(),
        tcp3_lib: (row[18]||'').trim(), tcp3_swing: (row[19]||'').trim(), tcp2_grn: (row[20]||'').trim(),
        tcp2_alp: (row[21]||'').trim(), tcp2_lib: (row[22]||'').trim(),
        feedUpdated: (row[25]||'').trim(), lastChecked: (row[26]||'').trim()
      };
      break;
    }
  }

  var htv = [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (!row || !row[17]) continue;
    var name = row[17].trim();
    if (name && name !== 'Cand' && name.includes('(') && name.includes(')')) {
      htv.push({ candidate: name, tcp3: (row[19]||'').trim(), tcp3_source: (row[20]||'').trim(), tcp2: (row[21]||'').trim(), tcp2_source: (row[22]||'').trim() });
    }
  }

  return { heysen: heysen, htv: htv };
}

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
  // Sheet data proxy
  if (req.url === '/api/sheet') {
    refreshAccessToken().then(function(token) {
      return fetchSheetCSV(token);
    }).then(function(csv) {
      var data = parseSheetCSV(csv);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch(function(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // Proxy ECSA API requests
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
