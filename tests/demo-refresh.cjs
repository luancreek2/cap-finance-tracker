/* Pure DEMO reconstruction and confirmation-flow checks; no live data/storage.
   node tests/demo-refresh.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const owner = 'fixture-owner', copy = x => JSON.parse(JSON.stringify(x));
const context = { crypto: webcrypto, TextEncoder, URLSearchParams, today: '2026-10-20',
  location: { search: '' }, localStorage: { getItem: () => null },
  CapSupabase: { status: () => ({ userId: owner }) } };
context.window = context; vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync.js'), 'utf8'), context);
const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
vm.runInContext(app.slice(app.indexOf('function migrationStableUuid('), app.indexOf('async function migrateCapData(')), context);
const transactions = fs.readFileSync(path.join(__dirname, '../js/transactions.js'), 'utf8');
vm.runInContext(transactions.slice(transactions.indexOf('function balanceEffects('), transactions.indexOf('function balanceConsistencyReport(')), context);
const original = {
  accts: [{ id: 1, name: 'Debit', type: 'debit', bal: 100 }, { id: 2, name: 'Credit', type: 'credit', bal: 25 }],
  tx: [{ id: 1, acct: 1, d: '2026-10-20', amt: 100, cat: 'Other', note: 'Opening balance', opening: true }, { id: 2, acct: 2, d: '2026-10-20', amt: -20, cat: 'Other', note: 'Opening balance', opening: true }],
  pend: [{ id: 3, acct: 2, d: '2026-10-20', amt: -5, cat: 'Other', note: 'Pending' }], xfer: [],
  cats: [{ n: 'Other', i: '📦' }], budgets: { Other: 50 },
  goals: [{ id: 1, name: 'Demo goal', icon: '⭐', target: 500, saved: 100, accountId: 1 }],
  debts: [{ id: 1, who: 'Demo person', amt: 10, dir: 'in', note: 'Demo', due: '' }],
  bills: [{ id: 1, name: 'Demo bill', amt: 20, due: 10, paid: '' }],
  notes: [{ id: 1, t: 'Demo note', b: 'Demo body', d: '2026-10-20' }], name: 'Demo profile', photo: '',
  theme: 'dark', cur: 'PHP', _mt: 1,
};
context.S = copy(original);
const cloudPlan = context.buildSupabaseMigrationPlan(context.migrationPrepare());
const snapshot = Object.fromEntries(cloudPlan.tables.map(([table, rows]) => [table, copy(rows)]));
snapshot.profiles = [copy(cloudPlan.profile)]; snapshot.user_preferences = [copy(cloudPlan.preferences)];
const sync = context.CapSync;
let passed = 0;
async function test(fn) { await fn(); passed++; }
(async () => {
  await test(async () => {
    const older = copy(original); older.accts[0].bal = 99; older.accts[0].interestEnabled = true;
    older.tx.push({ id: 999, acct: 1, amt: -1, d: '2026-01-01', cat: 'Other' }); older.name = 'Old profile';
    const before = JSON.stringify({ older, snapshot });
    const candidate = sync.buildDemoRefreshCandidate(older, snapshot, owner);
    assert.equal(candidate.accts[0].bal, 100); assert.equal(candidate.accts[0].interestEnabled, undefined);
    assert.equal(candidate.tx.some(t => t.id === 999), false); assert.equal(candidate.name, 'Demo profile');
    assert.equal(candidate.tx.filter(t => t.opening).length, 2); assert.equal(candidate.pend.length, 1);
    context.S = candidate;
    assert.equal(context.migrationPrepare().blockingProblems.length, 0);
    const plan = context.buildSupabaseMigrationPlan(context.migrationPrepare()), rows = await sync.recordFingerprints(plan, { snapshot });
    assert.ok(rows.every(r => r.contentFingerprint === r.cloudContentFingerprint), 'All fields must round-trip, not just amounts/counts');
    assert.ok(candidate.accts.every(a => context.balanceEffects(a.id).impliedAnchor === 0));
    assert.equal(JSON.stringify({ older, snapshot }), before, 'Preview inputs must remain unchanged');
  });
  for (const mutate of [
    s => { s.accounts[0].user_id = 'other'; }, s => { s.profiles = []; }, s => { s.user_preferences = []; },
    s => { s.transfers = [{ id: 'unsupported', user_id: owner }]; },
    s => { s.account_statements = [{ id: 'unsupported', user_id: owner }]; },
    s => { s.accounts[0].legacy_id = null; }, s => { s.accounts[0].balance = 'NaN'; },
    s => { s.transactions[0].account_id = 'missing'; }, s => { s.transactions[0].metadata = {}; },
    s => { s.transactions[0].metadata.acct = 'wrong'; }, s => { s.transactions[0].status = 'unknown'; },
    s => { s.categories.push(copy(s.categories[0])); }, s => { s.notes = Array(201).fill(copy(s.notes[0])); },
  ]) await test(async () => { const changed = copy(snapshot); mutate(changed); assert.throws(() => sync.buildDemoRefreshCandidate(original, changed, owner)); });
  await test(async () => {
    const changed = copy(snapshot); changed.accounts[0].balance = 101;
    const candidate = sync.buildDemoRefreshCandidate(original, changed, owner); context.S = candidate;
    assert.notEqual(context.balanceEffects(candidate.accts[0].id).impliedAnchor, 0, 'Preview must reject unexplained balances instead of fabricating an opening entry');
  });
  const flow = () => {
    const f = { confirms: 0, applies: 0, previews: 0 };
    f.io = { withLock: run => run(), preview: async () => { f.previews++; return { matches: true, ticket: 'same' }; },
      confirm: async () => { f.confirms++; return true; }, apply: async () => { f.applies++; return { committed: true, verified: true, records: 12 }; } };
    return f;
  };
  await test(async () => { const f = flow(); assert.equal((await sync.refreshLocalDemo(f.io)).complete, true); assert.equal(f.previews, 2); assert.equal(f.applies, 1); });
  await test(async () => { const f = flow(); f.io.confirm = async () => false; assert.equal((await sync.refreshLocalDemo(f.io)).complete, false); assert.equal(f.applies, 0); });
  await test(async () => { const f = flow(); f.io.preview = async () => ({ matches: false }); assert.equal((await sync.refreshLocalDemo(f.io)).complete, false); assert.equal(f.confirms, 0); assert.equal(f.applies, 0); });
  await test(async () => { const f = flow(); f.io.preview = async () => ({ matches: true, ticket: 'different-' + ++f.previews }); assert.equal((await sync.refreshLocalDemo(f.io)).complete, false); assert.equal(f.applies, 0); });
  await test(async () => { const f = flow(); f.io.apply = async () => { const e = Error('private error'); e.backedUp = true; throw e; }; const r = await sync.refreshLocalDemo(f.io); assert.ok(r.status.includes('BACKUP RETAINED')); assert.ok(!r.status.includes('private')); });
  await test(async () => { const f = flow(); f.io.apply = async () => ({ committed: true, verified: false }); assert.equal((await sync.refreshLocalDemo(f.io)).status, 'LOCAL WRITE OCCURRED — VERIFICATION FAILED'); });
  await test(async () => { const f = flow(), results = await Promise.all([sync.refreshLocalDemo(f.io), sync.refreshLocalDemo(f.io)]); assert.equal(results.filter(r => r.complete).length, 1); assert.equal(f.applies, 1); });
  assert.equal((await sync.refreshLocalDemo()).complete, false); passed++;
  console.log(`PASS: ${passed} local demo reconstruction/confirmation checks; zero live writes`);
})().catch(error => { console.error(error); process.exitCode = 1; });
