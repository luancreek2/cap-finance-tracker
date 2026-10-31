'use strict';
(() => {
  const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
  const pageToken = crypto.randomUUID();
  let settings, sequence = 0, ready = false, raceWindow = null, racePhase = null;
  let issued = 0, completed = 0, commandBusy = false, lastResult = null;
  let knownClientId = null, logFailures = 0;
  let isolationDiagnostics = null, initialRun = null, diagnosticRun = null;
  const watched = new WeakSet(), local = [];
  $('mode').value = params.get('mode') || 'compatible';
  const displayMode = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser';
  const metadata = () => ({ page_token: pageToken, user_agent: navigator.userAgent,
    display_mode: displayMode(), client_id: knownClientId, url: location.href, visibility: document.visibilityState,
    controlled: !!navigator.serviceWorker.controller, controller: navigator.serviceWorker.controller?.scriptURL || null,
    mode: $('mode').value });
  async function log(event, detail = {}) {
    const record = { source: 'page', source_sequence: ++sequence, diagnostic_time: Date.now(),
      monotonic: performance.now(), ...metadata(), event, ...detail };
    local.push(record);
    $('output').textContent = JSON.stringify(local.slice(-18), null, 2);
    if (settings || diagnosticRun) {
      try {
        const res = await fetch('/__lab/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ run: diagnosticRun || settings.run, event: record }), keepalive: true });
        if (!res.ok) logFailures++;
      } catch (_) { logFailures++; }
    }
  }
  function watch(worker) {
    if (!worker || watched.has(worker)) return;
    watched.add(worker);
    const record = () => log('worker-state', { worker_url: worker.scriptURL, worker_state: worker.state });
    worker.addEventListener('statechange', record); record();
  }
  function watchRegistration(registration) {
    for (const worker of [registration.installing, registration.waiting, registration.active]) watch(worker);
    registration.addEventListener('updatefound', () => watch(registration.installing));
  }
  async function registration() { return navigator.serviceWorker.getRegistration('/lab/'); }
  async function command(type) {
    if (!ready) throw Error('isolation-not-established');
    if (commandBusy) throw Error('command-already-running');
    commandBusy = true; const commandId = ++issued;
    try {
    const reg = await registration(), worker = reg?.active;
    if (!worker) throw Error('no-active-worker');
    return await new Promise((resolve, reject) => {
      const ch = new MessageChannel(), timer = setTimeout(() => { ch.port1.close(); reject(Error('command-timeout')); }, 9000);
      ch.port1.onmessage = event => {
        if (event.data.type === 'RACE_PHASE') {
          const phase = event.data.phase;
          log('boundary-phase', { phase });
          if (raceWindow && racePhase === phase) {
            raceWindow.location.href = '/lab/?mode=legacy&race=' + encodeURIComponent(phase);
            log('race-navigation-requested', { phase });
          }
          ch.port1.postMessage({ type: 'PHASE_ACK', phase }); return;
        }
        clearTimeout(timer); ch.port1.close();
        if (event.data.type === 'ERROR') reject(Error(event.data.error));
        else {
          if (event.data.result?.requester_client_id) knownClientId = event.data.result.requester_client_id;
          lastResult = event.data; log('command-result', { command: type, command_id: commandId, result: event.data.result }); resolve(event.data);
        }
      };
      worker.postMessage({ type }, [ch.port2]);
    });
    } finally { completed = commandId; commandBusy = false; }
  }
  navigator.serviceWorker.addEventListener('message', event => {
    if (!ready || event.data?.type !== 'CAP_NOTIFICATION_COMPAT_CHALLENGE' || !event.ports[0]) return;
    const mode = $('mode').value, port = event.ports[0];
    knownClientId = event.data.target_client_id || null;
    log('challenge-received', { barrier_id: event.data.barrier_id, sender: event.source?.scriptURL || null });
    if (mode === 'legacy') return;
    if (mode === 'navigate') { location.replace('/lab/?mode=legacy&navigated=1'); return; }
    if (mode === 'disappear') { window.close(); return; }
    const reply = LifecycleProtocol.response(event.data);
    if (mode === 'missing') reply.capabilities.pop();
    port.postMessage(mode === 'malformed' ? { wrong: true } : reply);
    if (mode === 'duplicate') port.postMessage(reply);
  });
  addEventListener('pageshow', event => {
    log('pageshow', { persisted: event.persisted,
      not_restored_reasons: performance.getEntriesByType('navigation')[0]?.notRestoredReasons?.toJSON?.() || null });
    if ($('mode').value === 'legacy') log('synthetic-legacy-code-executed', { action: 'resume', stateWritten: false });
    if (event.persisted) verifyIsolation().catch(refuseIsolation);
  });
  addEventListener('pagehide', event => log('pagehide', { persisted: event.persisted }));
  addEventListener('visibilitychange', () => log('visibilitychange'));
  for (const name of ['freeze', 'resume']) document.addEventListener(name, () => log(name));
  navigator.serviceWorker.addEventListener('controllerchange', () => { watch(navigator.serviceWorker.controller); log('controllerchange'); });
  async function register(bare = false, instance = crypto.randomUUID()) {
    if (!ready) throw Error('isolation-not-established');
    const url = '/lab/service-worker.js' + (bare ? '' : '?cap_worker_instance=' + instance);
    const reg = await navigator.serviceWorker.register(url, { scope: '/lab/', updateViaCache: 'none' });
    watchRegistration(reg); await log('registered', { worker_url: url }); return reg;
  }
  async function revise(skip = $('skip').checked, claim = $('claim').checked) {
    const res = await fetch('/__lab/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run: settings.run, skip, claim }) });
    if (!res.ok) throw Error('settings-rejected');
    const next = await res.json(); settings = { ...settings, ...next }; await log('revision-requested', next); return next;
  }
  const bind = (id, fn) => $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(error => log('error', { error: error.message })));
  bind('register', () => register()); bind('bare', () => register(true));
  bind('revision', () => revise());
  bind('update', async () => { const reg = await registration(); if (!reg) throw Error('no-registration'); await reg.update(); watchRegistration(reg); });
  bind('unregister', async () => { const reg = await registration(); if (reg) await reg.unregister(); await log('unregistered'); });
  bind('probe', () => command('PROBE')); bind('challenge', () => command('CHALLENGE'));
  // Open synchronously inside the user gesture, before promise chaining loses popup permission.
  $('race').addEventListener('click', () => {
    if (commandBusy) { log('error', { error: 'command-already-running' }); return; }
    raceWindow = window.open('/away', '_blank'); racePhase = $('phase').value;
    if (!raceWindow) { log('error', { error: 'popup-blocked' }); return; }
    (async () => {
      const start = performance.now();
      while (raceWindow.location.pathname !== '/away' || raceWindow.document.readyState !== 'complete') {
        if (performance.now() - start > 3000) throw Error('race-staging-timeout');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return command('CHALLENGE');
    })().catch(error => log('error', { error: error.message })).finally(() => { raceWindow = null; racePhase = null; });
  });
  bind('legacy', () => log('synthetic-legacy-code-executed', { action: 'disable-or-sign-out-fixture', stateWritten: false }));
  bind('mark', () => log('manual-observation', { note: $('note').value }));
  async function report() {
    const res = await fetch('/__lab/report');
    if (!res.ok) throw Error('report-unavailable');
    return { ...(await res.json()), exporting_page: metadata(), local_records: local, isolation: isolationDiagnostics,
      log_failures: logFailures, blocked_attempts: LifecycleSafety.report() };
  }
  bind('export', async () => {
    const blob = new Blob([JSON.stringify(await report(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'cap-lifecycle-evidence-' + settings.run + '.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  bind('copy', async () => {
    const text = JSON.stringify(await report(), null, 2);
    try { await navigator.clipboard.writeText(text); } catch (_) { $('output').textContent = text; }
  });
  function storageEntries(storage) {
    const entries = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null) throw Error('STORAGE_INVENTORY_CHANGED_STOP');
      entries.push({ key, value: storage.getItem(key) });
    }
    return entries;
  }
  async function inventory() {
    const available = typeof indexedDB.databases === 'function';
    return { local: storageEntries(localStorage), session: storageEntries(sessionStorage), caches: await caches.keys(),
      databaseInventoryAvailable: available, databases: available ? await indexedDB.databases() : [] };
  }
  function workersIn(regs) {
    return [...new Set([...regs.flatMap(reg => [reg.active, reg.waiting, reg.installing]), navigator.serviceWorker.controller].filter(Boolean))];
  }
  function registrationSignature(regs) {
    return JSON.stringify({ controller: navigator.serviceWorker.controller?.scriptURL || null,
      registrations: regs.map(r => [r.scope, r.active?.scriptURL, r.waiting?.scriptURL, r.installing?.scriptURL]).sort() });
  }
  function attest(worker) {
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(Error('WORKER_PROVENANCE_TIMEOUT_STOP')); }, 3000);
      channel.port1.onmessage = event => {
        clearTimeout(timer); channel.port1.close(); resolve({ url: worker.scriptURL, nonce, proof: event.data });
      };
      try { worker.postMessage({ type: 'LAB_ISOLATION_CHALLENGE', nonce }, [channel.port2]); }
      catch (error) { clearTimeout(timer); channel.port1.close(); reject(error); }
    });
  }
  async function verifyIsolation() {
    ready = false; $('controls').disabled = true;
    if (globalThis.LifecycleSafety?.promotionAllowed !== false || LifecycleSafety.storage !== 'lab-provenance-only/2' || !globalThis.LifecycleProtocol || !globalThis.LifecycleIsolation) throw Error('SAFETY_GUARDS_UNAVAILABLE');
    if (!isSecureContext) throw Error('dedicated-secure-origin-required');
    // Inspect names/values only; never open, unregister, or clean unfamiliar stores/workers.
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      if (reg.scope !== location.origin + '/lab/') throw Error('FOREIGN_WORKER_STOP');
    }
    const workers = workersIn(regs), signature = registrationSignature(regs);
    if (workers.some(w => new URL(w.scriptURL).origin !== location.origin || new URL(w.scriptURL).pathname !== '/lab/service-worker.js')) throw Error('FOREIGN_WORKER_STOP');
    const bootstrapResponse = await fetch('/__lab/settings', { cache: 'no-store' }), bootstrap = await bootstrapResponse.json();
    if (!bootstrapResponse.ok || bootstrap.promotionAllowed !== false || bootstrap.isolation?.run !== bootstrap.run) throw Error('NOT_DEDICATED_SERVER');
    LifecycleIsolation.validatePolicy(bootstrap.isolation, location.origin);
    diagnosticRun = bootstrap.run; // Diagnostic transport only; does not set ready or authorize state.
    if (initialRun && initialRun !== bootstrap.run) throw Error('LAB_RUN_CHANGED_STOP');
    const state = await inventory();
    // Diagnose exactly which category/key caused a refusal, without exporting stored values.
    isolationDiagnostics = { protocol: LifecycleIsolation.PROTOCOL, origin: location.origin,
      localKeys: state.local.map(e => e.key), sessionKeys: state.session.map(e => e.key),
      caches: state.caches, databases: state.databases, databaseInventoryAvailable: state.databaseInventoryAvailable,
      workerUrls: workers.map(w => w.scriptURL) };
    await log('isolation-inventory', isolationDiagnostics);
    const proofs = await Promise.all(workers.map(attest));
    const response = await fetch('/__lab/settings', { cache: 'no-store' }), next = await response.json();
    if (!response.ok || next.promotionAllowed !== false || next.isolation?.run !== next.run) throw Error('NOT_DEDICATED_SERVER');
    if (next.run !== bootstrap.run) throw Error('LAB_RUN_CHANGED_STOP');
    if (initialRun && initialRun !== next.run) throw Error('LAB_RUN_CHANGED_STOP');
    LifecycleIsolation.validateInventory(state, next.isolation, location.origin);
    for (const result of proofs) LifecycleIsolation.validateWorker(result.url, result.proof, result.nonce, next.isolation, location.origin);
    if (registrationSignature(await navigator.serviceWorker.getRegistrations()) !== signature) throw Error('WORKER_SET_CHANGED_STOP');
    // Only this exact server-issued lab marker has a retained write path. Generic storage writes remain blocked.
    LifecycleSafety.initializeMarkers(next.isolation);
    LifecycleIsolation.validateInventory(await inventory(), next.isolation, location.origin);
    settings = next; initialRun = next.run;
    ready = true; $('controls').disabled = false; $('status').textContent = 'Isolated lab ready. NOT CERTIFIED. Promotion permanently false.';
    for (const reg of regs) watchRegistration(reg);
    await log('page-ready', { run: settings.run });
    // Flush early pageshow records without duplicating their source sequence.
    for (const record of local.filter(r => r.event === 'pageshow' || r.event === 'synthetic-legacy-code-executed')) {
      await fetch('/__lab/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: settings.run, event: record }) });
    }
  }
  function refuseIsolation(error) {
    ready = false; $('controls').disabled = true; $('status').textContent = 'STOP: ' + error.message;
    log('isolation-refused', { error: error.message, inventory: isolationDiagnostics });
  }
  verifyIsolation().catch(refuseIsolation);
  // Test surface is diagnostic only; no authority-changing operation exists.
  Object.defineProperty(window, 'LifecycleLab', { value: Object.freeze({
    ready: () => ready, token: pageToken, register, revise, command, report,
    mode: value => { $('mode').value = value; }, isolation: () => isolationDiagnostics,
    lastCommand: () => ({ issued, completed, busy: commandBusy, result: lastResult }), promotionAllowed: false
  }) });
})();
