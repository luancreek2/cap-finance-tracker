/* Unwired notes lifecycle planner. No DOM, storage, transport, timers, or boot
   hooks. All readiness/coverage evidence must come from a future verified
   adapter. A preview ticket is never authorization to execute a deletion. */
(function (root) {
  'use strict';
  const VERSION = 'notes-tombstone-plan-v1';
  const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  const text = x => typeof x === 'string' && x.trim().length > 0;
  const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const keys = (x, required, optional = []) => object(x) && required.every(k => Object.hasOwn(x, k)) &&
    Object.keys(x).every(k => required.includes(k) || optional.includes(k));
  function canonical(x) {
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (Array.isArray(x)) return x.map(canonical);
    if (!object(x) || Object.prototype.toString.call(x) !== '[object Object]') throw Error('Invalid evidence');
    return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  }
  const json = x => JSON.stringify(canonical(x));
  const equal = (a, b) => json(a) === json(b);
  async function hash(value) {
    const bytes = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(json(value)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  function iso(x) {
    return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) &&
      Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
  }
  function lifecycle(x) {
    return keys(x, ['version', 'revision', 'deleted_at', 'operation_id']) && x.version === 1 &&
      Number.isSafeInteger(x.revision) && x.revision >= 1 &&
      (x.deleted_at === null || iso(x.deleted_at)) &&
      (x.deleted_at === null ? x.operation_id === null || text(x.operation_id) : text(x.operation_id));
  }
  function note(row, target, owner) {
    return keys(row, ['id', 'user_id', 'legacy_id', 'title', 'body', 'note_date'], ['created_at', 'updated_at']) &&
      row.id === target.supabase_id && row.user_id === owner && row.legacy_id === target.localId &&
      typeof row.title === 'string' && typeof row.body === 'string' &&
      (row.note_date === null || typeof row.note_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.note_date) &&
        Number.isFinite(Date.parse(row.note_date)) && new Date(row.note_date).toISOString().slice(0, 10) === row.note_date);
  }
  const content = row => ({ body: row.body, note_date: row.note_date, title: row.title });
  const result = (classification, status, proposedAction = 'BLOCKED', fields = []) => ({
    version: VERSION, executable: false, authorized: false, previewReady: false,
    classification, status, proposedAction, fields, canRestore: false, canPurge: false,
  });
  const blocked = status => result('BLOCKED', status);
  const conflict = () => result('CONFLICT', 'CONFLICT — deletion and edit/lifecycle evidence differ; preserve both versions', 'REVIEW_CONFLICT', ['content', 'lifecycle']);
  async function preview(snapshot, classification, action, status) {
    return { ...result(classification, status, action, ['lifecycle']), previewReady: true,
      requiresConfirmation: true, ticket: await hash({ version: VERSION, snapshot }) };
  }
  async function plan(snapshot) {
    try {
      // Detach before the first await. Callers changing their object cannot
      // produce a decision against one snapshot with a ticket for another.
      const s = JSON.parse(json(snapshot));
      if (!keys(s, ['version', 'owner', 'syncOff', 'persisted', 'coverage', 'capabilities', 'entries', 'checkpoints', 'baseline', 'target', 'local', 'cloud']) ||
          s.version !== 1 || !text(s.owner) || s.syncOff !== true || s.persisted !== true)
        return blocked('BLOCKED — version, identity, persistence, or sync OFF not proven');
      if (!keys(s.capabilities, ['version', 'read', 'cas', 'bypassProtected']) || s.capabilities.version !== 'notes-lifecycle-v1' ||
          s.capabilities.read !== true || s.capabilities.cas !== true || s.capabilities.bypassProtected !== true)
        return blocked('BLOCKED — lifecycle reader/writer capability not proven');
      if (!keys(s.coverage, ['complete', 'unrelatedUnchanged']) || s.coverage.complete !== true || s.coverage.unrelatedUnchanged !== true)
        return blocked('BLOCKED — complete coverage and unchanged unrelated records required');
      if (!Array.isArray(s.entries) || s.entries.length ||
          !keys(s.checkpoints, ['test', 'demo', 'pull', 'tombstone']) || Object.values(s.checkpoints).some(v => v !== null))
        return blocked('BLOCKED — pending outbox or recovery evidence; preserve it');
      const t = s.target, b = s.baseline;
      if (!keys(t, ['entity', 'localId', 'supabase_id']) || t.entity !== 'notes' || !text(t.localId) || !uuid(t.supabase_id) ||
          !object(b) || b.version !== 2 || b.user_id !== s.owner || !Array.isArray(b.records) || !b.records.length ||
          b.records.some(r => !object(r) || r.user_id !== s.owner || !text(r.entity) || !text(r.localId) || !text(r.supabase_id) || !hex(r.contentFingerprint)) ||
          new Set(b.records.map(r => r.entity + ':' + r.supabase_id)).size !== b.records.length ||
          new Set(b.records.map(r => r.entity + ':' + r.localId)).size !== b.records.length)
        return blocked('BLOCKED — owned baseline or exact note mapping not proven');
      const matches = b.records.filter(r => r.entity === 'notes' && (r.supabase_id === t.supabase_id || r.localId === t.localId));
      if (matches.length !== 1 || matches[0].supabase_id !== t.supabase_id || matches[0].localId !== t.localId || !lifecycle(matches[0].lifecycle))
        return blocked('BLOCKED — one lifecycle-aware baseline mapping required');
      const base = matches[0];
      if (!keys(s.cloud, ['kind', 'row', 'lifecycle']) || s.cloud.kind !== 'row' || !note(s.cloud.row, t, s.owner) || !lifecycle(s.cloud.lifecycle))
        return blocked('BLOCKED — explicit owned cloud lifecycle not proven; absence is not deletion');
      const remote = s.cloud.lifecycle, cloudHash = await hash(content(s.cloud.row));
      if (remote.revision < base.lifecycle.revision || remote.revision === base.lifecycle.revision &&
          (!equal(remote, base.lifecycle) || cloudHash !== base.contentFingerprint))
        return blocked('BLOCKED — cloud lifecycle regressed or changed without a revision');
      const l = s.local;
      if (!object(l)) return blocked('BLOCKED — local evidence missing');
      if (l.kind === 'missing') return blocked('BLOCKED — local absence is not explicit deletion intent');
      if (l.kind === 'remote-tombstone') {
        if (!keys(l, ['kind', 'original', 'acknowledged']) || !note(l.original, t, s.owner) ||
            !keys(l.acknowledged, ['contentFingerprint', 'lifecycle']) ||
            base.lifecycle.deleted_at === null || remote.deleted_at === null ||
            !equal(l.acknowledged.lifecycle, base.lifecycle) || !equal(remote, base.lifecycle) ||
            l.acknowledged.contentFingerprint !== base.contentFingerprint || cloudHash !== base.contentFingerprint ||
            await hash(content(l.original)) !== base.contentFingerprint)
          return blocked('BLOCKED — remote tombstone acknowledgement differs; do not restore or purge');
        return result('DELETION_ACKNOWLEDGED', 'NO DELETION ACTION — matching remote tombstone retained; no purge', 'NONE');
      }
      if (l.kind === 'active') {
        if (!keys(l, ['kind', 'row']) || !note(l.row, t, s.owner)) return blocked('BLOCKED — exact active local note not proven');
        if (base.lifecycle.deleted_at !== null) return blocked('BLOCKED — active note against deleted baseline; restoration is not supported');
        const localHash = await hash(content(l.row));
        if (remote.deleted_at === null) return result('NOT_DELETION_WORK', 'NO DELETION ACTION — active note edits use the existing note review', 'NONE');
        if (localHash !== base.contentFingerprint || cloudHash !== base.contentFingerprint) return conflict();
        return await preview(s, 'CLOUD_TOMBSTONE', 'PREVIEW_LOCAL_TOMBSTONE', 'PREVIEW ONLY — one remote tombstone can be reviewed for local application');
      }
      if (l.kind !== 'tombstone' || !keys(l, ['kind', 'intent', 'acknowledged'])) return blocked('BLOCKED — explicit local tombstone evidence required');
      const i = l.intent;
      if (!keys(i, ['version', 'operation_id', 'user_id', 'localId', 'supabase_id', 'original', 'expected']) || i.version !== 1 ||
          !text(i.operation_id) || i.user_id !== s.owner || i.localId !== t.localId || i.supabase_id !== t.supabase_id ||
          !note(i.original, t, s.owner) || !keys(i.expected, ['contentFingerprint', 'lifecycle']) || !hex(i.expected.contentFingerprint) ||
          !lifecycle(i.expected.lifecycle) || i.expected.lifecycle.deleted_at !== null ||
          await hash(content(i.original)) !== i.expected.contentFingerprint)
        return blocked('BLOCKED — owner-bound intent and original snapshot not proven');
      const intendedRemote = remote.deleted_at !== null && remote.operation_id === i.operation_id &&
        remote.revision === i.expected.lifecycle.revision + 1 && cloudHash === i.expected.contentFingerprint;
      if (base.lifecycle.deleted_at !== null) {
        if (!keys(l.acknowledged, ['contentFingerprint', 'lifecycle']) ||
            !equal(l.acknowledged.lifecycle, base.lifecycle) || l.acknowledged.contentFingerprint !== base.contentFingerprint ||
            !intendedRemote || !equal(remote, base.lifecycle) || cloudHash !== base.contentFingerprint)
          return blocked('BLOCKED — acknowledged tombstone evidence differs; do not restore or purge');
        return result('DELETION_ACKNOWLEDGED', 'NO DELETION ACTION — matching tombstone acknowledgement retained; no purge', 'NONE');
      }
      if (l.acknowledged !== null || !equal(i.expected.lifecycle, base.lifecycle) || i.expected.contentFingerprint !== base.contentFingerprint)
        return blocked('BLOCKED — intent no longer matches the reviewed baseline');
      if (remote.deleted_at !== null) {
        if (!intendedRemote) return conflict();
        return await preview(s, 'TOMBSTONE_CONVERGED', 'PREVIEW_ACKNOWLEDGEMENT', 'PREVIEW ONLY — matching cloud tombstone needs acknowledgement, not a cloud write');
      }
      if (cloudHash !== base.contentFingerprint || !equal(remote, base.lifecycle)) return conflict();
      return await preview(s, 'LOCAL_DELETE_INTENT', 'PREVIEW_CLOUD_TOMBSTONE', 'PREVIEW ONLY — one explicit local intent can be reviewed for a cloud tombstone CAS');
    } catch (_) {
      return blocked('BLOCKED — malformed or unreadable lifecycle evidence; nothing applied');
    }
  }
  async function review(snapshot, ticket) {
    if (!hex(ticket)) return blocked('BLOCKED — valid preview ticket required');
    const next = await plan(snapshot);
    if (!next.previewReady || next.ticket !== ticket) return blocked('BLOCKED — preview evidence changed; inspect again');
    return next;
  }
  const api = Object.freeze({ plan, review });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CapNotesTombstonePlan = api;
})(globalThis);
