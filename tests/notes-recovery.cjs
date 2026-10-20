/* Pure recovery-classification checks for an interrupted controlled notes
   test. No storage, network, DOM, or note content. node tests/notes-recovery.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const context = {
  crypto: webcrypto, TextEncoder, URLSearchParams,
  location: { search: '' },
  localStorage: { getItem: () => null },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync.js'), 'utf8'), context);
const report = context.CapSync.notesRecoveryReport;
assert.equal(typeof report, 'function');

const good = Object.freeze({
  checkpointPresent: true, checkpointOwned: true, baselineOwned: true, outboxCount: 0,
  cloudRead: 'verified', cloudOriginal: true, cloudTemporary: false,
  originalValid: true, localOriginal: true, localNotesJson: true, localNotesCanonical: true,
  localSnapshotCompared: true, financialCompared: true, financialUnchanged: true,
  baselineCompared: true, baselineOriginal: true,
  unrelatedBaselineCompared: true, unrelatedBaselineUnchanged: true,
  localStateCurrent: true, syncOff: true,
});
const full = 'CONVERGED — NOTE/BASELINE/LOCAL/OUTBOX RESTORED; CHECKPOINT REMAINS';
const limited = 'CONVERGED — NOTE/BASELINE/LOCAL/OUTBOX RESTORED; PREFLIGHT BASELINE NOT STORED; CHECKPOINT REMAINS';
let passed = 0;
function check(changes, expected) {
  const input = { ...good, ...changes };
  const before = JSON.stringify(input);
  const result = report(input);
  assert.equal(result.status, expected);
  assert.equal(result.safeToCleanCheckpoint, expected === full);
  assert.equal(result.limitedEvidence, expected === limited);
  assert.equal(JSON.stringify(input), before, 'Classification must not mutate its evidence');
  assert.ok(!/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(result.status), 'No identifiers in status');
  passed++;
}
check({}, full);
check({ unrelatedBaselineCompared: false, unrelatedBaselineUnchanged: false }, limited);
check({ unrelatedBaselineCompared: false, unrelatedBaselineUnchanged: false, localStateCurrent: false }, 'CLOUD RESTORED — PERSISTED LOCAL STATE DIFFERS');
check({ unrelatedBaselineCompared: false, unrelatedBaselineUnchanged: false, syncOff: false }, 'CLOUD RESTORED — CLOUD SYNC MODE NOT OFF');
check({ checkpointPresent: false }, 'BLOCKED — NO RECOVERY CHECKPOINT');
check({ checkpointOwned: false }, 'BLOCKED — CHECKPOINT OWNERSHIP UNPROVEN');
check({ baselineOwned: false }, 'BLOCKED — BASELINE OWNERSHIP UNPROVEN');
check({ outboxCount: -1 }, 'BLOCKED — OUTBOX NOT READ');
check({ outboxCount: 1 }, 'PENDING OPERATION REMAINS — DO NOT RETRY');
check({ cloudRead: 'blocked' }, 'BLOCKED — CLOUD STATE NOT PROVEN');
check({ cloudRead: 'not read' }, 'BLOCKED — CLOUD STATE NOT PROVEN');
check({ cloudRead: 'absent' }, 'CLOUD NOTE ABSENT — RESTORE NOT PROVEN');
check({ cloudTemporary: true, cloudOriginal: false }, 'CLOUD STILL TEMPORARY — RESTORE NOT APPLIED');
check({ cloudOriginal: false }, 'CLOUD CONTENT UNEXPECTED — REVIEW REQUIRED');
check({ originalValid: false }, 'BLOCKED — CHECKPOINT NOTE SNAPSHOT INVALID');
check({ localSnapshotCompared: false }, 'BLOCKED — LOCAL SNAPSHOT NOT COMPARED');
check({ financialCompared: false }, 'BLOCKED — FINANCIAL SNAPSHOT NOT COMPARED');
check({ baselineCompared: false }, 'BLOCKED — BASELINE NOTE RECORD NOT COMPARED');
check({ localOriginal: false }, 'CLOUD RESTORED — LOCAL NOTE DIFFERS');
check({ localNotesJson: false }, 'CLOUD RESTORED — LOCAL SNAPSHOT FORMAT DIFFERS');
check({ localNotesJson: false, localNotesCanonical: false }, 'CLOUD RESTORED — LOCAL NOTE SNAPSHOT DIFFERS');
check({ financialUnchanged: false }, 'CLOUD RESTORED — FINANCIAL SNAPSHOT DIFFERS');
check({ baselineOriginal: false }, 'CLOUD RESTORED — BASELINE RECORD DIFFERS');
check({ unrelatedBaselineUnchanged: false }, 'CLOUD RESTORED — UNRELATED BASELINE DIFFERS');
check({ localStateCurrent: false }, 'CLOUD RESTORED — PERSISTED LOCAL STATE DIFFERS');
check({ syncOff: false }, 'CLOUD RESTORED — CLOUD SYNC MODE NOT OFF');
check({ outboxCount: 1, cloudRead: 'blocked' }, 'PENDING OPERATION REMAINS — DO NOT RETRY');
check({ checkpointOwned: false, outboxCount: 1 }, 'BLOCKED — CHECKPOINT OWNERSHIP UNPROVEN');
check({ checkpointPresent: false, outboxCount: 1 }, 'BLOCKED — NO RECOVERY CHECKPOINT');
console.log(`PASS: ${passed} notes recovery classification checks; no storage, network, or content`);
