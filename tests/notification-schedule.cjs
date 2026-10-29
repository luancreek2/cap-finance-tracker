/* Phase 2B: deterministic client Scheduling V2 compiler.
   Pure module only. No Supabase, no browser profile, no financial writes, no
   network and no OS notification. Every expected UTC instant is asserted
   explicitly so a machine-local timezone cannot influence the result. */
'use strict';
const assert = require('node:assert/strict');
const raw = require('../js/notification-schedule.js');
const S = { ...raw, compile: fixtureCompile };
const engine = require('../js/financial-search-engine.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name); console.error(error && error.stack || error); }
}
const KEY = new Uint8Array(32).fill(7);
const OWNER = '00000000-0000-4000-8000-000000000001';
const INSTALL = '00000000-0000-4000-8000-000000000002';
const at = value => Date.parse(value);
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const base = extra => ({
  reference: '2026-10-30T00:00:00Z', timezone: 'Asia/Manila',
  policy: { default_local_time: '09:00', default_stages: [3],
    category_stages: { bills: [3], renew: [3], trial: [3], card: [5] } },
  digestKey: KEY, owner: OWNER, installation: INSTALL, ...extra
});
const entryOn = (out, date) => out.entries.filter(e => e.eligible_local_date === date);
const rel = (days, extra) => ({ kind: 'relative', days_before: days, time_source: 'inherit', ...extra });

// Explicit synthetic continuity evidence for timing tests only. The shipped
// compiler never manufactures cycles from dates; lifecycle tests below use the
// raw API and supply real mapping records directly.
let fixtureMapping = raw.emptyMapping(OWNER);
function fixtureCommand(command) {
  const next = raw.updateMapping(fixtureMapping, OWNER, command);
  fixtureMapping = next.mapping; return next.record;
}
async function fixtureCompile(input) {
  const sourceFor = item => fixtureCommand({ type: 'create_source', source: item.source || 'bill',
    local_id: String(item.id), creation_token: 'fixture-source-' + (item.source || 'bill') + ':' + item.id });
  const cycleFor = (source, index) => fixtureCommand({ type: 'ensure_occurrence',
    source_handle: source.source_handle, cycle_token: 'fixture-cycle-' + index });
  const reminderFor = (source, cycle, token) => fixtureCommand({ type: 'ensure_reminder',
    source_handle: source.source_handle, obligation_id: cycle.obligation_id, rule_token: token }).reminder_id;
  const obligations = (input.obligations || []).map(item => {
    if (item.id == null) return item;
    const source = sourceFor(item);
    const end = raw.shiftDateKey(new Date(Date.parse(input.reference) + 8760 * 3600e3).toISOString().slice(0, 10), 16);
    const start = raw.shiftDateKey(new Date(input.reference).toISOString().slice(0, 10), -16);
    const dates = raw.projectDates(item, end, input.scheduled || raw.fallbackScheduled, start);
    const occurrences = dates.map((due_date, index) => {
      const cycle = cycleFor(source, index);
      const specs = item.reminders || (input.policy.category_stages?.[item.category || 'bills'] || input.policy.default_stages || []).map(d => rel(d));
      return { due_date, obligation_id: cycle.obligation_id, reminders: specs.map((spec, n) => ({ ...spec,
        reminder_id: reminderFor(source, cycle, 'fixture-rule-' + n) })) };
    });
    return { ...item, occurrences };
  });
  const absolute = (input.absolute || []).map(item => {
    const source = sourceFor(item), cycle = cycleFor(source, 0);
    return { ...item, obligation_id: cycle.obligation_id,
      reminder_id: reminderFor(source, cycle, 'fixture-custom-' + (item.reminder_id || 'one')) };
  });
  return raw.compile({ ...input, obligations, absolute, identities: fixtureMapping });
}

(async () => {
  /* ------------------------------------------------------------ default time */

  await test('existing users migrate to a canonical 09:00 default', () => {
    assert.equal(S.DEFAULT_LOCAL_TIME, '09:00');
    assert.equal(S.migratePolicy({}).default_local_time, '09:00');
    assert.equal(S.migratePolicy({ billsD: 7 }).default_local_time, '09:00');
    assert.equal(S.normalizePolicy({}).default_local_time, '09:00');
    assert.equal(S.normalizePolicy({ default_local_time: '7:00' }).default_local_time, '09:00');
  });

  await test('HH:mm accepts the canonical 00:00..23:59 range only', () => {
    for (const value of ['09:00', '19:30', '00:00', '12:00', '23:59']) assert.equal(S.validLocalTime(value), true, value);
    for (const value of ['9:00', '24:00', '09:60', '09:00:00', '', null, undefined, 900, '09:0', ' 09:00']) {
      assert.equal(S.validLocalTime(value), false, String(value));
    }
  });

  /* ---------------------------------------------------------------- relative */

  await test('all seven relative stages subtract calendar days from the due date', async () => {
    const out = await S.compile(base({
      obligations: [{ id: 'rel-1', source: 'bill', category: 'bills', first_due: '2026-12-15',
        recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
        reminders: [14, 7, 5, 3, 2, 1, 0].map(d => rel(d)) }]
    }));
    const expected = { 14: '2026-12-01', 7: '2026-12-08', 5: '2026-12-10', 3: '2026-12-12',
      2: '2026-12-13', 1: '2026-12-14', 0: '2026-12-15' };
    assert.equal(out.entries.length, 7);
    for (const [days, date] of Object.entries(expected)) {
      const rows = entryOn(out, date);
      assert.equal(rows.length, 1, 'stage ' + days);
      assert.equal(rows[0].days_before, Number(days));
      assert.equal(rows[0].time_basis, 'wall');
    }
    assert.equal(entryOn(out, '2026-12-15')[0].send_after, '2026-12-15T01:00:00Z');
  });

  await test('inherited stages use the current default time and overrides are per reminder', async () => {
    const out = await S.compile(base({
      obligations: [{ id: 'rel-2', source: 'bill', first_due: '2026-12-15',
        recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
        reminders: [rel(3), rel(2, { time_source: 'override', override_local_time: '19:30' })] }]
    }));
    assert.equal(entryOn(out, '2026-12-12')[0].send_after, '2026-12-12T01:00:00Z');
    assert.equal(entryOn(out, '2026-12-12')[0].local_time, '09:00');
    assert.equal(entryOn(out, '2026-12-13')[0].send_after, '2026-12-13T11:30:00Z');
    assert.equal(entryOn(out, '2026-12-13')[0].local_time, '19:30');
    assert.equal(entryOn(out, '2026-12-13')[0].time_source, 'override');
  });

  await test('changing the default time only moves inherited stages, never explicit UTC reminders', async () => {
    const obligation = { id: 'rel-3', source: 'bill', first_due: '2026-12-15',
      recurrence: { start: '2026-12-15', freq: 'once', due: 15 }, reminders: [rel(1)] };
    const absolute = { id: 'abs-3', source: 'bill', reminder_id: '00000000-0000-4000-8000-0000000000a1',
      local_date: '2026-12-14', local_time: '09:00', timezone: 'Asia/Manila', send_after: '2026-12-14T01:00:00Z' };
    const nine = await S.compile(base({ obligations: [obligation], absolute: [absolute] }));
    const night = await S.compile(base({
      policy: { ...base().policy, default_local_time: '19:30' },
      obligations: [obligation], absolute: [absolute] }));
    assert.equal(entryOn(nine, '2026-12-14').find(e => e.time_basis === 'wall').send_after, '2026-12-14T01:00:00Z');
    assert.equal(entryOn(night, '2026-12-14').find(e => e.time_basis === 'wall').send_after, '2026-12-14T11:30:00Z');
    assert.equal(entryOn(night, '2026-12-14').find(e => e.time_basis === 'absolute').send_after, '2026-12-14T01:00:00Z');
  });

  /* ---------------------------------------------------------------- calendar */

  await test('calendar shifts cross month, year and leap boundaries', () => {
    assert.equal(S.shiftDateKey('2026-03-01', -1), '2026-02-28');
    assert.equal(S.shiftDateKey('2024-03-01', -1), '2024-02-29');
    assert.equal(S.shiftDateKey('2026-01-01', -1), '2025-12-31');
    assert.equal(S.shiftDateKey('2024-12-31', 1), '2025-01-01');
    assert.equal(S.shiftDateKey('2026-01-31', 1), '2026-02-01');
  });

  await test('relative subtraction is calendar-based across a DST gap, never days*24h', async () => {
    const out = await S.compile(base({
      reference: '2024-02-20T00:00:00Z', timezone: 'America/New_York',
      policy: { default_local_time: '09:00', default_stages: [1],
        category_stages: { bills: [1], renew: [], trial: [], card: [] } },
      obligations: [{ id: 'dst-1', source: 'bill', first_due: '2024-03-10',
        recurrence: { start: '2024-03-10', freq: 'once', due: 10 }, reminders: [rel(1), rel(0)] }]
    }));
    const day = entryOn(out, '2024-03-09');
    assert.equal(day.length, 1);
    // 2024-03-09 09:00 EST. Subtracting 24h from the 2024-03-10 13:00Z due
    // instant would wrongly produce 08:00 local; calendar subtraction gives 14:00Z.
    assert.equal(day[0].send_after, '2024-03-09T14:00:00Z');
    assert.equal(entryOn(out, '2024-03-10')[0].send_after, '2024-03-10T13:00:00Z');
  });

  /* ---------------------------------------------------------------- absolute */

  const absolute = (patch) => ({
    id: 'abs-1', source: 'bill', reminder_id: '00000000-0000-4000-8000-0000000000b1',
    local_date: '2026-12-01', local_time: '07:30', timezone: 'Asia/Manila',
    send_after: '2026-11-30T23:30:00Z', ...patch
  });

  await test('absolute reminders preserve the selected UTC instant exactly', async () => {
    const out = await S.compile(base({ absolute: [absolute()] }));
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].time_basis, 'absolute');
    assert.equal(out.entries[0].send_after, '2026-11-30T23:30:00Z');
    assert.equal(out.entries[0].eligible_local_date, '2026-12-01');
    assert.equal(out.entries[0].local_time, '07:30');
    assert.equal(out.entries[0].timezone, 'Asia/Manila');
  });

  await test('a device timezone change never moves an absolute UTC reminder', async () => {
    const out = await S.compile(base({ timezone: 'America/New_York', absolute: [absolute()] }));
    assert.equal(out.entries[0].send_after, '2026-11-30T23:30:00Z');
    assert.equal(out.entries[0].timezone, 'Asia/Manila');
  });

  await test('editing an absolute reminder is a replacement of the same stable identity', async () => {
    const before = await S.compile(base({ absolute: [absolute()] }));
    const after = await S.compile(base({ absolute: [absolute({
      local_date: '2026-12-02', local_time: '08:00', send_after: '2026-12-02T00:00:00Z' })] }));
    assert.equal(after.entries[0].reminder_id, before.entries[0].reminder_id);
    assert.equal(after.entries[0].candidate_digest, before.entries[0].candidate_digest);
    assert.notEqual(after.entries[0].send_after, before.entries[0].send_after);
  });

  /* --------------------------------------------------------------------- DST */

  await test('DST gap wall times are rejected, never normalized', async () => {
    assert.deepEqual(S.resolveWall('2024-03-10', '02:30', 'America/New_York'),
      { ok: false, reason: 'NOTIFICATION_LOCAL_TIME_GAP' });
    const out = await S.compile(base({
      reference: '2024-03-01T00:00:00Z', timezone: 'America/New_York',
      policy: { default_local_time: '02:30', default_stages: [0],
        category_stages: { bills: [0], renew: [], trial: [], card: [] } },
      obligations: [{ id: 'gap-1', source: 'bill', first_due: '2024-03-10',
        recurrence: { start: '2024-03-10', freq: 'once', due: 10 }, reminders: [rel(0)] }]
    }));
    assert.equal(out.entries.length, 0);
    assert.equal(out.issues.some(i => /nonexistent local time/.test(i)), true);
  });

  await test('an ambiguous fold resolves to the later occurrence', () => {
    const ny = S.resolveWall('2024-11-03', '01:30', 'America/New_York');
    assert.equal(ny.ok, true);
    assert.equal(ny.ms, at('2024-11-03T06:30:00Z'));
    assert.equal(ny.candidates.length, 2);
    const dublin = S.resolveWall('2024-10-27', '01:30', 'Europe/Dublin');
    assert.equal(dublin.ok, true);
    assert.equal(dublin.ms, at('2024-10-27T01:30:00Z'));
    assert.equal(dublin.ms, dublin.candidates[dublin.candidates.length - 1]);
  });

  await test('normal wall times resolve in a non-hour offset zone', () => {
    const kathmandu = S.resolveWall('2026-12-15', '09:00', 'Asia/Kathmandu');
    assert.equal(kathmandu.ok, true);
    assert.equal(kathmandu.ms, at('2026-12-15T03:15:00Z'));
    const sydney = S.resolveWall('2024-10-06', '09:00', 'Australia/Sydney');
    assert.equal(sydney.ms, at('2024-10-05T22:00:00Z'));
  });

  /* ------------------------------------------------------------------ horizon */

  await test('the exact 365-day boundary is inclusive and one minute past is reported', async () => {
    const inside = await S.compile(base({
      reference: '2026-01-01T00:00:00Z',
      absolute: [absolute({ id: 'h1', local_date: '2027-01-01', local_time: '00:00',
        timezone: 'UTC', send_after: '2027-01-01T00:00:00Z' })]
    }));
    assert.equal(inside.entries.length, 1);
    assert.equal(inside.outside.length, 0);
    const beyond = await S.compile(base({
      reference: '2026-01-01T00:00:00Z',
      absolute: [absolute({ id: 'h2', local_date: '2027-01-01', local_time: '00:01',
        timezone: 'UTC', send_after: '2027-01-01T00:01:00Z' })]
    }));
    assert.equal(beyond.entries.length, 0);
    assert.equal(beyond.outside.length, 1);
    assert.equal(beyond.outside[0].reason, 'NOTIFICATION_OUTSIDE_HORIZON');
  });

  await test('a due date beyond the horizon is still compiled when its lead lands inside', async () => {
    const out = await S.compile(base({
      reference: '2026-10-30T00:00:00Z', timezone: 'UTC',
      obligations: [{ id: 'h3', source: 'bill', first_due: '2027-11-05',
        recurrence: { start: '2027-11-05', freq: 'once', due: 5 }, reminders: [rel(14)] }]
    }));
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].eligible_local_date, '2027-10-22');
    assert.equal(out.entries[0].send_after, '2027-10-22T09:00:00Z');
    assert.equal(out.outside.length, 0);
  });

  /* ------------------------------------------------------------------- expiry */

  await test('expiry is the next local midnight when that is earlier than 24 hours', async () => {
    const out = await S.compile(base({ absolute: [absolute({
      local_date: '2026-12-01', local_time: '09:00', send_after: '2026-12-01T01:00:00Z' })] }));
    assert.equal(out.entries[0].send_after, '2026-12-01T01:00:00Z');
    assert.equal(out.entries[0].expires_at, '2026-12-01T16:00:00Z');
  });

  await test('the 24-hour ceiling applies when local midnight is a full day away', async () => {
    const out = await S.compile(base({ timezone: 'UTC', absolute: [absolute({
      local_date: '2026-12-01', local_time: '00:00', timezone: 'UTC',
      send_after: '2026-12-01T00:00:00Z' })] }));
    assert.equal(out.entries[0].expires_at, '2026-12-02T00:00:00Z');
    assert.equal(at(out.entries[0].expires_at) - at(out.entries[0].send_after), 24 * 3600e3);
  });

  await test('expiry follows the 23-hour local day and caps a 25-hour day at 24 hours', () => {
    const shortDay = S.expiryFor('2024-03-10', at('2024-03-10T05:00:00Z'), 'America/New_York');
    assert.equal(iso(shortDay), '2024-03-11T04:00:00Z');
    assert.equal(shortDay - at('2024-03-10T05:00:00Z'), 23 * 3600e3);
    const longDay = S.expiryFor('2024-11-03', at('2024-11-03T04:00:00Z'), 'America/New_York');
    // Next local midnight is 25 hours away, so the approved 24-hour ceiling wins.
    assert.equal(iso(longDay), '2024-11-04T04:00:00Z');
    assert.equal(longDay - at('2024-11-03T04:00:00Z'), 24 * 3600e3);
  });

  await test('every compiled expiry is strictly after its send instant and within 24 hours', async () => {
    const out = await S.compile(base({
      obligations: [{ id: 'exp-1', source: 'bill', first_due: '2026-12-15',
        recurrence: { start: '2026-12-15', freq: 'monthly', due: 15 }, reminders: [rel(0), rel(3)] }]
    }));
    assert.ok(out.entries.length >= 2);
    for (const entry of out.entries) {
      const span = at(entry.expires_at) - at(entry.send_after);
      assert.ok(span > 0, entry.candidate_digest);
      assert.ok(span <= 24 * 3600e3, entry.candidate_digest);
    }
  });

  /* ---------------------------------------------------------------- collision */

  await test('an exact relative/custom collision keeps the custom reminder and reports it', async () => {
    const out = await S.compile(base({
      obligations: [{ id: 'col-1', source: 'bill', first_due: '2026-12-15',
        recurrence: { start: '2026-12-15', freq: 'once', due: 15 }, reminders: [rel(0)] }],
      absolute: [absolute({ id: 'col-1', local_date: '2026-12-15', local_time: '09:00',
        send_after: '2026-12-15T01:00:00Z' })]
    }));
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].time_basis, 'absolute');
    assert.equal(out.collisions.length, 1);
    assert.equal(out.collisions[0].loser_kind, 'relative');
    assert.equal(out.collisions[0].reason, 'NOTIFICATION_COLLISION_COLLAPSED');
  });

  await test('two custom reminders for one obligation at one minute collapse deterministically', async () => {
    const first = absolute({ id: 'dup-1', reminder_id: '00000000-0000-4000-8000-0000000000c1' });
    const second = absolute({ id: 'dup-1', reminder_id: '00000000-0000-4000-8000-0000000000c2' });
    const a = await S.compile(base({ absolute: [first, second] }));
    const b = await S.compile(base({ absolute: [second, first] }));
    assert.equal(a.entries.length, 1);
    assert.equal(b.entries.length, 1);
    assert.equal(a.collisions.length, 1);
    assert.equal(b.collisions.length, 1);
    assert.equal(a.entries[0].reminder_id, b.entries[0].reminder_id);
  });

  await test('different obligations may legitimately share one UTC minute', async () => {
    const out = await S.compile(base({ absolute: [
      absolute({ id: 'share-1', reminder_id: '00000000-0000-4000-8000-0000000000d1' }),
      absolute({ id: 'share-2', reminder_id: '00000000-0000-4000-8000-0000000000d2' })
    ] }));
    assert.equal(out.entries.length, 2);
    assert.equal(out.collisions.length, 0);
  });

  /* ----------------------------------------------------------------- identity */

  await test('timing edits preserve obligation and reminder identity', async () => {
    const obligation = (days) => ({ id: 'id-1', source: 'bill', first_due: '2026-12-15',
      recurrence: { start: '2026-12-15', freq: 'once', due: 15 }, reminders: [rel(days)] });
    const three = await S.compile(base({ obligations: [obligation(3)] }));
    const two = await S.compile(base({ obligations: [obligation(2)] }));
    assert.equal(three.entries[0].obligation_id, two.entries[0].obligation_id);
    assert.equal(three.entries[0].reminder_id, two.entries[0].reminder_id);
    const early = await S.compile(base({
      policy: { ...base().policy, default_local_time: '19:30' }, obligations: [obligation(3)] }));
    assert.equal(early.entries[0].reminder_id, three.entries[0].reminder_id);
    assert.equal(early.entries[0].candidate_digest, three.entries[0].candidate_digest);
    assert.notEqual(early.entries[0].send_after, three.entries[0].send_after);
  });

  await test('revisions and mutable financial display text never redefine identity', async () => {
    const obligation = (patch) => ({ id: 'id-2', source: 'bill', name: 'Meralco', amount: 1000,
      first_due: '2026-12-15', recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
      reminders: [rel(3)], ...patch });
    const a = await S.compile(base({ obligations: [obligation({})] }));
    const b = await S.compile(base({
      policy: { ...base().policy, preference_revision: 99, plan_revision: 42 },
      obligations: [obligation({ name: 'Renamed', amount: 99999 })] }));
    assert.equal(a.entries[0].obligation_id, b.entries[0].obligation_id);
    assert.equal(a.entries[0].reminder_id, b.entries[0].reminder_id);
    assert.equal(a.entries[0].candidate_digest, b.entries[0].candidate_digest);
    assert.equal(a.entries[0].obligation_digest, b.entries[0].obligation_digest);
  });

  await test('digest domains are separated and installation/owner scoped', async () => {
    const message = S.digestMessage(S.DOMAIN.candidate, OWNER, INSTALL, 'identity');
    assert.equal(message, ['cap-push-digest-v1', OWNER, INSTALL, 'identity'].join('\u0000'));
    assert.equal(S.digestMessage(S.DOMAIN.obligationDigest, OWNER, INSTALL, 'identity').split('\u0000')[0],
      'cap-push-obligation-v1');
    const one = await S.candidateDigest(KEY, OWNER, INSTALL, OWNER, INSTALL);
    const two = await S.candidateDigest(KEY, OWNER, INSTALL, OWNER, INSTALL);
    const other = await S.candidateDigest(KEY, OWNER, '00000000-0000-4000-8000-000000000003', OWNER, INSTALL);
    assert.match(one, /^[0-9a-f]{64}$/);
    assert.equal(one, two);
    assert.notEqual(one, other);
    assert.notEqual(one, await S.obligationDigest(KEY, OWNER, INSTALL, 'x'));
  });

  await test('opaque local identities are allocated once, never derived from source or timing', () => {
    const a = raw.updateMapping(null, OWNER, { type: 'create_source', source: 'bill', local_id: '42', creation_token: 'created-once' });
    const b = raw.updateMapping(a.mapping, OWNER, { type: 'create_source', source: 'bill', local_id: '42', creation_token: 'created-once' });
    assert.match(a.record.source_handle, /^[0-9a-f-]{36}$/);
    assert.equal(a.record.source_handle, b.record.source_handle);
  });

  /* ------------------------------------------------------------------ privacy */

  await test('the publication payload has exactly the eight remote-safe fields', async () => {
    const out = await S.compile(base({
      obligations: [{ id: 'p-1', source: 'bill', name: 'Private Merchant', amount: 1234.56,
        account: 'Private Savings 1234', category: 'bills', description: 'Private note',
        first_due: '2026-12-15', recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
        reminders: [rel(3)] }],
      absolute: [absolute({ id: 'p-1', local_date: '2026-12-20', local_time: '19:30',
        send_after: '2026-12-20T11:30:00Z' })]
    }));
    const payload = S.payload(out.entries);
    assert.equal(payload.length, out.entries.length);
    for (const entry of payload) assert.deepEqual(Object.keys(entry), [...S.REMOTE_FIELDS]);
    const serialized = JSON.stringify(payload);
    for (const secret of ['Private Merchant', 'Private Savings', 'Private note', '1234.56', '123456',
      'Meralco', 'amount', 'merchant', 'title', 'description', 'account', 'category', 'local_ref']) {
      assert.equal(serialized.includes(secret), false, 'payload must not leak ' + secret);
    }
  });

  await test('payload validation fails closed on malformed or oversized input', async () => {
    const out = await S.compile(base({ absolute: [absolute()] }));
    const good = S.payload(out.entries)[0];
    assert.throws(() => S.payload([{ ...good, candidate_digest: 'nope' }]), /NOTIFICATION_ENTRY_INVALID/);
    assert.throws(() => S.payload([{ ...good, time_basis: 'local' }]), /NOTIFICATION_ENTRY_INVALID/);
    assert.throws(() => S.payload([{ ...good, send_after: '2026-12-01T01:00:00+08:00' }]), /NOTIFICATION_ENTRY_INVALID/);
    assert.throws(() => S.payload(new Array(S.MAX_ENTRIES + 1).fill(good)), /NOTIFICATION_ENTRIES_INVALID/);
    assert.throws(() => S.payload('nope'), /NOTIFICATION_ENTRIES_INVALID/);
  });

  /* ------------------------------------------------------------------ policy */

  await test('migration preserves each configured lead and never enables extra stages', () => {
    const policy = S.migratePolicy({ bills: true, billsD: 7, renew: true, renewD: 2, trial: false,
      trialD: 14, card: true, cardD: 5, on: true, showAmounts: true });
    assert.deepEqual(policy.default_stages, [3]);
    assert.deepEqual(policy.category_stages, { bills: [7], renew: [2], trial: [14], card: [5] });
    assert.equal(policy.default_local_time, '09:00');
    assert.equal(policy.migrated_from, 'phase5a');
  });

  await test('unsupported stages and invalid overrides are rejected, not coerced', async () => {
    await assert.rejects(S.compile(base({
      obligations: [{ id: 'bad-1', source: 'bill', first_due: '2026-12-15',
        recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
        reminders: [{ kind: 'relative', days_before: 4, time_source: 'inherit' }] }]
    })), /NOTIFICATION_STAGE_INVALID/);
    await assert.rejects(S.compile(base({
      obligations: [{ id: 'bad-2', source: 'bill', first_due: '2026-12-15',
        recurrence: { start: '2026-12-15', freq: 'once', due: 15 },
        reminders: [rel(3, { time_source: 'override', override_local_time: '25:00' })] }]
    })), /NOTIFICATION_LOCAL_TIME_INVALID/);
  });

  await test('invalid timezones and references fail closed', async () => {
    assert.equal(S.validTimezone('Asia/Manila'), true);
    assert.equal(S.validTimezone('UTC'), true);
    for (const zone of ['posix/UTC', 'right/UTC', 'Nope/Zone', '', null, 8]) assert.equal(S.validTimezone(zone), false, String(zone));
    await assert.rejects(S.compile(base({ timezone: 'Nope/Zone' })), /NOTIFICATION_TIMEZONE_INVALID/);
    await assert.rejects(S.compile(base({ reference: 'not-a-date' })), /NOTIFICATION_REFERENCE_INVALID/);
  });

  await test('obligations without a stable identity are skipped, never guessed', async () => {
    const out = await S.compile(base({ obligations: [{ source: 'bill', first_due: '2026-12-15',
      recurrence: { start: '2026-12-15', freq: 'once', due: 15 }, reminders: [rel(3)] }] }));
    assert.equal(out.entries.length, 0);
    assert.equal(out.identity_blocked, true);
    assert.equal(out.issues.includes('IDENTITY_CONTINUITY_REQUIRED'), true);
  });

  /* ------------------------------------------------- recurrence parity (one formula) */

  await test('the local recurrence fallback matches the shipped search engine exactly', () => {
    const cases = [
      { freq: 'monthly', start: '2026-01-31', due: 31 },
      { freq: 'monthly', start: '2026-01-15', due: 15 },
      { freq: 'quarterly', start: '2026-02-28', due: 28 },
      { freq: 'yearly', start: '2024-02-29', due: 29 },
      { freq: 'weekly', start: '2026-10-05', due: 5 },
      { freq: 'biweekly', start: '2026-10-05', due: 5 },
      { freq: 'once', start: '2026-11-01', due: 1 },
      { freq: 'monthly', due: 20 }
    ];
    let compared = 0;
    for (const recurrence of cases) {
      for (let offset = 0; offset < 800; offset += 7) {
        const key = S.shiftDateKey('2026-01-01', offset);
        assert.equal(S.fallbackScheduled(recurrence, key), engine.scheduled(recurrence, key),
          JSON.stringify(recurrence) + ' @ ' + key);
        compared++;
      }
    }
    assert.ok(compared > 500);
  });

  await test('injecting the engine produces the same compile as the local fallback', async () => {
    const obligation = { id: 'parity-1', source: 'bill', first_due: '2026-11-15',
      recurrence: { start: '2026-01-15', freq: 'monthly', due: 15 }, reminders: [rel(3), rel(0)] };
    const a = await S.compile(base({ obligations: [obligation] }));
    const b = await S.compile(base({ obligations: [obligation], scheduled: engine.scheduled }));
    assert.deepEqual(a.entries.map(e => [e.reminder_id, e.send_after]),
      b.entries.map(e => [e.reminder_id, e.send_after]));
  });

  await test('a long-running series is not truncated by the walk bound', async () => {
    const out = await S.compile(base({
      reference: '2026-10-30T00:00:00Z',
      obligations: [{ id: 'long-1', source: 'bill', first_due: '2016-01-15',
        recurrence: { start: '2016-01-15', freq: 'monthly', due: 15 }, reminders: [rel(0)] }]
    }));
    assert.ok(out.entries.length >= 12, 'a decade-old series still projects the full horizon');
    assert.ok(out.entries.every(e => at(e.send_after) > at('2026-10-30T00:00:00Z')));
  });

  /* -------------------------------------------------------------- containment */

  // This block intentionally bypasses the timing-fixture adapter. All IDs come
  // from explicit lifecycle operations, no source/date/stage derivation.
  let lifecycle = raw.emptyMapping(OWNER);
  const change = command => { const next = raw.updateMapping(lifecycle, OWNER, command); lifecycle = next.mapping; return next.record; };
  const source = change({ type: 'create_source', source: 'subscription', local_id: 'spotify', creation_token: 'source-created-A' });
  const november = change({ type: 'ensure_occurrence', source_handle: source.source_handle, cycle_token: 'cycle-A' });
  const rule = change({ type: 'ensure_reminder', source_handle: source.source_handle, obligation_id: november.obligation_id, rule_token: 'rule-created-A' });
  const custom = change({ type: 'ensure_reminder', source_handle: source.source_handle, obligation_id: november.obligation_id, rule_token: 'custom-created-A' });
  const compileCycle = (due_date = '2026-11-04', days_before = 3, time = '09:00') => raw.compile(base({
    reference: '2026-10-01T00:00:00Z', identities: lifecycle, obligations: [{ id: 'spotify', source: 'subscription',
      occurrences: [{ obligation_id: november.obligation_id, due_date,
        reminders: [{ ...rel(days_before), reminder_id: rule.reminder_id }] }] }],
    policy: { ...base().policy, default_local_time: time }
  }));

  await test('same November occurrence retains obligation/reminder/digests through date, lead, time and zone edits', async () => {
    const before = (await compileCycle()).entries[0];
    for (const args of [['2026-11-05', 3, '09:00'], ['2026-11-04', 7, '09:00'],
      ['2026-11-04', 3, '19:30'], ['2026-11-05', 7, '19:30']]) {
      const after = (await compileCycle(...args)).entries[0];
      assert.equal(before.obligation_id, after.obligation_id);
      assert.equal(before.reminder_id, after.reminder_id);
      assert.equal(before.candidate_digest, after.candidate_digest);
      assert.notEqual(before.send_after, after.send_after);
    }
    const edited = await raw.compile(base({ reference: '2026-10-01T00:00:00Z', timezone: 'America/New_York', identities: lifecycle,
      policy: { default_local_time: '19:30', preference_revision: 9, plan_revision: 20 },
      obligations: [{ occurrences: [{ obligation_id: november.obligation_id, due_date: '2026-11-05',
        reminders: [{ ...rel(7, { time_source: 'override', override_local_time: '20:00' }), reminder_id: rule.reminder_id }] }] }] }));
    const next = edited.entries[0];
    assert.equal(before.obligation_id, next.obligation_id);
    assert.equal(before.reminder_id, next.reminder_id);
    assert.equal(before.candidate_digest, next.candidate_digest);
    assert.equal(before.obligation_digest, next.obligation_digest);
    assert.notEqual(before.send_after, next.send_after);
  });

  await test('December is a distinct cycle with a different obligation and candidate digest', async () => {
    const december = change({ type: 'ensure_occurrence', source_handle: source.source_handle, cycle_token: 'cycle-B' });
    const nextRule = change({ type: 'ensure_reminder', source_handle: source.source_handle, obligation_id: december.obligation_id, rule_token: 'rule-created-A' });
    assert.notEqual(december.obligation_id, november.obligation_id);
    assert.notEqual(await raw.candidateDigest(KEY, OWNER, INSTALL, december.obligation_id, nextRule.reminder_id),
      await raw.candidateDigest(KEY, OWNER, INSTALL, november.obligation_id, rule.reminder_id));
  });

  await test('candidate HMAC is scoped to both durable IDs with the approved domain/key', async () => {
    const { createHmac } = require('node:crypto');
    const expected = createHmac('sha256', KEY).update(['cap-push-digest-v1', OWNER, INSTALL,
      november.obligation_id, rule.reminder_id].join('\u0000')).digest('hex');
    assert.equal(await raw.candidateDigest(KEY, OWNER, INSTALL, november.obligation_id, rule.reminder_id), expected);
    assert.notEqual(await raw.candidateDigest(KEY, OWNER, INSTALL, november.obligation_id, rule.reminder_id),
      await raw.candidateDigest(KEY, OWNER, INSTALL, INSTALL, rule.reminder_id));
  });

  await test('custom date/time edit preserves the pair and candidate digest', async () => {
    const build = (local_date, local_time, send_after) => raw.compile(base({ identities: lifecycle,
      absolute: [{ obligation_id: november.obligation_id, reminder_id: custom.reminder_id,
        local_date, local_time, timezone: 'Asia/Manila', send_after }] }));
    const a = (await build('2026-11-02', '19:30', '2026-11-02T11:30:00Z')).entries[0];
    const b = (await build('2026-11-03', '20:00', '2026-11-03T12:00:00Z')).entries[0];
    assert.equal(a.reminder_id, b.reminder_id);
    assert.equal(a.candidate_digest, b.candidate_digest);
    assert.notEqual(a.send_after, b.send_after);
  });

  await test('reminder deletion is durable; an equivalent creation receives a fresh ID', async () => {
    change({ type: 'delete_reminder', source_handle: source.source_handle, obligation_id: november.obligation_id, reminder_id: custom.reminder_id });
    assert.throws(() => change({ type: 'ensure_reminder', source_handle: source.source_handle, obligation_id: november.obligation_id, rule_token: 'custom-created-A' }), /IDENTITY_REMINDER_DELETED/);
    const replacement = change({ type: 'ensure_reminder', source_handle: source.source_handle, obligation_id: november.obligation_id, rule_token: 'custom-created-B' });
    assert.notEqual(replacement.reminder_id, custom.reminder_id);
    const denied = await raw.compile(base({ identities: lifecycle, absolute: [{ obligation_id: november.obligation_id,
      reminder_id: custom.reminder_id, local_date: '2026-11-03', local_time: '20:00', timezone: 'Asia/Manila' }] }));
    assert.equal(denied.identity_blocked, true);
    assert.equal(denied.entries.length, 0);
  });

  await test('ambiguous continuity blocks the complete snapshot, not a partial publication', async () => {
    assert.throws(() => change({ type: 'create_source', source: 'subscription', local_id: 'spotify', creation_token: 'unproven-new-incarnation' }), /IDENTITY_CONTINUITY_REQUIRED/);
    const good = (await compileCycle()).entries[0];
    const blocked = await raw.compile(base({ identities: lifecycle, absolute: [{ ...good, local_date: good.eligible_local_date }],
      obligations: [{ id: 'unmapped-recurring-source', first_due: '2026-11-04' }] }));
    assert.equal(blocked.identity_blocked, true);
    assert.equal(blocked.entries.length, 0);
    const wrongAssociation = await raw.compile(base({ identities: lifecycle, obligations: [{
      id: 'different-financial-source', source: 'subscription', occurrences: [{
        obligation_id: november.obligation_id, due_date: '2026-11-04',
        reminders: [{ ...rel(3), reminder_id: rule.reminder_id }] }] }] }));
    assert.equal(wrongAssociation.identity_blocked, true);
    assert.throws(() => raw.updateMapping(lifecycle, 'wrong-owner', { type: 'close_source', source_handle: source.source_handle }), /IDENTITY_OWNER_MISMATCH/);
  });

  await test('migration/reload with identical explicit evidence returns identical IDs', () => {
    const restored = JSON.parse(JSON.stringify(lifecycle));
    const a = raw.updateMapping(restored, OWNER, { type: 'ensure_occurrence', source_handle: source.source_handle, cycle_token: 'cycle-A' });
    const b = raw.updateMapping(a.mapping, OWNER, { type: 'ensure_reminder', source_handle: source.source_handle, obligation_id: november.obligation_id, rule_token: 'rule-created-A' });
    assert.equal(a.record.obligation_id, november.obligation_id);
    assert.equal(b.record.reminder_id, rule.reminder_id);
  });

  await test('completion and source-ID reuse never revive closed occurrence identities', async () => {
    change({ type: 'close_occurrence', source_handle: source.source_handle, obligation_id: november.obligation_id });
    assert.throws(() => change({ type: 'ensure_occurrence', source_handle: source.source_handle, cycle_token: 'cycle-A' }), /IDENTITY_OCCURRENCE_CLOSED/);
    assert.equal((await compileCycle()).identity_blocked, true);
    change({ type: 'close_source', source_handle: source.source_handle });
    assert.throws(() => change({ type: 'create_source', source: 'subscription', local_id: 'spotify', creation_token: 'source-created-A' }), /IDENTITY_CLOSED_OR_AMBIGUOUS/);
    const recreated = change({ type: 'create_source', source: 'subscription', local_id: 'spotify', creation_token: 'source-created-B' });
    const fresh = change({ type: 'ensure_occurrence', source_handle: recreated.source_handle, cycle_token: 'cycle-A' });
    assert.notEqual(recreated.source_handle, source.source_handle);
    assert.notEqual(fresh.obligation_id, november.obligation_id);
    assert.throws(() => change({ type: 'ensure_occurrence', source_handle: source.source_handle, cycle_token: 'cycle-C' }), /IDENTITY_SOURCE_CLOSED/);
  });

  await test('the compiler is pure: no network, UI, storage writes or financial mutation', () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(__dirname + '/../js/notification-schedule.js', 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|CapSupabase|service_role|showNotification|pushManager|CapProductionRpc/);
    assert.doesNotMatch(source, /localStorage|\bS\.[A-Za-z]+\s*=|cSum\s*\(|saveTx\s*\(|accountTransferCommit/);
    assert.doesNotMatch(source, /document\.(?:querySelector|getElementById)|render\s*\(/);
  });

  console.log(`\nPASS: ${passed} deterministic Scheduling V2 compiler checks${failed ? `, ${failed} FAILED` : ''}`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
