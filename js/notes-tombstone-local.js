/* Isolated, unwired local staging prototype. Dependencies are explicit; this
   module never opens a database, boots the app, or contacts a cloud service.
   Do not wire into real state before merge/import and mutual-exclusion gates. */
(function (root) {
  'use strict';
  const CHECKPOINT = 'manual-notes-tombstone-v1', PREFIX = 'manual-notes-tombstone-backup:';
  const LOCK = 'cap-controlled-notes-test', VERSION = 2;
  const clone = x => JSON.parse(JSON.stringify(x));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
  const other = ['controlled-notes-test-v1', 'demo-local-refresh-state-v1', 'manual-notes-pull-v1'];
  const status = text => ({ status: text, cloudWritten: false, staged: false, verified: false });
  function create(io) {
    if (!io || !io.database || !io.planner || typeof io.planner.plan !== 'function' ||
        ['getState', 'setState', 'readLocalStorage', 'writeLocalStorage', 'guard', 'withLock'].some(k => typeof io[k] !== 'function'))
      throw Error('Explicit isolated local adapters required');
    let busy = false;
    const owned = owner => io.guard(owner) === true;
    const current = (owner, json) => owned(owner) && JSON.stringify(io.getState()) === json && io.readLocalStorage() === json;
    async function build(input, mode = 'local') {
      const e = clone(input), s = e.snapshot;
      if (Object.keys(e).some(k => !['snapshot', 'localJson', 'operationId', 'requestedAt'].includes(k)) ||
          !s || s.local?.kind !== 'active' || !uuid(e.operationId) || typeof e.localJson !== 'string' ||
          !Number.isSafeInteger(e.requestedAt) || e.requestedAt < 1) throw Error('Invalid stage evidence');
      const original = JSON.parse(e.localJson), notes = original.notes, t = s.target, row = s.local.row;
      if (!Array.isArray(notes) || notes.some(n => !n || typeof n !== 'object' || n.id === null || n.id === undefined) ||
          new Set(notes.map(n => String(n.id))).size !== notes.length ||
          Object.hasOwn(original, 'noteTombstones') && (!Array.isArray(original.noteTombstones) || original.noteTombstones.length) ||
          !Number.isSafeInteger(original._mt) || original._mt < 0 || original._mt >= Number.MAX_SAFE_INTEGER)
        throw Error('Unsupported stable local state');
      const matches = notes.filter(n => String(n.id) === t?.localId), baselines = s.baseline?.records?.filter(r => r.entity === 'notes' && r.supabase_id === t?.supabase_id);
      if (matches.length !== 1 || baselines?.length !== 1 || matches[0].t !== row?.title || matches[0].b !== row?.body ||
          (matches[0].d ?? null) !== row?.note_date) throw Error('Local note mapping differs');
      const intent = { version: 1, operation_id: e.operationId, user_id: s.owner, localId: t.localId, supabase_id: t.supabase_id,
        original: clone(row), expected: { contentFingerprint: baselines[0].contentFingerprint, lifecycle: clone(baselines[0].lifecycle) } };
      const remote = mode === 'remote';
      const candidate = clone(s); if (!remote) candidate.local = { kind: 'tombstone', intent, acknowledged: null };
      const decision = await io.planner.plan(candidate);
      if (!decision.previewReady || decision.classification !== (remote ? 'CLOUD_TOMBSTONE' : 'LOCAL_DELETE_INTENT')) throw Error('Not an unchanged local candidate');
      const next = clone(original); next.notes = next.notes.filter(n => String(n.id) !== t.localId);
      const acknowledged = remote ? { contentFingerprint: baselines[0].contentFingerprint, lifecycle: clone(s.cloud.lifecycle) } : null;
      next.noteTombstones = [{ id: e.operationId, user_id: s.owner, localId: t.localId, supabase_id: t.supabase_id,
        ...(remote ? { origin: 'cloud', original: clone(row), acknowledged } : { intent, acknowledged: null }),
        staged_at: new Date(e.requestedAt).toISOString() }];
      next._mt = Math.max(original._mt + 1, e.requestedAt);
      // Bind the exact full local snapshot too, not just canonical note content.
      const ticketBytes = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ version: VERSION, mode, e, plannerTicket: decision.ticket })));
      const ticket = Array.from(new Uint8Array(ticketBytes), b => b.toString(16).padStart(2, '0')).join('');
      const cp = { version: VERSION, kind: remote ? 'manual-note-tombstone-remote' : 'manual-note-tombstone-local', owner: s.owner, operationId: e.operationId,
        backupKey: PREFIX + e.operationId, phase: 'prepared', evidence: e, nextLocalJson: JSON.stringify(next), ticket };
      if (remote) {
        const revision = s.baseline.revision ?? 0;
        if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw Error('Invalid baseline revision');
        cp.nextBaseline = { ...clone(s.baseline), revision: revision + 1, aggregateFingerprintStale: true, updated_at: new Date(e.requestedAt).toISOString(),
          records: s.baseline.records.map(r => r === baselines[0] ? { ...clone(r), lifecycle: clone(s.cloud.lifecycle),
            cloud_updated_at: s.cloud.row.updated_at ?? null, last_tombstone_apply_id: e.operationId } : clone(r)) };
      }
      return { cp, next, original, intent, ticket };
    }
    const backupFor = cp => ({ version: VERSION, kind: 'manual-note-tombstone-backup', owner: cp.owner,
      operationId: cp.operationId, expectedLocalJson: cp.evidence.localJson, baseline: cp.evidence.snapshot.baseline,
      originalCloud: cp.evidence.snapshot.cloud, originalNote: cp.evidence.snapshot.local.row, ticket: cp.ticket });
    function transaction(mode, key, work) {
      return new Promise((resolve, reject) => {
        let t, failure;
        try {
          t = io.database.transaction(['kv', 'syncmeta', 'outbox'], mode);
          const m = t.objectStore('syncmeta'), requests = [m.get('baseline'), m.get(CHECKPOINT),
            ...other.map(k => m.get(k)), t.objectStore('outbox').getAll(), t.objectStore('kv').get('state'), m.get(key)];
          const values = []; let pending = requests.length;
          requests.forEach((q, i) => { q.onsuccess = () => {
            values[i] = q.result;
            if (--pending) return;
            try { work(t, values); } catch (_) { failure = Error('Local staging preconditions changed'); t.abort(); }
          }; });
          t.oncomplete = () => resolve(values);
          t.onabort = () => reject(failure || Error('Local transaction aborted'));
          t.onerror = () => { failure = Error('Local transaction failed'); };
        } catch (_) { if (t) try { t.abort(); } catch (_) {} reject(Error('Local transaction unavailable')); }
      });
    }
    function verify(values, cp, phase, stateJson, needsBackup) {
      const [baseline, active, test, demo, pull, entries, state, backup] = values;
      const acknowledged = cp.kind === 'manual-note-tombstone-remote' && ['applied', 'complete'].includes(phase);
      if (!eq(baseline, acknowledged ? cp.nextBaseline : cp.evidence.snapshot.baseline) || test || demo || pull || entries.length || state?.json !== stateJson ||
          !current(cp.owner, stateJson) || (phase === null || phase === 'complete' ? !!active : !eq(active, { ...cp, phase })) ||
          (needsBackup ? !eq(backup, backupFor(cp)) : !!backup)) throw Error('Stage evidence changed');
    }
    async function previewMode(evidence, mode) {
      try {
        const b = await build(evidence, mode);
        if (!current(b.cp.owner, b.cp.evidence.localJson)) throw Error();
        return { ...status(mode === 'remote' ? 'PREVIEW ONLY — apply one explicit remote tombstone locally; no cloud write' :
          'PREVIEW ONLY — stage one local note deletion; no cloud write'), previewReady: true, ticket: b.ticket, requiresConfirmation: true };
      } catch (_) { return { ...status('BLOCKED — local deletion staging evidence not proven'), previewReady: false }; }
    }
    const preview = evidence => previewMode(evidence, 'local');
    const previewRemote = evidence => previewMode(evidence, 'remote');
    async function run(mode, ticket, action) {
      const remote = mode === 'remote';
      if (busy || typeof ticket !== 'string' || !/^[0-9a-f]{64}$/.test(ticket) || !action ||
          typeof action.inspect !== 'function' || typeof action.confirm !== 'function' || remote && typeof action.readCloud !== 'function')
        return status('BLOCKED — explicit fresh preview, confirmation, and required readers needed');
      busy = true; let backedUp = false, committed = false, cleaned = false;
      try {
        return await io.withLock(LOCK, async () => {
          const first = await build(await action.inspect(), mode);
          if (first.ticket !== ticket || !current(first.cp.owner, first.cp.evidence.localJson)) throw Error();
          await transaction('readonly', first.cp.backupKey, (_, values) => verify(values, first.cp, null, first.cp.evidence.localJson, false));
          if (await action.confirm() !== true) return status('CANCELLED — nothing staged');
          const b = await build(await action.inspect(), mode), cp = b.cp, expected = cp.evidence.localJson;
          if (b.ticket !== ticket || !current(cp.owner, expected)) throw Error();
          await transaction('readwrite', cp.backupKey, (t, values) => {
            verify(values, cp, null, expected, false);
            t.objectStore('syncmeta').add(backupFor(cp), cp.backupKey);
            t.objectStore('syncmeta').add(cp, CHECKPOINT);
          });
          backedUp = true;
          await transaction('readonly', cp.backupKey, (_, values) => verify(values, cp, 'prepared', expected, true));
          const fresh = await build(await action.inspect(), mode);
          if (fresh.ticket !== ticket) throw Error();
          await transaction('readwrite', cp.backupKey, (t, values) => {
            verify(values, cp, 'prepared', expected, true);
            t.objectStore('kv').put({ json: cp.nextLocalJson, mt: b.next._mt }, 'state');
            if (remote) t.objectStore('syncmeta').put(cp.nextBaseline, 'baseline');
            t.objectStore('syncmeta').put({ ...cp, phase: remote ? 'applied' : 'local-staged' }, CHECKPOINT);
          });
          committed = true;
          if (!current(cp.owner, expected)) throw Error();
          io.setState(clone(b.next)); io.writeLocalStorage(cp.nextLocalJson);
          await transaction('readonly', cp.backupKey, (_, values) => verify(values, cp, remote ? 'applied' : 'local-staged', cp.nextLocalJson, true));
          if (remote) {
            if (!eq(await action.readCloud(), cp.evidence.snapshot.cloud) || !current(cp.owner, cp.nextLocalJson)) throw Error();
            await transaction('readwrite', cp.backupKey, (t, values) => {
              verify(values, cp, 'applied', cp.nextLocalJson, true); t.objectStore('syncmeta').delete(CHECKPOINT);
            });
            cleaned = true;
            await transaction('readonly', cp.backupKey, (_, values) => verify(values, cp, 'complete', cp.nextLocalJson, true));
            return { status: 'REMOTE TOMBSTONE APPLIED LOCALLY — BACKUP RETAINED; NO CLOUD WRITE', applied: true, committed: true,
              verified: true, cloudWritten: false, checkpointRetained: false, backupRetained: true };
          }
          return { status: 'STAGED LOCALLY — DELETION INTENT AND BACKUP RETAINED; NO CLOUD WRITE', committed: true, staged: true, verified: true,
            cloudWritten: false, checkpointRetained: true, backupRetained: true };
        });
      } catch (_) {
        return { ...status(committed ? (remote ? 'LOCAL TOMBSTONE APPLIED — VERIFICATION INCOMPLETE; INSPECT TOMBSTONE RECOVERY' :
          'LOCAL STAGE COMMITTED — VERIFICATION INCOMPLETE; INSPECT TOMBSTONE RECOVERY') :
          backedUp ? 'STOPPED — BACKUP/CHECKPOINT RETAINED; LOCAL NOTE NOT REMOVED' : 'BLOCKED — LOCAL TOMBSTONE NOT STAGED'),
          committed, backupRetained: backedUp, checkpointRetained: backedUp && !cleaned };
      } finally { busy = false; }
    }
    const stage = (ticket, action) => run('local', ticket, action);
    const applyRemote = (ticket, action) => run('remote', ticket, action);
    async function readCheckpoint() {
      return new Promise((resolve, reject) => {
        try {
          const t = io.database.transaction('syncmeta', 'readonly'), q = t.objectStore('syncmeta').get(CHECKPOINT);
          q.onsuccess = () => resolve(q.result); q.onerror = () => reject(Error('Checkpoint unavailable'));
        } catch (_) { reject(Error('Checkpoint unavailable')); }
      });
    }
    async function validateBundle(cp, backup) {
      const remote = cp?.kind === 'manual-note-tombstone-remote';
      if (!cp || cp.version !== VERSION || (!remote && cp.kind !== 'manual-note-tombstone-local') || !owned(cp.owner) ||
          !(remote ? ['prepared', 'applied'] : ['prepared', 'local-staged']).includes(cp.phase)) throw Error();
      const b = await build(cp.evidence, remote ? 'remote' : 'local');
      if (!eq(cp, { ...b.cp, phase: cp.phase }) || !eq(backup, backupFor(b.cp))) throw Error();
      return b;
    }
    async function inspectRecovery(readers = {}) {
      try {
        const cp = await readCheckpoint();
        if (!cp) return { present: false, status: 'NO LOCAL TOMBSTONE RECOVERY CHECKPOINT' };
        if (!owned(cp.owner) || !uuid(cp.operationId) || cp.backupKey !== PREFIX + cp.operationId) throw Error();
        const values = await transaction('readonly', cp.backupKey, () => {}), [baseline, active, test, demo, pull, entries, state, backup] = values;
        const b = await validateBundle(cp, backup);
        const original = cp.evidence.localJson, desired = cp.nextLocalJson, memory = JSON.stringify(io.getState()), ls = io.readLocalStorage();
        const remote = cp.kind === 'manual-note-tombstone-remote';
        const report = { present: true, phase: cp.phase, backupVerified: true, baselineUnchanged: eq(baseline, cp.evidence.snapshot.baseline),
          baselineAcknowledged: remote && eq(baseline, cp.nextBaseline),
          outboxEmpty: entries.length === 0, otherRecoveryAbsent: !test && !demo && !pull,
          indexeddbOriginal: state?.json === original, indexeddbStaged: state?.json === desired,
          persistenceAgrees: state?.json === memory && memory === ls, cloudEvidence: 'NOT CHECKED — local-only inspection' };
        const nonNote = x => Object.fromEntries(Object.entries(x).filter(([k]) => !['_mt', 'notes', 'noteTombstones'].includes(k)));
        report.unrelatedStateUnchanged = eq(nonNote(JSON.parse(state.json)), nonNote(b.original));
        if (remote) {
          report.cloudEvidence = 'NOT PROVEN — exact remote tombstone reader required';
          if (typeof readers.readCloud === 'function') try {
            report.cloudEvidence = eq(await readers.readCloud(), cp.evidence.snapshot.cloud) ? 'MATCHES REVIEWED TOMBSTONE' : 'DIFFERS FROM REVIEWED TOMBSTONE';
          } catch (_) { report.cloudEvidence = 'NOT PROVEN — exact cloud read failed'; }
        }
        await transaction('readonly', cp.backupKey, (_, latest) => {
          if (!eq(latest, values) || !current(cp.owner, state.json)) throw Error('Recovery evidence changed during inspection');
        });
        const clean = owned(cp.owner) && eq(active, cp) && (remote && cp.phase === 'applied' ? report.baselineAcknowledged : report.baselineUnchanged) && report.outboxEmpty && report.otherRecoveryAbsent &&
          report.persistenceAgrees && report.unrelatedStateUnchanged;
        report.status = remote ? (clean && report.cloudEvidence === 'MATCHES REVIEWED TOMBSTONE' && cp.phase === 'applied' && report.indexeddbStaged ?
          'REMOTE TOMBSTONE DATA VERIFIED — CHECKPOINT RETAINED; REVIEW REQUIRED' :
          clean && report.cloudEvidence === 'MATCHES REVIEWED TOMBSTONE' && cp.phase === 'prepared' && report.indexeddbOriginal ?
            'REMOTE TOMBSTONE NOT APPLIED — BACKUP RETAINED; REVIEW REQUIRED' : 'BLOCKED — REMOTE TOMBSTONE RECOVERY REQUIRES REVIEW') :
          clean && cp.phase === 'local-staged' && report.indexeddbStaged ? 'LOCAL STAGE VERIFIED — CHECKPOINT RETAINED; CLOUD NOT CHECKED' :
          clean && cp.phase === 'prepared' && report.indexeddbOriginal ? 'NOT STAGED — BACKUP RETAINED; REVIEW REQUIRED' : 'BLOCKED — LOCAL TOMBSTONE RECOVERY REQUIRES REVIEW';
        return report;
      } catch (_) { return { present: true, backupVerified: false, status: 'BLOCKED — LOCAL TOMBSTONE RECOVERY NOT PROVEN' }; }
    }
    async function exportRecovery() {
      try {
        const cp = await readCheckpoint(); if (!cp || !owned(cp.owner) || cp.backupKey !== PREFIX + cp.operationId) throw Error();
        const values = await transaction('readonly', cp.backupKey, () => {}), backup = values[7];
        await validateBundle(cp, backup);
        if (!eq(values[1], cp) || !owned(cp.owner)) throw Error();
        return { exported: true, privateJson: JSON.stringify({ format: 'cap-note-tombstone-recovery-v1', checkpoint: cp, backup }) };
      } catch (_) { return { exported: false, status: 'BLOCKED — PRIVATE RECOVERY EXPORT NOT VERIFIED' }; }
    }
    async function inspectExport(privateJson) {
      try {
        const b = JSON.parse(privateJson);
        if (b.format !== 'cap-note-tombstone-recovery-v1' || Object.keys(b).some(k => !['format', 'checkpoint', 'backup'].includes(k))) throw Error();
        await validateBundle(b.checkpoint, b.backup);
        if (!owned(b.checkpoint.owner)) throw Error();
        return { valid: true, status: 'PRIVATE RECOVERY BUNDLE VERIFIED — NO IMPORT OR RESTORE PERFORMED' };
      } catch (_) { return { valid: false, status: 'BLOCKED — RECOVERY BUNDLE INVALID OR NOT OWNED; NOTHING IMPORTED' }; }
    }
    return Object.freeze({ preview, stage, previewRemote, applyRemote, inspectRecovery, exportRecovery, inspectExport });
  }
  const api = Object.freeze({ create });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CapNotesTombstoneLocal = api;
})(globalThis);
