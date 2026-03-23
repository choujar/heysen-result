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
const API_BASE = 'https://results-display-current-prod.azurewebsites.net';

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
  async fetch(request) {
    const url = new URL(request.url);

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
