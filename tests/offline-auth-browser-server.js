/* Disposable browser fixture server, never the user's localhost:8000 profile.
   node tests/offline-auth-browser-server.js
   Open http://localhost:8033/?dev=1&fixtureOffline=1, reload, then use
   ?dev=1&fixtureOffline=0 to verify a mocked online reconnection.
   Only the Auth GET is mocked; REST/mutation calls are refused. This simulates
   navigator offline, not a true DevTools network-offline shell test. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), owner = '00000000-0000-4000-8000-000000000099';
const shim = `
window.CAP_SUPABASE_CONFIG={url:location.origin,publishableKey:'fixture-only'};
Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>new URLSearchParams(location.search).get('fixtureOffline')!=='1'});
if(!localStorage.getItem('offline-auth-fixture-initialized')){
  localStorage.setItem('cap_supabase_session',JSON.stringify({access_token:'fixture-token',refresh_token:'fixture-refresh',expires_at:1,user:{id:'${owner}'}}));
  localStorage.setItem('offline-auth-fixture-initialized','1');
}
`;
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:8033');
  if (url.pathname.startsWith('/rest/v1/') || req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' }); res.end('{"message":"Fixture refuses mutations and data API"}'); return;
  }
  if (url.pathname === '/auth/v1/user') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ id: owner })); return;
  }
  if (url.pathname === '/supabase-config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }); res.end(shim); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}).listen(8033, '127.0.0.1', () => console.log('Disposable offline-auth fixture: http://localhost:8033/?dev=1&fixtureOffline=1 (no live Supabase)'));
