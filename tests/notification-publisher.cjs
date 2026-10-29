/* Phase 2B: client publisher for the sealed Scheduling V2 contract.
   Isolated tests with an injected fake RPC adapter only. No Supabase, no browser
   profile, no sender, no push service, no financial IO. The shipped publisher
   must stay dark: every production-shaped path is asserted to refuse. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../js/notification-schedule.js');
const P = require('../js/notification-publisher.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name); console.error(error && error.stack || error); }
}
const ROOT = path.resolve(__dirname, '..');
const REF = Date.parse('2026-10-30T00:00:00Z');
const OWNER = '00000000-0000-4000-8000-000000000001';
const INSTALL = '00000000-0000-4000-8000-000000000002';
const BINDING = { binding_id: '00000000-0000-4000-8000-0000000000e1', generation: 2 };
const KEY = new Uint8Array(32).fill(9);
const code = value => Object.assign(Error(value), { code: value });

const makePlan = () => {
  let identities = S.emptyMapping(OWNER);
  const mutate = command => { const result = S.updateMapping(identities, OWNER, command); identities = result.mapping; return result.record; };
  const source = mutate({ type: 'create_source', source: 'bill', local_id: 'ob-1', creation_token: 'synthetic-creation' });
  const cycle = mutate({ type: 'ensure_occurrence', source_handle: source.source_handle, cycle_token: 'synthetic-cycle' });
  const reminders = ['first', 'second'].map(rule_token => mutate({ type: 'ensure_reminder',
    source_handle: source.source_handle, obligation_id: cycle.obligation_id, rule_token }));
  return S.compile({
  reference: REF, timezone: 'Asia/Manila', digestKey: KEY, owner: OWNER, installation: INSTALL,
  policy: { default_local_time: '09:00' },
  absolute: [
    { id: 'ob-1', source: 'bill', obligation_id: cycle.obligation_id, reminder_id: reminders[0].reminder_id,
      local_date: '2026-12-01', local_time: '09:00', timezone: 'Asia/Manila',
      send_after: '2026-12-01T01:00:00Z' },
    { id: 'ob-1', source: 'bill', obligation_id: cycle.obligation_id, reminder_id: reminders[1].reminder_id,
      local_date: '2026-12-02', local_time: '09:00', timezone: 'Asia/Manila',
      send_after: '2026-12-02T01:00:00Z' }
  ], identities
}); };
const remoteRow = (entry, delivery_state = 'queued') => ({
  candidate_digest: entry.candidate_digest, obligation_digest: entry.obligation_digest,
  time_basis: entry.time_basis, eligible_local_date: entry.eligible_local_date,
  local_time: entry.local_time, timezone: entry.timezone,
  send_after: entry.send_after, expires_at: entry.expires_at, delivery_state
});
const scheduleAck = (plan, revision, delivery = 'queued') => ({
  binding_id: BINDING.binding_id, generation: BINDING.generation, scheduling_contract: 2,
  state: 'pending', schedule_revision: revision, preference_revision: plan.preference_revision,
  notification_timezone: plan.timezone, occurrences: plan.entries.map(e => remoteRow(e, delivery)),
  dispatch_ready: false
});

function adapter(overrides = {}) {
  const calls = { readiness: 0, publish: 0, readback: 0 };
  const seen = { publish: [], readback: [] };
  return {
    calls, seen,
    notificationReadinessV2: async () => {
      calls.readiness++;
      return overrides.readiness ? overrides.readiness() : { ok: true, raw: {} };
    },
    notificationPublishV2: async request => {
      calls.publish++; seen.publish.push(request);
      return overrides.publish ? overrides.publish(request) : scheduleAck(overrides.plan, 6);
    },
    notificationReadbackV2: async request => {
      calls.readback++; seen.readback.push(request);
      return overrides.readback ? overrides.readback(request) : scheduleAck(overrides.plan, 5);
    }
  };
}

function publisher(plan, rpc, extra) {
  return P.createPublisher({
    activation: 'isolated-test', rpc, plan,
    identity: () => ({ authenticated: true, userId: OWNER }),
    online: () => true, now: () => REF,
    ...extra
  });
}

(async () => {
  const plan = await makePlan();
  const context = { binding: BINDING, ack: { schedule_revision: 5, binding_id: BINDING.binding_id, generation: BINDING.generation } };

  /* -------------------------------------------------------------- dark by default */

  await test('the shipped publisher is dark and performs no startup RPC', async () => {
    const counter = { calls: 0 };
    const sandbox = { CapNotificationSchedule: S, CapProductionRpc: {
      notificationReadinessV2: async () => { counter.calls++; return {}; },
      notificationPublishV2: async () => { counter.calls++; return {}; },
      notificationReadbackV2: async () => { counter.calls++; return {}; }
    } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/notification-publisher.js'), 'utf8'), sandbox);
    const shipped = sandbox.CapNotificationPublisher.singleton;
    assert.equal(shipped.status().dark, true);
    assert.equal(shipped.activation.phase, 'PHASE_2B_DARK');
    assert.equal(shipped.enabled(), false);
    const refused = await shipped.publish(JSON.parse(JSON.stringify(plan)), context);
    assert.equal(refused.ok, false);
    assert.equal(refused.state, 'SAVED_LOCAL');
    assert.equal(refused.reason, 'PUBLICATION_DISABLED');
    assert.equal(refused.calls, 0);
    assert.equal((await shipped.reconcile(plan, context)).reason, 'PUBLICATION_DISABLED');
    assert.equal((await shipped.readiness()).calls, 0);
    assert.equal(counter.calls, 0, 'no production RPC may run at load or while dark');
  });

  await test('an instance without an explicit isolated activation stays dark', async () => {
    const rpc = adapter({ plan });
    const dark = P.createPublisher({ rpc, identity: () => ({ authenticated: true, userId: OWNER }) });
    assert.equal(dark.enabled(), false);
    const result = await dark.publish(plan, context);
    assert.equal(result.reason, 'PUBLICATION_DISABLED');
    assert.deepEqual(rpc.calls, { readiness: 0, publish: 0, readback: 0 });
  });

  await test('an activated publisher without a reviewed adapter fails closed', async () => {
    const lonely = P.createPublisher({ activation: 'isolated-test', identity: () => ({ authenticated: true, userId: OWNER }) });
    const result = await lonely.publish(plan, context);
    assert.equal(result.state, 'ACTION_REQUIRED');
    assert.equal(result.reason, 'PUBLICATION_ADAPTER_UNAVAILABLE');
    assert.equal(result.calls, 0);
  });

  /* ------------------------------------------------------------------ success */

  await test('a mock acknowledgment schedules exactly and persistently', async () => {
    const rpc = adapter({ plan });
    const p = publisher(plan, rpc);
    const result = await p.publish(plan, context);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'SCHEDULED');
    assert.equal(result.ack.schedule_revision, 6);
    assert.equal(rpc.calls.readiness, 1);
    assert.equal(rpc.calls.publish, 1);
    assert.equal(rpc.calls.readback, 0);
    const derived = p.states(plan, { binding: BINDING, ack: result.ack });
    assert.equal(derived.counts.SCHEDULED, 2);
    assert.equal(derived.pending, null);
  });

  await test('SCHEDULED is impossible without an authoritative acknowledgment', async () => {
    const rpc = adapter({ plan });
    const p = publisher(plan, rpc);
    const saved = p.states(plan, {});
    assert.equal(saved.counts.SAVED_LOCAL, 2);
    const pending = p.states(plan, { binding: BINDING });
    assert.equal(pending.counts.PENDING_SYNC, 2);
    assert.equal(pending.counts.SCHEDULED, undefined);
    const wrongBinding = p.states(plan, { binding: BINDING,
      ack: { ...scheduleAck(plan, 6), binding_id: '00000000-0000-4000-8000-0000000000e9' } });
    assert.equal(wrongBinding.counts.PENDING_SYNC, 2);
    const wrongGeneration = p.states(plan, { binding: BINDING,
      ack: { ...scheduleAck(plan, 6), generation: 3 } });
    assert.equal(wrongGeneration.counts.PENDING_SYNC, 2);
  });

  await test('a remote difference is CHANGE_PENDING, never SCHEDULED', async () => {
    const rpc = adapter({ plan });
    const p = publisher(plan, rpc);
    const ack = scheduleAck(plan, 6);
    ack.occurrences[0] = { ...ack.occurrences[0], send_after: '2026-12-01T02:00:00Z' };
    const derived = p.states(plan, { binding: BINDING, ack });
    assert.equal(derived.counts.CHANGE_PENDING, 1);
    assert.equal(derived.counts.SCHEDULED, 1);
    assert.equal(derived.pending, 'CHANGE_PENDING');
  });

  await test('delivery outcomes derive SENT, DELIVERY_UNCERTAIN and EXPIRED truthfully', async () => {
    const rpc = adapter({ plan });
    const p = publisher(plan, rpc);
    const sent = scheduleAck(plan, 6, 'accepted');
    // Authoritative delivery outranks a passed instant.
    assert.equal(p.states(plan, { binding: BINDING, ack: sent }).counts.SENT, 2);
    const uncertain = scheduleAck(plan, 6, 'dispatch_started');
    assert.equal(p.states(plan, { binding: BINDING, ack: uncertain }).counts.DELIVERY_UNCERTAIN, 2);
    const past = P.createPublisher({ activation: 'isolated-test', rpc, identity: () => ({ authenticated: true, userId: OWNER }),
      now: () => Date.parse('2027-01-01T00:00:00Z') });
    assert.equal(past.states(plan, { binding: BINDING, ack: scheduleAck(plan, 6) }).counts.EXPIRED, 2);
  });

  /* -------------------------------------------------------------- rejections */

  await test('a stale revision is reported as CHANGE_PENDING without blind republishing', async () => {
    const rpc = adapter({ plan, publish: async () => { throw code('NOTIFICATION_STALE_REVISION'); } });
    const result = await publisher(plan, rpc).publish(plan, context);
    assert.equal(result.ok, false);
    assert.equal(result.state, 'CHANGE_PENDING');
    assert.equal(result.reason, 'REVISION_STALE');
    assert.equal(rpc.calls.publish, 1);
    assert.equal(rpc.calls.readback, 0);
  });

  await test('a generation mismatch requires action and never retries', async () => {
    const rpc = adapter({ plan, publish: async () => { throw code('NOTIFICATION_STALE_BINDING'); } });
    const result = await publisher(plan, rpc).publish(plan, context);
    assert.equal(result.state, 'ACTION_REQUIRED');
    assert.equal(result.reason, 'GENERATION_MISMATCH');
    assert.equal(rpc.calls.publish, 1);
    assert.equal(rpc.calls.readback, 0);
  });

  await test('an incompatible contract fails before any publication', async () => {
    const rpc = adapter({ plan, readiness: () => ({ ok: false, raw: null }) });
    const result = await publisher(plan, rpc).publish(plan, context);
    assert.equal(result.state, 'ACTION_REQUIRED');
    assert.equal(result.reason, 'CONTRACT_INCOMPATIBLE');
    assert.equal(rpc.calls.publish, 0);
    const rejected = adapter({ plan, publish: async () => { throw code('NOTIFICATION_PROTOCOL_UNSUPPORTED'); } });
    assert.equal((await publisher(plan, rejected).publish(plan, context)).reason, 'CONTRACT_INCOMPATIBLE');
  });

  await test('capacity and busy rejections are explicit and bounded', async () => {
    const full = adapter({ plan, publish: async () => { throw code('NOTIFICATION_LEDGER_FULL'); } });
    assert.equal((await publisher(plan, full).publish(plan, context)).reason, 'CAPACITY_REJECTED');
    assert.equal(full.calls.publish, 1);
    const busy = adapter({ plan, publish: async () => { throw code('NOTIFICATION_PUBLICATION_BUSY'); } });
    const result = await publisher(plan, busy).publish(plan, context);
    assert.equal(result.state, 'ACTION_REQUIRED');
    assert.equal(result.reason, 'PUBLICATION_BUSY');
    assert.equal(busy.calls.publish, 1);
    const oversized = { ...plan, entries: new Array(S.MAX_ENTRIES + 1).fill(plan.entries[0]) };
    const rpc = adapter({ plan });
    assert.equal((await publisher(oversized, rpc).publish(oversized, context)).reason, 'CAPACITY_REJECTED');
    assert.equal(rpc.calls.publish, 0);
  });

  await test('an unverified session or offline device stores intent, never a claim', async () => {
    const rpc = adapter({ plan });
    const anonymous = P.createPublisher({ activation: 'isolated-test', rpc,
      identity: () => ({ authenticated: false, userId: null }), now: () => REF });
    const a = await anonymous.publish(plan, context);
    assert.equal(a.state, 'PENDING_SYNC');
    assert.equal(a.reason, 'SESSION_UNVERIFIED');
    const offline = publisher(plan, rpc, { online: () => false });
    const b = await offline.publish(plan, context);
    assert.equal(b.state, 'PENDING_SYNC');
    assert.equal(b.reason, 'OFFLINE');
    assert.equal(rpc.calls.publish, 0);
    const noBinding = await publisher(plan, rpc).publish(plan, {});
    assert.equal(noBinding.state, 'SAVED_LOCAL');
    assert.equal(noBinding.reason, 'NO_ACTIVE_BINDING');
  });

  await test('offline cancellation stays CANCELLATION_PENDING and never claims success', async () => {
    const rpc = adapter({ plan });
    const p = publisher(plan, rpc);
    const ack = scheduleAck(plan, 6);
    const local = { ...plan, entries: [plan.entries[0]] };
    const derived = p.states(local, { binding: BINDING, ack });
    assert.equal(derived.counts.CANCELLATION_PENDING, 1);
    assert.equal(derived.counts.SCHEDULED, 1);
    assert.equal(derived.pending, 'CANCELLATION_PENDING');
    const offline = publisher(plan, rpc, { online: () => false });
    const result = await offline.publish(local, { binding: BINDING, ack });
    assert.equal(result.state, 'PENDING_SYNC');
    assert.equal(rpc.calls.publish, 0);
  });

  await test('out-of-horizon occurrences are surfaced, never silently dropped', async () => {
    const rpc = adapter({ plan });
    const p = publisher(plan, rpc);
    const beyond = { ...plan, outside: [{ obligation_id: plan.entries[0].obligation_id,
      reminder_id: 'r-x', send_after: '2028-01-01T00:00:00Z', reason: 'NOTIFICATION_OUTSIDE_HORIZON' }] };
    const derived = p.states(beyond, { binding: BINDING, ack: scheduleAck(beyond, 6) });
    assert.equal(derived.counts.OUTSIDE_RANGE, 1);
  });

  /* ------------------------------------------------------- uncertain outcomes */

  await test('an uncertain timeout is never guessed: readback proves success', async () => {
    const rpc = adapter({ plan, publish: async () => { throw new Error('socket timeout'); },
      readback: async () => scheduleAck(plan, 6) });
    const result = await publisher(plan, rpc).publish(plan, context);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'SCHEDULED');
    assert.equal(result.recovered, true);
    assert.equal(rpc.calls.publish, 1);
    assert.equal(rpc.calls.readback, 1);
  });

  await test('readback proving the previous revision allows exactly one safe retry', async () => {
    let attempts = 0;
    const rpc = adapter({ plan, publish: async request => {
        attempts++;
        if (attempts === 1) throw new Error('gateway timeout');
        return scheduleAck(plan, 6);
      }, readback: async () => scheduleAck(plan, 5) });
    const result = await publisher(plan, rpc).publish(plan, context);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'SCHEDULED');
    assert.equal(result.attempts, 2);
    assert.equal(rpc.calls.publish, 2);
    assert.equal(rpc.calls.readback, 1);
  });

  await test('a readback conflict stops instead of republishing', async () => {
    const rpc = adapter({ plan, publish: async () => { throw new Error('timeout'); },
      readback: async () => scheduleAck(plan, 9) });
    const result = await publisher(plan, rpc).publish(plan, context);
    assert.equal(result.ok, false);
    assert.equal(result.state, 'CHANGE_PENDING');
    assert.equal(result.reason, 'READBACK_CONFLICT');
    assert.equal(rpc.calls.publish, 1);
    assert.equal(rpc.calls.readback, 1);
  });

  await test('an unreadable outcome is DELIVERY_UNCERTAIN with no retry loop', async () => {
    const rpc = adapter({ plan, publish: async () => { throw new Error('timeout'); },
      readback: async () => { throw new Error('offline'); } });
    const result = await publisher(plan, rpc).publish(plan, context);
    assert.equal(result.state, 'DELIVERY_UNCERTAIN');
    assert.equal(result.reason, 'READBACK_UNAVAILABLE');
    assert.equal(rpc.calls.publish, 1);
    assert.equal(rpc.calls.readback, 1);
  });

  await test('a permanent timeout settles after two attempts and two readbacks', async () => {
    const rpc = adapter({ plan, publish: async () => { throw new Error('timeout'); },
      readback: async () => scheduleAck(plan, 5) });
    const result = await publisher(plan, rpc).publish(plan, context);
    assert.equal(result.ok, false);
    assert.equal(result.state, 'PENDING_SYNC');
    assert.equal(result.reason, 'RETRY_EXHAUSTED');
    assert.equal(rpc.calls.readiness, 1);
    assert.equal(rpc.calls.publish, 2);
    assert.equal(rpc.calls.readback, 2);
  });

  await test('reconciliation is read-only and preserves the last acknowledged state', async () => {
    const rpc = adapter({ plan, readback: async () => scheduleAck(plan, 6) });
    const p = publisher(plan, rpc);
    const result = await p.reconcile(plan, { binding: BINDING });
    assert.equal(result.ok, true);
    assert.equal(result.calls, 1);
    assert.equal(result.counts.SCHEDULED, 2);
    assert.equal(rpc.calls.publish, 0);
    const failing = adapter({ plan, readback: async () => { throw new Error('down'); } });
    const failed = await publisher(plan, failing).reconcile(plan, { binding: BINDING, ack: scheduleAck(plan, 6) });
    assert.equal(failed.ok, false);
    assert.equal(failed.counts.SCHEDULED, 2);
    assert.equal(failing.calls.publish, 0);
  });

  /* ------------------------------------------------------ privacy / containment */

  await test('terminal receipts survive timing edits without a new candidate identity', async () => {
    const edited = { ...plan, entries: plan.entries.map(entry => ({ ...entry,
      send_after: '2026-12-03T11:30:00Z', expires_at: '2026-12-03T16:00:00Z',
      local_time: '19:30', eligible_local_date: '2026-12-03', days_before: 7 })) };
    for (const [receipt, state] of [['accepted', 'SENT'], ['unknown', 'DELIVERY_UNCERTAIN'],
      ['retired', 'EXPIRED'], ['suppressed', 'EXPIRED']]) {
      const ack = scheduleAck(plan, 6, receipt);
      const derived = publisher(plan, adapter({ plan })).states(edited, { binding: BINDING, ack });
      assert.equal(derived.counts[state], 2, receipt + ' remains protected after timing edit');
      assert.equal(derived.counts.SCHEDULED, undefined);
      assert.equal(derived.counts.CHANGE_PENDING, undefined);
      assert.deepEqual(P.publicationPayload(edited).map(e => e.candidate_digest),
        P.publicationPayload(plan).map(e => e.candidate_digest));
    }
  });

  await test('ambiguous or pre-correction identities cannot publish or reconcile', async () => {
    const rpc = adapter({ plan }), p = publisher(plan, rpc);
    for (const unsafe of [{ ...plan, identity_blocked: true }, { ...plan, identity_version: undefined }]) {
      assert.equal((await p.publish(unsafe, context)).reason, 'IDENTITY_CONTINUITY_REQUIRED');
      assert.equal((await p.reconcile(unsafe, context)).reason, 'IDENTITY_CONTINUITY_REQUIRED');
      assert.equal(p.states(unsafe, context).counts.ACTION_REQUIRED, 1);
    }
    assert.deepEqual(rpc.calls, { readiness: 0, publish: 0, readback: 0 });
  });

  await test('the RPC request is exactly the reviewed parameter set, with no financial fields', async () => {
    const rpc = adapter({ plan });
    await publisher(plan, rpc).publish(plan, context);
    const request = rpc.seen.publish[0];
    assert.deepEqual(Object.keys(request).sort(), ['bindingId', 'entries', 'expectedRevision',
      'generation', 'preferenceRevision', 'timezone'].sort());
    assert.equal(request.bindingId, BINDING.binding_id);
    assert.equal(request.generation, 2);
    assert.equal(request.expectedRevision, 5);
    assert.equal(request.timezone, 'Asia/Manila');
    for (const entry of request.entries) assert.deepEqual(Object.keys(entry), [...S.REMOTE_FIELDS]);
    const serialized = JSON.stringify(request);
    for (const forbidden of ['merchant', 'amount', 'title', 'description', 'account', 'category',
      'local_ref', 'obligation_id', 'reminder_id', 'owner', 'installation']) {
      assert.equal(serialized.includes(forbidden), false, 'request must not contain ' + forbidden);
    }
  });

  await test('the publisher never touches private tables, service role, sender or push APIs', () => {
    const publisherSource = fs.readFileSync(path.join(ROOT, 'js/notification-publisher.js'), 'utf8');
    const rpcSource = fs.readFileSync(path.join(ROOT, 'js/production-rpc.js'), 'utf8');
    for (const source of [publisherSource, rpcSource]) {
      assert.doesNotMatch(source, /\/rest\/v1\/(?!rpc\/)|\.from\s*\(|cap_notifications_private/);
      assert.doesNotMatch(source, /\bservice_role\b|SERVICE_ROLE_KEY|SUPABASE_SERVICE/);
      assert.doesNotMatch(source, /cap-notification-sender|functions\/v1|functions\.invoke/);
      assert.doesNotMatch(source, /showNotification|pushManager\.subscribe|new PushSubscription|registration\.subscribe/);
      assert.doesNotMatch(source, /VAPID_PRIVATE|privateJwk|\bd\s*:\s*['"][A-Za-z0-9_-]{20,}/);
    }
    // The adapter surface is exactly readiness/publish/readback.
    const rpc = adapter({ plan });
    const p = publisher(plan, rpc);
    assert.equal(typeof p.readiness, 'function');
    assert.equal(typeof p.publish, 'function');
    assert.equal(typeof p.reconcile, 'function');
    assert.deepEqual(Object.keys(P.STATES).sort(), ['ACTION_REQUIRED', 'CANCELLATION_PENDING',
      'CHANGE_PENDING', 'DELIVERY_UNCERTAIN', 'EXPIRED', 'OUTSIDE_RANGE', 'PENDING_SYNC',
      'SAVED_LOCAL', 'SCHEDULED', 'SENT'].sort());
    assert.equal(P.PHASE, 'PHASE_2B_DARK');
  });

  await test('the shipped shell loads the publisher but wires no startup publication', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /js\/notification-schedule\.js/);
    assert.match(html, /js\/notification-publisher\.js/);
    const source = fs.readFileSync(path.join(ROOT, 'js/notification-publisher.js'), 'utf8');
    assert.doesNotMatch(source, /addEventListener\(\s*['"]load|DOMContentLoaded|setInterval|requestIdleCallback/);
    assert.doesNotMatch(source, /CapNotificationPublisher\.publish\(|singleton\.publish\(/);
  });

  console.log(`\nPASS: ${passed} isolated Scheduling V2 publisher checks${failed ? `, ${failed} FAILED` : ''}`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
