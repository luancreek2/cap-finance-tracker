/* Disposable Chrome profiles, dedicated lab-only server, no Cap application. */
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
const { createLab } = require('./lifecycle-lab/server.cjs');
if (!process.env.CAP_PLAYWRIGHT_PATH) throw Error('Set CAP_PLAYWRIGHT_PATH to an existing playwright-core installation');
const { chromium } = require(process.env.CAP_PLAYWRIGHT_PATH);
let browser, server, origin, count = 0;
const observations = [], errors = [];
async function scenario(name, fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  context.on('request', req => { if (new URL(req.url()).origin !== origin) errors.push('external:' + req.url()); });
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(origin + '/lab/');
    await page.waitForFunction(() => window.LifecycleLab?.ready());
    const evidence = await fn(context, page);
    observations.push({ name, evidence }); count++; console.log('PASS ' + name);
  } finally { await context.close(); }
}
async function first(page, claim = true) {
  await page.evaluate(claim => LifecycleLab.revise(false, claim), claim);
  await page.evaluate(() => LifecycleLab.register());
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (claim) await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return (await page.evaluate(() => LifecycleLab.command('PROBE'))).result;
}
async function waiting(page) {
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration('/lab/'))?.waiting);
}
async function back(page, direction = 'back') {
  // BFCache restoration does not emit a fresh load event. Wait for the URL/fixture, not load.
  const method = direction === 'back' ? 'goBack' : 'goForward';
  await page[method]({ waitUntil: 'commit', timeout: 5000 }).catch(error => {
    if (!/Timeout/.test(error.message)) throw error;
  });
  await page.waitForFunction(() => !!window.LifecycleLab?.ready());
}
(async () => {
  const lab = createLab(); server = lab.server;
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true,
    ignoreDefaultArgs: ['--disable-back-forward-cache'], args: ['--no-proxy-server'] });
  console.log('Browser: ' + await browser.version());
  await scenario('A/B/C clean origin, own provenance markers and no-claim worker survive controlled reload', async (_, page) => {
    assert.equal(await page.evaluate(() => LifecycleLab.ready()), true);
    const beforeMarkers = await page.evaluate(() => ({ local: localStorage.getItem(LifecycleIsolation.KEYS.local), session: sessionStorage.getItem(LifecycleIsolation.KEYS.session) }));
    const old = await first(page, false);
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), false);
    await page.reload(); await page.waitForFunction(() => LifecycleLab?.ready());
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    const after = (await page.evaluate(() => LifecycleLab.command('PROBE'))).result;
    assert.equal(after.worker_instance, old.worker_instance);
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.getItem(LifecycleIsolation.KEYS.local), session: sessionStorage.getItem(LifecycleIsolation.KEYS.session) })), beforeMarkers);
    await page.reload(); await page.waitForFunction(() => LifecycleLab?.ready());
    return { controlledReloadAllowed: true, repeatedReloadAllowed: true, isolation: await page.evaluate(() => LifecycleLab.isolation()), promotionAllowed: false };
  });
  await scenario('uncontrolled first registration, enumeration and old fixture execution', async (_, page) => {
    const old = await first(page, false);
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), false);
    assert.ok(old.clients.some(c => c.url.endsWith('/lab/') && !c.controlled));
    await page.click('#legacy');
    const report = await page.evaluate(() => LifecycleLab.report());
    assert.ok(report.records.some(r => r.event === 'synthetic-legacy-code-executed'));
    return { instance: old.worker_instance, clients: old.clients, promotionAllowed: false };
  });
  await scenario('multiple controlled windows, replacement waits, reload/navigation and final close', async (context, page) => {
    const old = await first(page);
    const other = await context.newPage(); await other.goto(origin + '/lab/?mode=compatible');
    await other.waitForFunction(() => LifecycleLab?.ready());
    await page.evaluate(() => LifecycleLab.revise(false, true));
    await page.evaluate(() => LifecycleLab.register()); await waiting(page);
    const during = (await page.evaluate(() => LifecycleLab.command('PROBE'))).result;
    assert.equal(during.worker_instance, old.worker_instance);
    await page.reload(); await page.waitForFunction(() => LifecycleLab?.ready()); await waiting(page);
    await page.goto(origin + '/lab/?navigated=1'); await page.waitForFunction(() => LifecycleLab?.ready()); await waiting(page);
    await other.bringToFront(); await other.close(); await waiting(page);
    const regInfo = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/lab/'); return { old: r.active.scriptURL, next: r.waiting.scriptURL }; });
    await page.close();
    const next = await context.newPage(); await next.goto(origin + '/away');
    await next.waitForFunction(nextUrl => fetch('/__lab/report').then(r => r.json()).then(r =>
      r.records.some(e => e.event === 'activation-handler-complete' && e.worker_url === nextUrl)), regInfo.next);
    await next.goto(origin + '/lab/');
    await next.waitForFunction(() => LifecycleLab?.ready());
    await next.waitForFunction(async () => !(await navigator.serviceWorker.getRegistration('/lab/')).waiting);
    const after = (await next.evaluate(() => LifecycleLab.command('PROBE'))).result;
    assert.notEqual(after.worker_instance, old.worker_instance);
    return { during, regInfo, after };
  });
  await scenario('uncontrolled window executes and navigates while another controlled window blocks replacement', async (context, page) => {
    const firstWorker = await first(page, false);
    await page.evaluate(() => LifecycleLab.mode('legacy'));
    const oldToken = await page.evaluate(() => LifecycleLab.token);
    const other = await context.newPage(); await other.goto(origin + '/lab/'); await other.waitForFunction(() => LifecycleLab?.ready());
    assert.equal(await other.evaluate(() => !!navigator.serviceWorker.controller), true);
    await other.evaluate(() => LifecycleLab.revise(false, false));
    await other.evaluate(() => LifecycleLab.register()); await waiting(other);
    const during = (await other.evaluate(() => LifecycleLab.command('PROBE'))).result;
    assert.ok(during.clients.some(c => !c.controlled && c.url.endsWith('/lab/')));
    assert.equal(during.worker_instance, firstWorker.worker_instance);
    await page.click('#legacy');
    const failedChallenge = (await other.evaluate(() => LifecycleLab.command('CHALLENGE'))).result;
    assert.equal(failedChallenge.diagnosticCompatibility, false);
    await page.goto(origin + '/lab/?uncontrolled-navigation=1'); await page.waitForFunction(() => LifecycleLab?.ready());
    await waiting(other);
    return { oldToken, during, failedChallenge, after: (await page.evaluate(() => LifecycleLab.command('PROBE'))).result };
  });
  await scenario('diagnostic challenge modes and hidden/multiple windows', async (context, page) => {
    await first(page);
    const results = [];
    for (const mode of ['compatible', 'legacy', 'malformed', 'missing', 'duplicate']) {
      await page.evaluate(mode => LifecycleLab.mode(mode), mode);
      const data = await page.evaluate(() => LifecycleLab.command('CHALLENGE'));
      assert.equal(data.result.diagnosticCompatibility, mode === 'compatible', JSON.stringify(data));
      assert.equal(data.result.promotionAllowed, false); results.push({ mode, result: data.result });
    }
    await page.evaluate(() => LifecycleLab.mode('compatible'));
    const other = await context.newPage(); await other.goto(origin + '/lab/'); await other.waitForFunction(() => LifecycleLab?.ready());
    await other.bringToFront();
    const multi = await page.evaluate(() => LifecycleLab.command('CHALLENGE'));
    assert.equal(multi.result.diagnosticCompatibility, true); assert.ok(multi.first.length >= 2);
    return { results, multi, hiddenVisibilityObserved: multi.first.some(c => c.visibility === 'hidden') };
  });
  await scenario('challenge detects navigating and disappearing clients', async (context, page) => {
    await first(page);
    const nav = await context.newPage(); await nav.goto(origin + '/lab/?mode=navigate'); await nav.waitForFunction(() => LifecycleLab?.ready());
    const navigated = await page.evaluate(() => LifecycleLab.command('CHALLENGE'));
    assert.equal(navigated.result.diagnosticCompatibility, false); await nav.close();
    const childPromise = context.waitForEvent('page');
    await page.evaluate(() => window.open('/lab/?mode=disappear'));
    const child = await childPromise; await child.waitForFunction(() => LifecycleLab?.ready());
    const gone = await page.evaluate(() => LifecycleLab.command('CHALLENGE'));
    assert.equal(gone.result.diagnosticCompatibility, false);
    return { navigated: navigated.result, disappeared: gone.result };
  });
  await scenario('synthetic boundaries expose late legacy documents, never promotion', async (context, page) => {
    await first(page);
    const results = [];
    for (const phase of ['before-census', 'during-census', 'after-final-census', 'boundary', 'after-boundary']) {
      await page.selectOption('#phase', phase);
      const before = await page.evaluate(() => LifecycleLab.lastCommand().issued);
      const childPromise = context.waitForEvent('page');
      await page.click('#race'); const child = await childPromise;
      await child.waitForURL('**/lab/?mode=legacy&race=*');
      await child.waitForFunction(() => LifecycleLab?.ready());
      await page.waitForFunction(before => LifecycleLab.lastCommand().completed > before && !LifecycleLab.lastCommand().busy, before);
      const command = await page.evaluate(() => LifecycleLab.lastCommand().result);
      const report = await page.evaluate(() => LifecycleLab.report());
      const marker = report.records.find(r => r.event === 'synthetic-promotion-boundary' && r.barrier_id === command.barrier_id);
      assert.equal(marker.promotionAllowed, false);
      assert.ok(report.records.some(r => r.event === 'synthetic-legacy-code-executed' && r.url.includes('race=' + phase)));
      results.push({ phase, barrier_id: command.barrier_id, marker_sequence: marker.server_sequence,
        diagnosticCompatibility: marker.diagnosticCompatibility, result: command.result });
      await child.close();
    }
    return results;
  });
  await scenario('BFCache baseline and controlled replacement Back/Forward', async (context, page) => {
    await first(page); const token = await page.evaluate(() => LifecycleLab.token);
    await page.goto(origin + '/away'); await back(page);
    const baseline = await page.evaluate(() => LifecycleLab.token);
    assert.equal(baseline, token, 'Baseline must actually restore BFCache');
    await page.goto(origin + '/away');
    const worker = context.serviceWorkers().find(w => w.url().includes('/lab/service-worker.js'));
    const settings = await (await fetch(origin + '/__lab/settings')).json();
    await fetch(origin + '/__lab/settings', { method: 'POST', body: JSON.stringify({ run: settings.run, skip: false, claim: true }) });
    await worker.evaluate(() => self.registration.update());
    // Observe activation server-side without creating a new lab document that could alter the experiment.
    await page.waitForFunction(async expected => {
      const r = await (await fetch('/__lab/report')).json();
      return r.records.some(e => e.event === 'activation-handler-complete' && e.worker_instance === expected.instance && e.revision === expected.revision);
    }, { instance: new URL(worker.url()).searchParams.get('cap_worker_instance'), revision: settings.revision + 1 });
    await back(page);
    const after = await page.evaluate(() => ({ token: LifecycleLab.token,
      nav: performance.getEntriesByType('navigation')[0].toJSON() }));
    assert.notEqual(after.token, token);
    await page.goForward({ waitUntil: 'commit' }); assert.ok(page.url().endsWith('/away')); await back(page);
    return { baselineRestored: true, replacementReloaded: true, after };
  });
  await scenario('uncontrolled BFCache, registration and history restoration', async (context, page) => {
    await page.evaluate(() => LifecycleLab.mode('legacy'));
    const token = await page.evaluate(() => LifecycleLab.token);
    await page.goto(origin + '/away');
    const other = await context.newPage(); await other.goto(origin + '/lab/'); await other.waitForFunction(() => LifecycleLab?.ready());
    const firstWorker = await first(other, false);
    await other.evaluate(() => LifecycleLab.revise(false, false));
    const expected = await (await fetch(origin + '/__lab/settings')).json();
    await other.evaluate(async () => (await navigator.serviceWorker.getRegistration('/lab/')).update());
    await other.waitForFunction(async expected => {
      const r = await (await fetch('/__lab/report')).json();
      return r.records.some(e => e.event === 'activation-handler-complete' && e.worker_instance === expected.instance && e.revision === expected.revision);
    }, { instance: firstWorker.worker_instance, revision: expected.revision });
    await back(page);
    const report = await page.evaluate(() => LifecycleLab.report());
    return { oldToken: token, afterToken: await page.evaluate(() => LifecycleLab.token),
      replacementRevision: expected.revision,
      legacyResumed: report.records.some(r => r.event === 'synthetic-legacy-code-executed' && r.page_token === token && r.action === 'resume'),
      controlled: await page.evaluate(() => !!navigator.serviceWorker.controller),
      nav: await page.evaluate(() => performance.getEntriesByType('navigation')[0].toJSON()) };
  });
  await scenario('instance URL stable through stop/restart; replacement, bare URL and reinstall', async (context, page) => {
    const cdp = await context.newCDPSession(page), versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const v of event.versions) versions.set(v.versionId, v); });
    await cdp.send('ServiceWorker.enable'); const before = await first(page);
    const active = [...versions.values()].find(v => v.status === 'activated' && v.scriptURL === before.worker_url);
    assert.ok(active, 'CDP active version observed');
    await cdp.send('ServiceWorker.stopWorker', { versionId: active.versionId });
    const after = (await page.evaluate(() => LifecycleLab.command('PROBE'))).result;
    assert.equal(after.worker_instance, before.worker_instance); assert.notEqual(after.boot_id, before.boot_id);
    await page.evaluate(() => LifecycleLab.revise(true, true));
    await page.evaluate(() => LifecycleLab.register(true));
    await page.waitForFunction(() => !navigator.serviceWorker.controller.scriptURL.includes('?'));
    const bare = (await page.evaluate(() => LifecycleLab.command('PROBE'))).result; assert.equal(bare.worker_instance, 'bare-legacy');
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/lab/')).unregister());
    await page.evaluate(() => LifecycleLab.register());
    await page.waitForFunction(() => navigator.serviceWorker.controller.scriptURL.includes('?'));
    const reinstalled = (await page.evaluate(() => LifecycleLab.command('PROBE'))).result;
    assert.notEqual(reinstalled.worker_instance, before.worker_instance); assert.equal(reinstalled.promotionAllowed, false);
    return { before, after, bare, reinstalled };
  });
  await scenario('multiple registration callers and a bare legacy caller can replace a waiting instance', async (context, page) => {
    const before = await first(page);
    const other = await context.newPage(); await other.goto(origin + '/lab/'); await other.waitForFunction(() => LifecycleLab?.ready());
    await Promise.all([page.evaluate(() => LifecycleLab.register()), other.evaluate(() => LifecycleLab.register())]);
    await waiting(page);
    const concurrent = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/lab/'); return { active: r.active.scriptURL, waiting: r.waiting.scriptURL }; });
    assert.equal(concurrent.active, before.worker_url);
    await other.evaluate(() => LifecycleLab.register(true));
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration('/lab/')).waiting?.scriptURL.endsWith('/lab/service-worker.js'));
    const bareWaiting = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/lab/'); return { active: r.active.scriptURL, waiting: r.waiting.scriptURL }; });
    assert.equal(bareWaiting.active, before.worker_url);
    return { concurrent, bareWaiting, promotionAllowed: false };
  });
  await scenario('browser safety guards throw; only provenance markers and no authority exist', async (_, page) => {
    await first(page);
    const blocked = await page.evaluate(async () => {
      const attempts = [() => indexedDB.open('forbidden-lab-probe'), () => localStorage.setItem('probe', '1'),
        () => new Notification('forbidden'), () => Notification.requestPermission()];
      for (const fn of attempts) { let failed = false; try { fn(); } catch (_) { failed = true; } if (!failed) throw Error('guard-missing'); }
      const reg = await navigator.serviceWorker.getRegistration('/lab/');
      for (const fn of [() => reg.showNotification('forbidden'), () => reg.pushManager.subscribe({ userVisibleOnly: true })]) {
        let failed = false; try { await fn(); } catch (_) { failed = true; } if (!failed) throw Error('guard-missing');
      }
      return { denied: LifecycleSafety.report(), databases: await indexedDB.databases(), keys: localStorage.length, caches: await caches.keys() };
    });
    assert.deepEqual(blocked.databases, []); assert.equal(blocked.keys, 1); assert.deepEqual(blocked.caches, []);
    const worker = _.serviceWorkers().find(w => w.url().includes('/lab/service-worker.js'));
    const workerBlocked = await worker.evaluate(async () => {
      const failures = [];
      for (const fn of [() => self.registration.showNotification('forbidden'),
        () => self.registration.pushManager.subscribe({ userVisibleOnly: true }), () => indexedDB.open('forbidden')]) {
        try { await fn(); } catch (e) { failures.push(e.message); }
      }
      return failures;
    });
    assert.equal(workerBlocked.length, 3); assert.ok(workerBlocked.every(m => m.startsWith('LAB_FORBIDDEN:')));
    blocked.worker = workerBlocked;
    return blocked;
  });
  await scenario('foreign-worker isolation refusal happens before any registration', async (context, page) => {
    await context.addInitScript(() => {
      navigator.serviceWorker.getRegistrations = async () => [{ scope: location.origin + '/', active: { scriptURL: location.origin + '/service-worker.js' } }];
    });
    await page.reload(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('FOREIGN_WORKER_STOP'));
    assert.equal(await page.evaluate(() => LifecycleLab.ready()), false);
    assert.equal(await page.evaluate(() => document.querySelector('#controls').disabled), true);
    return { refused: true };
  });
  for (const kind of ['unknown-local', 'unknown-session', 'unknown-cache', 'production-local', 'production-cache', 'production-database', 'tampered-marker']) {
    await scenario('E/F/G contamination stops: ' + kind, async (context, page) => {
      await context.addInitScript(kind => {
        if (kind === 'unknown-local') localStorage.setItem('unrelated', '1');
        if (kind === 'unknown-session') sessionStorage.setItem('unrelated', '1');
        if (kind === 'production-local') localStorage.setItem('pera', '{}');
        if (kind === 'unknown-cache') CacheStorage.prototype.keys = async () => ['unrelated'];
        if (kind === 'production-cache') CacheStorage.prototype.keys = async () => ['cap-shell-v376'];
        if (kind === 'production-database') IDBFactory.prototype.databases = async () => [{ name: 'cap-notifications', version: 1 }];
        if (kind === 'tampered-marker') localStorage.setItem('cap-lifecycle-lab:local:v2', '{}');
      }, kind);
      await page.reload(); await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('STOP:'));
      const status = await page.locator('#status').textContent();
      assert.equal(await page.evaluate(() => LifecycleLab.ready()), false);
      assert.equal(await page.evaluate(() => document.querySelector('#controls').disabled), true);
      return { status, inventory: await page.evaluate(() => LifecycleLab.isolation()) };
    });
  }
  await scenario('D/G same-path worker with unissued proof stops', async (context, page) => {
    await first(page, false);
    await context.addInitScript(() => {
      const original = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message, ports) {
        if (message.type === 'LAB_ISOLATION_CHALLENGE') ports[0].postMessage({ type: 'LAB_ISOLATION_RESPONSE', nonce: message.nonce, proof: 'unissued' });
        else original.call(this, message, ports);
      };
    });
    await page.reload(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('WORKER_PROVENANCE_STOP'));
    assert.equal(await page.evaluate(() => LifecycleLab.ready()), false);
    return { refused: true };
  });
  await scenario('G stale server-run provenance stops instead of adopting old markers', async (context, page) => {
    await context.route('**/__lab/settings', async route => {
      const response = await route.fetch(), data = await response.json();
      data.run = '12345678-1234-4123-8123-123456789abc'; data.isolation.run = data.run;
      for (const marker of Object.values(data.isolation.markers)) {
        const value = JSON.parse(marker.value); value.run = data.run; marker.value = JSON.stringify(value);
      }
      await route.fulfill({ response, json: data });
    });
    await page.reload(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('LAB_MARKER_PROVENANCE_STOP'));
    assert.equal(await page.evaluate(() => LifecycleLab.ready()), false);
    return { refused: true };
  });
  await scenario('missing safety guards refuse setup', async (context, page) => {
    // Fail an essential guard definition before the guard script starts; no dangerous APIs are called.
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, 'LifecycleSafety', { value: null, configurable: false });
    });
    const failures = [];
    const listener = e => failures.push(e.message);
    // The expected guard script exception is checked separately from unexpected browser errors.
    page.removeAllListeners('pageerror'); page.on('pageerror', listener);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('SAFETY_GUARDS_UNAVAILABLE'));
    assert.equal(await page.evaluate(() => LifecycleLab.ready()), false);
    assert.ok(failures.some(e => e.includes('LifecycleSafety')));
    return { refused: true, expectedGuardFailure: failures };
  });
  assert.deepEqual(errors, []);
  const evidence = { browser: await browser.version(), certification: 'UNVERIFIED', promotionAllowed: false,
    observations, report: await (await fetch(origin + '/__lab/report')).json() };
  if (process.env.CAP_LIFECYCLE_REPORT) fs.writeFileSync(process.env.CAP_LIFECYCLE_REPORT, JSON.stringify(evidence, null, 2));
  console.log('PASS: ' + count + ' isolated lifecycle browser scenarios. NOT physical certification.');
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (process.env.CAP_LIFECYCLE_REPORT && server?.listening) {
    try { fs.writeFileSync(process.env.CAP_LIFECYCLE_REPORT, JSON.stringify({ certification: 'UNVERIFIED', promotionAllowed: false,
      error: error.message, observations, report: await (await fetch(origin + '/__lab/report')).json() }, null, 2)); }
    catch (exportError) { console.error('Evidence export failed: ' + exportError.message); }
  }
}).finally(async () => {
  if (browser) await browser.close(); if (server) await new Promise(r => server.close(r));
});
