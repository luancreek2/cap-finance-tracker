/* Phase 2B isolated browser checks (S1-S14). Real Chrome, real IndexedDB, the
   shipped scheduler and publisher. No live Supabase, no push service, no
   financial IO, no sender and no service worker. The publisher is asserted to
   stay dark: the fake production RPC surface must never be called. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
if (!process.env.CAP_PLAYWRIGHT_PATH) {
  console.log('SKIP Notification scheduling browser: set CAP_PLAYWRIGHT_PATH');
  process.exit(0);
}
const { chromium } = require(process.env.CAP_PLAYWRIGHT_PATH);
const root = path.resolve(__dirname, '..');
let server, browser, passed = 0;
const base = () => 'http://127.0.0.1:' + server.address().port;

// Test-only continuity evidence. Timing fixtures explicitly enroll their single
// synthetic cycle/rules in the real IndexedDB mapping before compiling.
function installFixtureCompiler() {
  const raw = window.CapNotificationSchedule;
  window.RawSchedule = raw;
  window.CapNotificationSchedule = { ...raw, compile: async input => {
    const owner = input.owner || 'owner-a';
    const mapped = async item => {
      const source = (await raw.mutateIdentities(owner, { type: 'create_source', source: item.source || 'bill',
        local_id: String(item.id), creation_token: 'synthetic-source:' + item.id })).record;
      const cycle = (await raw.mutateIdentities(owner, { type: 'ensure_occurrence',
        source_handle: source.source_handle, cycle_token: 'synthetic-outstanding-cycle' })).record;
      return { source, cycle };
    };
    const obligations = [];
    for (const item of input.obligations || []) {
      const { source, cycle } = await mapped(item), reminders = [];
      for (const [index, spec] of item.reminders.entries()) {
        const reminder = (await raw.mutateIdentities(owner, { type: 'ensure_reminder',
          source_handle: source.source_handle, obligation_id: cycle.obligation_id, rule_token: 'synthetic-rule:' + index })).record;
        reminders.push({ ...spec, reminder_id: reminder.reminder_id });
      }
      obligations.push({ ...item, occurrences: [{ due_date: item.first_due, obligation_id: cycle.obligation_id, reminders }] });
    }
    const absolute = [];
    for (const item of input.absolute || []) {
      const { source, cycle } = await mapped(item);
      const reminder = (await raw.mutateIdentities(owner, { type: 'ensure_reminder',
        source_handle: source.source_handle, obligation_id: cycle.obligation_id, rule_token: 'synthetic-custom:' + item.reminder_id })).record;
      absolute.push({ ...item, obligation_id: cycle.obligation_id, reminder_id: reminder.reminder_id });
    }
    return raw.compile({ ...input, owner, obligations, absolute, identities: await raw.loadIdentities(owner) });
  } };
}

const HARNESS = '<!doctype html><html><head><meta charset="utf-8"><title>scheduling fixture</title></head>' +
  '<body><div id="app"></div>' +
  '<script>window.__rpcCalls=0;window.CapProductionRpc={' +
  'notificationReadinessV2:async()=>{window.__rpcCalls++;return {}}, ' +
  'notificationPublishV2:async()=>{window.__rpcCalls++;return {}}, ' +
  'notificationReadbackV2:async()=>{window.__rpcCalls++;return {}}};</script>' +
  '<script src="/js/notification-schedule.js"></script>' +
  '<script>(' + installFixtureCompiler.toString() + ')()</script>' +
  '<script src="/js/notification-publisher.js"></script></body></html>';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function startServer() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/harness') { res.setHeader('Content-Type', TYPES['.html']); return res.end(HARNESS); }
      const file = path.join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', resolve);
  });
}

const OWNER = 'owner-a';
const PREFIX = 'cap_notifications_v1:';
const INSTALL = '33333333-3333-4333-8333-333333333333';
const BINDING = '22222222-2222-4222-8222-222222222222';
const PREFS = { on: true, bills: true, billsD: 7, renew: true, renewD: 2, trial: false,
  trialD: 14, card: true, cardD: 5, overdue: true, showAmounts: false };
const HISTORY = { 'bill:1:before-7-days': { day: '2026-10-15', seen: true, delivered: true } };
const INSTALLATION = { installation_id: INSTALL, created_at: '2026-10-01T00:00:00Z',
  engine: 'cap-reminder-v1', protocol: 'CAP_PUSH_V1' };

async function openFixture() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', error => console.log('PAGEERROR ' + error.message));
  await page.goto(base() + '/harness');
  await page.waitForFunction(() => window.CapNotificationSchedule && window.CapNotificationPublisher,
    null, { timeout: 10000 });
  return { context, page };
}

async function seed(page, values) {
  await page.evaluate(async data => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('cap-notifications', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('state', 'readwrite');
        const store = tx.objectStore('state');
        for (const [key, value] of Object.entries(data)) {
          if (value === null) store.delete(key); else store.put(value, key);
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, values);
}

async function state(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('cap-notifications', 1);
      request.onupgradeneeded = () => {
        const created = request.result;
        if (!created.objectStoreNames.contains('state')) created.createObjectStore('state');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const get = key => new Promise((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const out = { keys, stores: Array.from(db.objectStoreNames) };
    for (const key of keys) out[key] = await get(key);
    db.close();
    return out;
  });
}

async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS ' + label);
}

(async () => {
  await startServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  await test('S1 migration reads Phase 5A preferences and defaults to 09:00', async () => {
    const { context, page } = await openFixture();
    await seed(page, { installation: INSTALLATION });
    await page.evaluate(([prefix, owner, prefs, history]) => {
      localStorage.setItem(prefix + encodeURIComponent(owner), JSON.stringify({ version: 1, preferences: prefs, history }));
    }, [PREFIX, OWNER, PREFS, HISTORY]);
    const result = await page.evaluate(async () => {
      const raw = JSON.parse(localStorage.getItem('cap_notifications_v1:owner-a'));
      return CapNotificationSchedule.ensurePolicy(raw.preferences);
    });
    assert.equal(result.created, true);
    assert.equal(result.policy.default_local_time, '09:00');
    assert.deepEqual(result.policy.category_stages, { bills: [7], renew: [2], trial: [14], card: [5] });
    assert.deepEqual(result.policy.default_stages, [3]);
    assert.equal(result.policy.notification_timezone, null);
    assert.equal(result.policy.acknowledged_timezone, null);
    assert.equal(result.policy.migrated_from, 'phase5a');
    const stored = await state(page);
    assert.deepEqual(stored.stores, ['state']);
    assert.deepEqual(stored.installation, INSTALLATION);
    assert.deepEqual(stored.keys.sort(), ['installation', 'scheduling.policy']);
    const kept = await page.evaluate(([prefix, owner]) =>
      JSON.parse(localStorage.getItem(prefix + encodeURIComponent(owner))),
      [PREFIX, OWNER]);
    assert.deepEqual(kept.history, HISTORY, 'attempted/delivered/read history is untouched');
    assert.deepEqual(kept.preferences, PREFS, 'the Phase 5A preference record is untouched');
    await context.close();
  });

  await test('S2 migration is idempotent and never claims remote acknowledgment', async () => {
    const { context, page } = await openFixture();
    await page.evaluate(([prefix, owner, prefs, history]) => {
      localStorage.setItem(prefix + encodeURIComponent(owner), JSON.stringify({ version: 1, preferences: prefs, history }));
    }, [PREFIX, OWNER, PREFS, HISTORY]);
    const first = await page.evaluate(() => CapNotificationSchedule.ensurePolicy({ billsD: 7, renewD: 2, trialD: 14, cardD: 5 }));
    const second = await page.evaluate(() => CapNotificationSchedule.ensurePolicy({ billsD: 3, renewD: 3, trialD: 3, cardD: 5 }));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.policy, first.policy);
    const keys = await state(page);
    assert.equal(keys.keys.filter(k => k === 'scheduling.policy').length, 1);
    assert.equal(keys.keys.includes('scheduling.ack'), false, 'migration must not fabricate a remote acknowledgment');
    assert.equal(keys.keys.includes('scheduling.plan'), false, 'migration must not fabricate a published plan');
    await context.close();
  });

  await test('S3 a user with no stored preferences still migrates to 09:00', async () => {
    const { context, page } = await openFixture();
    const policy = await page.evaluate(() => CapNotificationSchedule.migratePolicy({}));
    assert.equal(policy.default_local_time, '09:00');
    assert.deepEqual(policy.default_stages, [3]);
    assert.deepEqual(policy.category_stages, { bills: [3], renew: [3], trial: [3], card: [5] });
    await context.close();
  });

  await test('S4 the digest key is persisted once in the existing database', async () => {
    const { context, page } = await openFixture();
    const first = await page.evaluate(async () => {
      const key = await CapNotificationSchedule.ensureDigestKey();
      return Array.from(key);
    });
    const second = await page.evaluate(async () => {
      const key = await CapNotificationSchedule.ensureDigestKey();
      return Array.from(key);
    });
    assert.deepEqual(first, second);
    assert.equal(first.length, 32);
    const stored = await state(page);
    assert.deepEqual(stored.stores, ['state']);
    assert.equal(stored['scheduling.digest-key'].version, 1);
    assert.equal(typeof stored['scheduling.digest-key'].value, 'string');
    assert.deepEqual(stored.keys, ['scheduling.digest-key']);
    await context.close();
  });

  await test('S5 plan and acknowledgment survive a reload', async () => {
    const { context, page } = await openFixture();
    const saved = await page.evaluate(async () => {
      const plan = await CapNotificationSchedule.compile({ reference: '2026-10-30T00:00:00Z',
        timezone: 'Asia/Manila', policy: { default_local_time: '09:00' },
        absolute: [{ id: 'ob-1', source: 'bill', reminder_id: '00000000-0000-4000-8000-0000000000b1',
          local_date: '2026-12-01', local_time: '09:00', timezone: 'Asia/Manila',
          send_after: '2026-12-01T01:00:00Z' }] });
      const storedPlan = await CapNotificationSchedule.savePlan(plan);
      const storedAck = await CapNotificationSchedule.saveAck({ binding_id: '22222222-2222-4222-8222-222222222222',
        generation: 1, schedule_revision: 1, notification_timezone: 'Asia/Manila', occurrences: [] });
      return { revision: storedPlan.revision, ack: storedAck.schedule_revision,
        entries: storedPlan.entries.length };
    });
    await page.reload();
    await page.waitForFunction(() => window.CapNotificationSchedule);
    const after = await page.evaluate(async () => {
      const plan = await CapNotificationSchedule.loadPlan();
      const ack = await CapNotificationSchedule.loadAck();
      return { revision: plan.revision, entries: plan.entries.length, ack: ack.schedule_revision,
        timezone: ack.notification_timezone };
    });
    assert.deepEqual(after, { revision: saved.revision, entries: saved.entries,
      ack: saved.ack, timezone: 'Asia/Manila' });
    await context.close();
  });

  await test('S6 local intent without acknowledgment is PENDING_SYNC, never SCHEDULED', async () => {
    const { context, page } = await openFixture();
    const result = await page.evaluate(async () => {
      const plan = await CapNotificationSchedule.compile({ reference: '2026-10-30T00:00:00Z',
        timezone: 'Asia/Manila', policy: { default_local_time: '09:00' },
        obligations: [{ id: 'ob-2', source: 'bill', first_due: '2026-12-15',
          recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
          reminders: [{ kind: 'relative', days_before: 3, time_source: 'inherit' }] }] });
      const publisher = CapNotificationPublisher.singleton;
      const binding = { binding_id: '22222222-2222-4222-8222-222222222222', generation: 1 };
      return { local: publisher.states(plan, {}), pending: publisher.states(plan, { binding }) };
    });
    assert.equal(result.local.counts.SAVED_LOCAL, 1);
    assert.equal(result.pending.counts.PENDING_SYNC, 1);
    assert.equal(result.pending.counts.SCHEDULED, undefined);
    assert.equal(result.pending.pending, 'PENDING_SYNC');
    await context.close();
  });

  await test('S7 a device timezone change is CHANGE_PENDING and cannot rewrite the old acknowledgment', async () => {
    const { context, page } = await openFixture();
    const result = await page.evaluate(async () => {
      const build = async (zone) => CapNotificationSchedule.compile({ reference: '2026-10-30T00:00:00Z',
        timezone: zone, policy: { default_local_time: '09:00' },
        digestKey: await CapNotificationSchedule.ensureDigestKey(), owner: 'owner-a', installation: '33333333-3333-4333-8333-333333333333',
        
        obligations: [{ id: 'ob-3', source: 'bill', first_due: '2026-12-15',
          recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
          reminders: [{ kind: 'relative', days_before: 3, time_source: 'inherit' }] }] });
      const manila = await build('Asia/Manila');
      const newYork = await build('America/New_York');
      const binding = { binding_id: '22222222-2222-4222-8222-222222222222', generation: 1 };
      const ack = { binding_id: binding.binding_id, generation: 1, schedule_revision: 1,
        notification_timezone: 'Asia/Manila',
        occurrences: manila.entries.map(e => Object.assign({}, e, { delivery_state: 'queued' })) };
      const snapshot = JSON.stringify(ack);
      const publisher = CapNotificationPublisher.singleton;
      return {
        before: publisher.states(manila, { binding, ack }).counts,
        after: publisher.states(newYork, { binding, ack }).counts,
        manilaSend: manila.entries[0].send_after,
        yorkSend: newYork.entries[0].send_after,
        sameDigest: manila.entries[0].candidate_digest === newYork.entries[0].candidate_digest,
        acknowledgedUnchanged: JSON.stringify(ack) === snapshot,
        acknowledgedTimezone: ack.notification_timezone
      };
    });
    assert.equal(result.before.SCHEDULED, 1);
    assert.equal(result.after.CHANGE_PENDING, 1);
    assert.equal(result.after.SCHEDULED, undefined);
    assert.notEqual(result.manilaSend, result.yorkSend);
    assert.equal(result.sameDigest, true);
    assert.equal(result.acknowledgedUnchanged, true);
    assert.equal(result.acknowledgedTimezone, 'Asia/Manila');
    await context.close();
  });

  await test('S8 absolute reminders keep their resolved UTC instant across a device timezone change', async () => {
    const { context, page } = await openFixture();
    const result = await page.evaluate(async () => {
      const build = async (zone) => CapNotificationSchedule.compile({ reference: '2026-10-30T00:00:00Z',
        timezone: zone, policy: { default_local_time: '09:00' },
        digestKey: await CapNotificationSchedule.ensureDigestKey(), owner: 'owner-a', installation: '33333333-3333-4333-8333-333333333333',
        absolute: [{ id: 'ob-4', source: 'bill', reminder_id: '00000000-0000-4000-8000-0000000000b2',
          local_date: '2026-12-20', local_time: '19:30', timezone: 'Asia/Manila',
          send_after: '2026-12-20T11:30:00Z' }] });
      const manila = await build('Asia/Manila');
      const newYork = await build('America/New_York');
      return { a: manila.entries[0], b: newYork.entries[0] };
    });
    assert.equal(result.a.send_after, '2026-12-20T11:30:00Z');
    assert.equal(result.b.send_after, '2026-12-20T11:30:00Z');
    assert.equal(result.a.candidate_digest, result.b.candidate_digest);
    assert.equal(result.a.time_basis, 'absolute');
    await context.close();
  });

  await test('S9 the publisher stays dark and the production RPC surface is never called', async () => {
    const { context, page } = await openFixture();
    const result = await page.evaluate(async () => {
      const plan = await CapNotificationSchedule.compile({ reference: '2026-10-30T00:00:00Z',
        timezone: 'Asia/Manila', policy: { default_local_time: '09:00' },
        absolute: [{ id: 'ob-5', source: 'bill', reminder_id: '00000000-0000-4000-8000-0000000000b3',
          local_date: '2026-12-01', local_time: '09:00', timezone: 'Asia/Manila',
          send_after: '2026-12-01T01:00:00Z' }] });
      const publisher = CapNotificationPublisher.singleton;
      const attempted = await publisher.publish(plan, {
        binding: { binding_id: '22222222-2222-4222-8222-222222222222', generation: 1 },
        ack: { schedule_revision: 0 } });
      const reconciled = await publisher.reconcile(plan, {
        binding: { binding_id: '22222222-2222-4222-8222-222222222222', generation: 1 } });
      return { attempted, reconciled, status: publisher.status(), calls: window.__rpcCalls };
    });
    assert.equal(result.status.dark, true);
    assert.equal(result.status.activation.phase, 'PHASE_2B_DARK');
    assert.equal(result.attempted.reason, 'PUBLICATION_DISABLED');
    assert.equal(result.attempted.calls, 0);
    assert.equal(result.reconciled.reason, 'PUBLICATION_DISABLED');
    assert.equal(result.calls, 0, 'no production scheduling RPC may run');
    await context.close();
  });

  await test('S10 this phase adds no date/time picker or notification UI', async () => {
    const { context, page } = await openFixture();
    const ui = await page.evaluate(() => ({
      time: document.querySelectorAll('input[type=time]').length,
      date: document.querySelectorAll('input[type=date]').length,
      appChildren: document.getElementById('app').children.length,
      addCustom: /Add Custom Reminder/i.test(document.body.innerHTML),
      settingsMarkup: document.body.innerHTML.includes('Notification Settings')
    }));
    assert.deepEqual(ui, { time: 0, date: 0, appChildren: 0, addCustom: false, settingsMarkup: false });
    await context.close();
  });

  await test('S11 offline reconciliation keeps acknowledged state and invents nothing', async () => {
    const { context, page } = await openFixture();
    const result = await page.evaluate(async () => {
      const build = async () => CapNotificationSchedule.compile({ reference: '2026-10-30T00:00:00Z',
        timezone: 'Asia/Manila', policy: { default_local_time: '09:00' },
        digestKey: await CapNotificationSchedule.ensureDigestKey(), owner: 'owner-a', installation: '33333333-3333-4333-8333-333333333333',
        
        obligations: [{ id: 'ob-6', source: 'bill', first_due: '2026-12-15',
          recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
          reminders: [{ kind: 'relative', days_before: 3, time_source: 'inherit' }] }] });
      const plan = await build();
      const binding = { binding_id: '22222222-2222-4222-8222-222222222222', generation: 1 };
      const ack = { binding_id: binding.binding_id, generation: 1, schedule_revision: 1,
        notification_timezone: 'Asia/Manila',
        occurrences: plan.entries.map(e => Object.assign({}, e, { delivery_state: 'queued' })) };
      const publisher = CapNotificationPublisher.createPublisher({ activation: 'isolated-test',
        online: () => false, identity: () => ({ authenticated: true, userId: 'owner-a' }),
        now: () => Date.parse('2026-10-30T00:00:00Z'), rpc: {
          notificationReadinessV2: async () => { window.__rpcCalls++; return { ok: true }; },
          notificationPublishV2: async () => { window.__rpcCalls++; return {}; },
          notificationReadbackV2: async () => { window.__rpcCalls++; return {}; }
        } });
      const offlineEdit = await publisher.publish(plan, { binding, ack });
      const offlineCancel = await publisher.publish({ ...plan, entries: [] }, { binding, ack });
      const states = publisher.states(plan, { binding, ack });
      return { offlineEdit, offlineCancel, counts: states.counts, calls: window.__rpcCalls };
    });
    assert.equal(result.offlineEdit.state, 'PENDING_SYNC');
    assert.equal(result.offlineEdit.reason, 'OFFLINE');
    assert.equal(result.offlineCancel.reason, 'OFFLINE');
    assert.equal(result.counts.SCHEDULED, 1);
    assert.equal(result.calls, 0, 'an offline device must not call any RPC');
    await context.close();
  });

  await test('S12 concurrent identity migration is atomic, idempotent and survives reload', async () => {
    const { context, page } = await openFixture();
    await seed(page, { installation: INSTALLATION });
    await page.evaluate(([prefs, history]) => localStorage.setItem('cap_notifications_v1:owner-a',
      JSON.stringify({ version: 1, preferences: prefs, history })), [PREFS, HISTORY]);
    const first = await page.evaluate(async () => {
      const S = RawSchedule, owner = 'owner-a';
      const command = { type: 'create_source', source: 'subscription', local_id: 'spotify', creation_token: 'explicit-migration-A' };
      const [a, b] = await Promise.all([S.mutateIdentities(owner, command), S.mutateIdentities(owner, command)]);
      const source_handle = a.record.source_handle;
      const cycleCommand = { type: 'ensure_occurrence', source_handle, cycle_token: 'proven-outstanding-A' };
      const [c, d] = await Promise.all([S.mutateIdentities(owner, cycleCommand), S.mutateIdentities(owner, cycleCommand)]);
      const reminderCommand = { type: 'ensure_reminder', source_handle, obligation_id: c.record.obligation_id, rule_token: 'migrated-existing-rule' };
      const [r, s] = await Promise.all([S.mutateIdentities(owner, reminderCommand), S.mutateIdentities(owner, reminderCommand)]);
      return { source: a.record, cycle: c.record, reminder: r.record,
        sourceSame: source_handle === b.record.source_handle, cycleSame: c.record.obligation_id === d.record.obligation_id,
        reminderSame: r.record.reminder_id === s.record.reminder_id };
    });
    assert.ok(first.sourceSame && first.cycleSame && first.reminderSame);
    await page.reload();
    const second = await page.evaluate(async () => RawSchedule.loadIdentities('owner-a'));
    assert.equal(second.sources[0].source_handle, first.source.source_handle);
    assert.equal(second.occurrences[0].obligation_id, first.cycle.obligation_id);
    assert.equal(second.occurrences[0].reminders[0].reminder_id, first.reminder.reminder_id);
    const stored = await state(page);
    assert.deepEqual(stored.installation, INSTALLATION);
    assert.equal(stored.keys.includes('scheduling.ack'), false);
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('cap_notifications_v1:owner-a')));
    assert.deepEqual(prefs, { version: 1, preferences: PREFS, history: HISTORY });
    await context.close();
  });

  await test('S13 reminder/source tombstones persist; equivalent recreated records get new IDs', async () => {
    const { context, page } = await openFixture();
    const before = await page.evaluate(async () => {
      const S = RawSchedule, owner = 'owner-a';
      const source = (await S.mutateIdentities(owner, { type: 'create_source', source: 'bill', local_id: 'reused-1', creation_token: 'old-source' })).record;
      const cycle = (await S.mutateIdentities(owner, { type: 'ensure_occurrence', source_handle: source.source_handle, cycle_token: 'old-cycle' })).record;
      const reminder = (await S.mutateIdentities(owner, { type: 'ensure_reminder', source_handle: source.source_handle, obligation_id: cycle.obligation_id, rule_token: 'old-rule' })).record;
      await S.mutateIdentities(owner, { type: 'delete_reminder', source_handle: source.source_handle, obligation_id: cycle.obligation_id, reminder_id: reminder.reminder_id });
      const replacement = (await S.mutateIdentities(owner, { type: 'ensure_reminder', source_handle: source.source_handle, obligation_id: cycle.obligation_id, rule_token: 'new-rule' })).record;
      await S.mutateIdentities(owner, { type: 'close_source', source_handle: source.source_handle });
      return { source, cycle, reminder, replacement };
    });
    assert.notEqual(before.reminder.reminder_id, before.replacement.reminder_id);
    await page.reload();
    const after = await page.evaluate(async old => {
      const S = RawSchedule, owner = 'owner-a';
      let refused = false;
      try { await S.mutateIdentities(owner, { type: 'ensure_occurrence', source_handle: old.source.source_handle, cycle_token: 'old-cycle' }); }
      catch (_) { refused = true; }
      const source = (await S.mutateIdentities(owner, { type: 'create_source', source: 'bill', local_id: 'reused-1', creation_token: 'new-source' })).record;
      const cycle = (await S.mutateIdentities(owner, { type: 'ensure_occurrence', source_handle: source.source_handle, cycle_token: 'old-cycle' })).record;
      return { refused, source, cycle, mapping: await S.loadIdentities(owner) };
    }, before);
    assert.equal(after.refused, true);
    assert.notEqual(after.source.source_handle, before.source.source_handle);
    assert.notEqual(after.cycle.obligation_id, before.cycle.obligation_id);
    assert.equal(after.mapping.occurrences[0].state, 'closed');
    assert.ok(after.mapping.occurrences[0].reminders.every(r => r.state === 'deleted'));
    await context.close();
  });

  await test('S14 unmapped projections fail closed and old dark plans require remapping', async () => {
    const { context, page } = await openFixture();
    await seed(page, { 'scheduling.plan': { version: 1, entries: [{ reminder_id: 'unsafe-derived-id' }] } });
    const result = await page.evaluate(async () => {
      const plan = await RawSchedule.compile({ reference: '2026-10-30T00:00:00Z', timezone: 'UTC', owner: 'owner-a',
        obligations: [{ id: 'unproven-source', first_due: '2026-11-04' }] });
      return { blocked: plan.identity_blocked, entries: plan.entries,
        oldPlan: await RawSchedule.loadPlan(),
        reconcile: await CapNotificationPublisher.singleton.reconcile(plan, {}), calls: window.__rpcCalls };
    });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.entries, []);
    assert.equal(result.oldPlan, null);
    assert.equal(result.reconcile.reason, 'IDENTITY_CONTINUITY_REQUIRED');
    assert.equal(result.calls, 0);
    await context.close();
  });

  console.log(`\nPASS: ${passed} Phase 2B Scheduling browser checks (S1-S14)`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  });
