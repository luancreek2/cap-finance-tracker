/* Served ONLY by server.cjs, with an inert LAB prelude. Not a production worker. */
'use strict';
importScripts('/lab/guards.js', '/lab/core.js');
const boot = crypto.randomUUID();
const activation = 'synthetic:' + LAB.instance + ':revision-' + LAB.revision;
let sequence = 0;
const identity = () => ({ worker_instance: LAB.instance, worker_state: 'running', revision: LAB.revision,
  worker_url: self.location.href, activation_identity: activation, activation_identity_kind: 'synthetic-not-a-journal',
  boot_id: boot, user_agent: self.navigator.userAgent, promotionAllowed: false });
async function log(event, detail = {}) {
  await fetch('/__lab/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run: LAB.run, event: { source: 'worker', source_sequence: ++sequence,
      diagnostic_time: Date.now(), monotonic: performance.now(), ...identity(), event, ...detail } }) });
}
async function census() {
  const [all, controlled] = await Promise.all([
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
    self.clients.matchAll({ type: 'window' })
  ]);
  const ids = new Set(controlled.map(c => c.id));
  return all.map(c => ({ id: c.id, url: c.url, controlled: ids.has(c.id), visibility: c.visibilityState,
    participates: new URL(c.url).pathname !== '/away',
    frame_type: c.frameType, focused: c.focused })).sort((a, b) => a.id.localeCompare(b.id));
}
const nonce = () => [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2, '0')).join('');
self.addEventListener('install', event => event.waitUntil((async () => {
  await log('install', { worker_state: 'installing', skip: LAB.skip, claim: LAB.claim });
  if (LAB.skip) await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  await log('activate', { worker_state: 'activating', clients: await census() });
  if (LAB.claim) await self.clients.claim();
  await log('activation-handler-complete', { clients: await census() });
})()));
async function challenge(port) {
  const start = performance.now(), ports = [];
  const phase = name => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { port.onmessage = null; reject(Error('phase-ack-timeout')); }, 1000);
    port.onmessage = event => {
      if (event.data?.type === 'PHASE_ACK' && event.data.phase === name) {
        clearTimeout(timer); port.onmessage = null; resolve();
      }
    };
    port.postMessage({ type: 'RACE_PHASE', phase: name });
  });
  try {
    await phase('before-census');
    const first = await census();
    const request = { type: 'CAP_NOTIFICATION_COMPAT_CHALLENGE', protocol: 1, purpose: 'promotion',
      worker_instance_id: LAB.instance, activation_id: activation, barrier_id: crypto.randomUUID(),
      challenge_nonce: nonce(), epoch: '1', intent_id: null,
      required_capabilities: [...LifecycleProtocol.CAPABILITIES] };
    const attempt = new LifecycleProtocol.Attempt(request, first.filter(c => c.participates), performance.now());
    await log('initial-census', { barrier_id: request.barrier_id, clients: first });
    for (const info of first.filter(c => c.participates)) {
      const client = await self.clients.get(info.id);
      if (!client) continue;
      const channel = new MessageChannel(); ports.push(channel.port1);
      channel.port1.onmessage = event => attempt.receive(info.id, event.data, performance.now());
      client.postMessage({ ...request, target_client_id: info.id }, [channel.port2]);
    }
    await phase('during-census');
    // Full response window also exposes duplicate replies; wall clocks never order decisions.
    await new Promise(resolve => setTimeout(resolve, 2000));
    const final = await census();
    const result = attempt.finish(final.filter(c => c.participates), performance.now());
    await log('final-census', { barrier_id: request.barrier_id, clients: final, result });
    await phase('after-final-census');
    await phase('boundary');
    await log('synthetic-promotion-boundary', { barrier_id: request.barrier_id, clients: await census(),
      diagnosticCompatibility: result.diagnosticCompatibility, promotionAllowed: false,
      warning: 'Marker only. This does not promote, authorize, or prove future document absence.' });
    await phase('after-boundary');
    const after = await census();
    await log('after-boundary-census', { barrier_id: request.barrier_id, clients: after });
    if (performance.now() - start > 5000) result.failures.push('total-attempt-deadline');
    result.diagnosticCompatibility = result.failures.length === 0;
    port.postMessage({ type: 'RESULT', barrier_id: request.barrier_id, result, first, final, after });
  } finally { for (const p of ports) p.close(); }
}
self.addEventListener('message', event => {
  const port = event.ports[0], source = event.source;
  if (!port || !source?.url || new URL(source.url).origin !== self.location.origin ||
      !new URL(source.url).pathname.startsWith('/lab/')) return;
  event.waitUntil((async () => {
    try {
      if (event.data?.type === 'LAB_ISOLATION_CHALLENGE') {
        port.postMessage({ type: 'LAB_ISOLATION_RESPONSE', protocol: LAB.isolationProtocol,
          run: LAB.run, url: self.location.href, revision: LAB.revision,
          proof: LAB.workerProof, nonce: event.data.nonce, promotionAllowed: false });
      } else if (event.data?.type === 'PROBE') {
        const result = { ...identity(), requester_client_id: source.id, clients: await census(), blocked_attempts: LifecycleSafety.report() };
        await log('probe', { requester: source.id, clients: result.clients });
        port.postMessage({ type: 'RESULT', result });
      } else if (event.data?.type === 'CHALLENGE') await challenge(port);
      else port.postMessage({ type: 'ERROR', error: 'unknown-command' });
    } catch (error) {
      await log('attempt-failed', { error: error.message });
      port.postMessage({ type: 'ERROR', error: error.message, promotionAllowed: false });
    }
  })());
});
