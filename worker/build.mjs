#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read the HTML page
let html = readFileSync(join(__dirname, '..', 'index.html'), 'utf-8');

// Change API path from /api to the real ECSA endpoint
// The worker will proxy /api/* requests to ECSA, so we keep /api
// (the worker handles both serving HTML and proxying API)

// Escape for embedding in template literal
const escapedHtml = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

var PASSWORD = process.env.HEYSEN_PASSWORD || '1000Votes!';

const workerCode = `
const PASSWORD = '${PASSWORD}';
const COOKIE_NAME = 'heysen_auth';
const COOKIE_MAX_AGE = 86400 * 7; // 7 days
const API_BASE = 'https://apim-ecsa-production.azure-api.net/results-display';
const SHEET_ID = '1fOXmXo89xGFGk1EVtuRADdQuvoIPHcR-FncbTZDAMbk';

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]*)'));
  return match ? match[1] : null;
}

async function hashPassword(pw) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pw + '_heysen_salt_2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getAccessToken(env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params });
  const data = await res.json();
  return data.access_token || null;
}

async function fetchSheet(env) {
  const token = await getAccessToken(env);
  if (!token) return { error: 'auth_failed' };
  const url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/export?format=csv&gid=0';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) return { error: 'sheet_fetch_failed', status: res.status };
  const csv = await res.text();
  return parseSheetCSV(csv);
}

function parseSheetCSV(csv) {
  var rows = [];
  var current = '';
  var inQuote = false;
  for (var i = 0; i < csv.length; i++) {
    var ch = csv[i];
    if (ch === '"') {
      if (inQuote && csv[i+1] === '"') { current += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      rows.length === 0 ? rows.push([current]) : rows[rows.length-1].push(current);
      current = '';
    } else if ((ch === '\\n' || ch === '\\r') && !inQuote) {
      if (ch === '\\r' && csv[i+1] === '\\n') i++;
      if (rows.length === 0) rows.push([current]); else rows[rows.length-1].push(current);
      current = '';
      rows.push([]);
    } else {
      current += ch;
    }
  }
  if (current || (rows.length > 0 && rows[rows.length-1].length > 0)) {
    if (rows.length === 0) rows.push([current]); else rows[rows.length-1].push(current);
  }

  // find Heysen row in the top section (first 10 rows) — col 0 is empty (col A)
  var heysen = null;
  for (var r = 0; r < Math.min(rows.length, 10); r++) {
    if (rows[r] && rows[r][1] && rows[r][1].trim() === 'Heysen') {
      var row = rows[r];
      heysen = {
        voters: (row[2] || '').trim(),
        booths: (row[3] || '').trim(),
        expectedVotes: (row[4] || '').trim(),
        postals: (row[5] || '').trim(),
        prepoll: (row[6] || '').trim(),
        electionDay: (row[7] || '').trim(),
        boothsCounted: (row[8] || '').trim(),
        votes: (row[9] || '').trim(),
        pctCounted: (row[11] || '').trim(),
        grnPct: (row[12] || '').trim(),
        alpPct: (row[13] || '').trim(),
        libPct: (row[14] || '').trim(),
        swing: (row[15] || '').trim(),
        tcp3_grn: (row[16] || '').trim(),
        tcp3_alp: (row[17] || '').trim(),
        tcp3_lib: (row[18] || '').trim(),
        tcp3_swing: (row[19] || '').trim(),
        tcp2_grn: (row[20] || '').trim(),
        tcp2_alp: (row[21] || '').trim(),
        tcp2_lib: (row[22] || '').trim(),
        feedUpdated: (row[25] || '').trim(),
        lastChecked: (row[26] || '').trim()
      };
      break;
    }
  }

  // find feed timestamps and HTV data
  var feedUpdated = '';
  var lastChecked = '';
  var htv = [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (!row) continue;
    // timestamps are in col 25-26 of the Heysen row area
    for (var c = 0; c < row.length; c++) {
      if (row[c] && row[c].trim() === 'Feed updated:' && row[c+1]) feedUpdated = row[c+1].trim();
      if (row[c] && row[c].trim() === 'Last checked:' && row[c+1]) lastChecked = row[c+1].trim();
    }
    // HTV: candidate name in col 17, 3cp preference in col 19, 2cp in col 21
    if (row[17] && row[17].trim() && row[17].trim() !== 'Cand' && row[17].trim() !== '') {
      var name = row[17].trim();
      if (name.includes('(') && name.includes(')')) {
        htv.push({
          candidate: name,
          tcp3: (row[19] || '').trim(),
          tcp3_source: (row[20] || '').trim(),
          tcp2: (row[21] || '').trim(),
          tcp2_source: (row[22] || '').trim()
        });
      }
    }
  }

  return { heysen: heysen, htv: htv, feedUpdated: feedUpdated, lastChecked: lastChecked };
}

const LOGIN_PAGE = \`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Heysen Results</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Nunito Sans', -apple-system, sans-serif; background: #f5f7f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { background: #fff; padding: 40px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); text-align: center; max-width: 360px; width: 90%; }
  h2 { color: #009949; margin-bottom: 8px; }
  p { color: #666; font-size: 0.85em; margin-bottom: 20px; }
  input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 1em; margin-bottom: 12px; box-sizing: border-box; }
  input:focus { outline: none; border-color: #009949; }
  button { width: 100%; padding: 10px; background: #009949; color: #fff; border: none; border-radius: 6px; font-size: 1em; cursor: pointer; font-weight: 600; }
  button:hover { background: #006630; }
  .err { color: #d32f2f; font-size: 0.82em; margin-top: 8px; display: none; }
</style>
</head><body>
<div class="box">
  <h2>Heysen Results</h2>
  <p>SA 2026 Election — Preference Simulator</p>
  <form method="POST" action="/">
    <input type="password" name="password" placeholder="Password" autofocus required>
    <button type="submit">Enter</button>
  </form>
  <div class="err" id="err">Incorrect password</div>
</div>
<script>
  if (location.search.includes('err=1')) document.getElementById('err').style.display = 'block';
</script>
</body></html>\`;

const PAGE_HTML = \`${escapedHtml}\`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Sheet data proxy (auth required — same cookie check)
    if (url.pathname === '/api/sheet') {
      const token = getCookie(request, COOKIE_NAME);
      const validToken = await hashPassword(PASSWORD);
      if (token !== validToken) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const data = await fetchSheet(env);
        return new Response(JSON.stringify(data), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Proxy API requests (no auth required for API — data is public)
    if (url.pathname.startsWith('/api/')) {
      const apiPath = url.pathname.replace('/api', '');
      const apiUrl = API_BASE + apiPath;
      const apiRes = await fetch(apiUrl, {
        headers: { 'Accept': 'application/json' },
      });
      return new Response(apiRes.body, {
        status: apiRes.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        }
      });
    }

    // POST = login attempt
    if (request.method === 'POST') {
      const body = await request.formData();
      const pw = body.get('password') || '';
      if (pw === PASSWORD) {
        const token = await hashPassword(pw);
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/',
            'Set-Cookie': COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + COOKIE_MAX_AGE,
          }
        });
      }
      return Response.redirect(url.origin + '/?err=1', 302);
    }

    // GET = check auth
    const token = getCookie(request, COOKIE_NAME);
    const validToken = await hashPassword(PASSWORD);
    if (token !== validToken) {
      return new Response(LOGIN_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
};
`;

writeFileSync(join(__dirname, 'worker.js'), workerCode);
console.log('Built worker.js (' + Math.round(workerCode.length / 1024) + ' KB)');
