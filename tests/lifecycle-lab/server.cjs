'use strict';
const http = require('node:http'), https = require('node:https'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { PROTOCOL, KEYS } = require('./isolation.js');
const FILES = Object.freeze({
  '/lab/': ['index.html', 'text/html'], '/lab/page.js': ['page.js', 'text/javascript'],
  '/lab/guards.js': ['guards.js', 'text/javascript'], '/lab/core.js': ['core.js', 'text/javascript'],
  '/lab/isolation.js': ['isolation.js', 'text/javascript'],
  '/lab/icon.svg': ['icon.svg', 'image/svg+xml']
});
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function createLab(options = {}) {
  const run = crypto.randomUUID(), records = [];
  const workers = new Map(), markers = new Map();
  function policy(origin) {
    if (!markers.has(origin)) markers.set(origin, Object.fromEntries(['local', 'session'].map(area => [area, {
      key: KEYS[area], value: JSON.stringify({ protocol: PROTOCOL, run, origin, area, token: crypto.randomUUID() })
    }])));
    return { protocol: PROTOCOL, run, origin, markers: markers.get(origin), workers: [...workers.values()].filter(w => new URL(w.url).origin === origin) };
  }
  let sequence = 0, dropped = 0, revision = 1, skip = false, claim = false;
  const append = event => {
    records.push({ ...event, server_sequence: ++sequence, received_at: new Date().toISOString() });
    if (records.length > 20000) { records.shift(); dropped++; }
  };
  async function body(req) {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 32768) throw Error('too-large'); }
    return JSON.parse(text);
  }
  const handler = async (req, res) => {
    const send = (code, type, value) => {
      res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ...(type === 'text/javascript' ? { 'Service-Worker-Allowed': '/lab/' } : {}) });
      res.end(value);
    };
    const json = (code, value) => send(code, 'application/json', JSON.stringify(value));
    try {
      const origin = new URL(`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`).origin;
      const url = new URL(req.url, origin), p = url.pathname;
      // No generic file serving, redirects, proxy, CORS, production assets or RPC routes.
      if (req.method === 'POST') {
        // Same-origin browser requests only. No cross-site lab control.
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'cross-site' });
        if (req.headers.origin && req.headers.origin !== `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`) return json(403, { error: 'origin' });
        const data = await body(req);
        if (data.run !== run) return json(403, { error: 'run-token' });
        if (p === '/__lab/log') { append(data.event); return json(200, { ok: true }); }
        if (p === '/__lab/settings') {
          if (typeof data.skip !== 'boolean' || typeof data.claim !== 'boolean') return json(400, { error: 'settings' });
          revision++; skip = data.skip; claim = data.claim;
          append({ source: 'server', event: 'revision-changed', revision, skip, claim });
          return json(200, { revision, skip, claim });
        }
        return json(404, { error: 'not-a-lab-route' });
      }
      if (req.method !== 'GET') return json(405, { error: 'method' });
      if (p === '/__lab/settings') return json(200, { run, revision, skip, claim, promotionAllowed: false, isolation: policy(origin) });
      if (p === '/__lab/report') return json(200, { schema: 'cap-lifecycle-evidence/1', run,
        safety: { promotionAllowed: false, productionStateAccess: false, certification: 'UNVERIFIED' },
        dropped_records: dropped,
        ordering: 'source_sequence is local order; server_sequence is receipt order only; timestamps are diagnostic',
        records });
      if (p === '/lab/manifest.json') return json(200, { id: '/lab/', name: 'Cap Isolated Lifecycle Lab', short_name: 'Lifecycle Lab',
        start_url: '/lab/?manual=1', scope: '/lab/', display: 'standalone', icons: [{ src: '/lab/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });
      if (p === '/lab/service-worker.js') {
        const instance = url.searchParams.get('cap_worker_instance');
        if ((instance !== null && !uuid(instance)) || [...url.searchParams.keys()].some(k => k !== 'cap_worker_instance') || url.searchParams.getAll('cap_worker_instance').length > 1) return json(400, { error: 'invalid-instance' });
        const id = url.href + '#' + revision;
        if (!workers.has(id)) workers.set(id, { url: url.href, revision, proof: crypto.randomUUID() });
        const prelude = `const LAB = Object.freeze(${JSON.stringify({ run, revision, skip, claim, instance: instance || 'bare-legacy',
          isolationProtocol: PROTOCOL, workerProof: workers.get(id).proof, promotionAllowed: false })});\n`;
        return send(200, 'text/javascript', prelude + fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8'));
      }
      if (p === '/away') return send(200, 'text/html', '<!doctype html><title>Lab away</title><p>Outside worker scope. Use browser Back/Forward.</p>');
      const file = FILES[p];
      if (!file) return json(404, { error: 'not-a-lab-route' });
      return send(200, file[1], fs.readFileSync(path.join(__dirname, file[0])));
    } catch (error) { if (!res.headersSent) json(400, { error: 'invalid-request' }); else res.end(); }
  };
  const server = options.cert && options.key ? https.createServer({ cert: options.cert, key: options.key }, handler) : http.createServer(handler);
  return { server, records, run };
}
if (require.main === module) {
  const args = process.argv.slice(2), arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const host = arg('--host', '127.0.0.1'), port = Number(arg('--port', '0'));
  const certPath = arg('--cert'), keyPath = arg('--key');
  if (Boolean(certPath) !== Boolean(keyPath)) throw Error('Both --cert and --key required');
  if (!certPath && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw Error('LAN physical certification requires trusted HTTPS');
  const { server } = createLab(certPath ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) } : {});
  server.listen(port, host, () => console.log(`ISOLATED LAB ONLY: ${certPath ? 'https' : 'http'}://${host}:${server.address().port}/lab/\nNo production routes; no delivery authority; evidence is memory-only. Export before stopping server.`));
}
module.exports = { createLab, FILES };
