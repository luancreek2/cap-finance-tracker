/* Explicit, one-record notes push/pull. No boot hooks, save wrappers, timers, or
   background work. Preview reads only; each persistent action needs consent. */
(function () {
  'use strict';
  const SOURCE = 'manual-notes-v1', LOCK = 'cap-controlled-notes-test';
  const copy = x => JSON.parse(JSON.stringify(x)), eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hex = x => /^[0-9a-f]{64}$/i.test(x || '');
  function content(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id ||
        typeof row.user_id !== 'string' || !row.user_id || typeof row.legacy_id !== 'string' || !row.legacy_id ||
        ['title', 'body', 'note_date'].some(k => !Object.hasOwn(row, k) || row[k] !== null && typeof row[k] !== 'string') ||
        row.note_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(row.note_date) ||
        Object.keys(row).some(k => !['id', 'user_id', 'legacy_id', 'title', 'body', 'note_date', 'created_at', 'updated_at'].includes(k))) throw Error('Note snapshot invalid');
    return Object.fromEntries(['legacy_id', 'title', 'body', 'note_date'].map(k => [k, row[k]]));
  }
  const fingerprint = row => CapSync.contentFingerprint(row);
  const key = r => r.entity + ':' + r.supabase_id;
  const blocked = status => ({ allowed: false, status });

  // Pure decision layer. Blocked/conflict statuses carry only field names. The
  // explicit resolution preview intentionally returns the on-device local and
  // cloud note rows so the user can compare them; that private content is never
  // copied into status, action, field-name, or diagnostic strings.
  async function plan(snapshot, direction = 'push') {
    const s = snapshot, b = s.baseline, v = s.validation;
    if (!s.owner || !s.syncOff || !s.persisted) return blocked('BLOCKED — authentication, local persistence, or Cloud Sync OFF not proven');
    if (s.recovery || s.refresh || s.pullRecovery) return blocked('BLOCKED — unresolved recovery checkpoint; inspect recovery first');
    if (b?.version !== 2 || b.user_id !== s.owner || !Array.isArray(b.records) || !b.records.length ||
        b.records.some(r => r.user_id !== s.owner || !r.supabase_id || r.localId === undefined || r.localId === null || String(r.localId) === '' || !hex(r.contentFingerprint))) return blocked('BLOCKED — verified owned baseline required');
    if (!Array.isArray(s.entries) || s.entries.length > 1) return blocked('BLOCKED — unrelated or multiple queued operations; nothing replaced');
    if (!v || v.missingCount !== 0 || v.unexpectedCount !== 0 || v.foreignKeyErrorCount !== 0 ||
        !Number.isInteger(v.mismatchCount) || v.mismatchCount < 0) return blocked('BLOCKED — full local/cloud validation failed');
    const records = s.records;
    if (!Array.isArray(records) || records.length !== b.records.length ||
        new Set(b.records.map(key)).size !== b.records.length || new Set(records.map(key)).size !== records.length ||
        new Set(b.records.map(r => r.entity + ':' + r.localId)).size !== b.records.length ||
        new Set(records.map(r => r.entity + ':' + r.localId)).size !== records.length) return blocked('BLOCKED — record coverage or mapping is ambiguous');
    const base = new Map(b.records.map(r => [key(r), r]));
    if (records.some(r => !base.has(key(r)) || r.user_id !== s.owner ||
        String(r.localId) !== String(base.get(key(r)).localId) || !hex(r.contentFingerprint) || !hex(r.cloudContentFingerprint))) return blocked('BLOCKED — record mapping or ownership differs');
    if (direction === 'pull') {
      if (v.mismatchCount !== 0) return blocked('BLOCKED — validation mismatches require review before pulling');
      if (s.entries.length) return blocked('BLOCKED — pending operations must be reviewed before pulling');
      const localChanges = records.filter(r => r.contentFingerprint !== base.get(key(r)).contentFingerprint);
      const remoteChanges = records.filter(r => r.cloudContentFingerprint !== base.get(key(r)).contentFingerprint);
      if (localChanges.length) {
        const simultaneous = localChanges.filter(r => r.cloudContentFingerprint !== base.get(key(r)).contentFingerprint);
        const divergent = simultaneous.filter(r => r.contentFingerprint !== r.cloudContentFingerprint);
        if (divergent.length) {
          // Field names only. Values, IDs, and private baseline content stay out.
          let fields = [];
          if (divergent.length === 1) try {
            const target = divergent[0];
            const locals = (s.notes || []).filter(n => n.id === target.supabase_id && n.legacy_id === String(target.localId));
            const clouds = (v.snapshot?.notes || []).filter(n => n.id === target.supabase_id && n.user_id === s.owner);
            if (locals.length === 1 && clouds.length === 1) {
              content(locals[0]); content(clouds[0]);
              fields = ['title', 'body', 'note_date'].filter(k => !eq(locals[0][k], clouds[0][k]));
            }
          } catch (_) {}
          return { ...blocked('CONFLICT — local and cloud changed; nothing overwritten'), conflict: true, fields };
        }
        if (simultaneous.length === localChanges.length) return blocked('BLOCKED — local and cloud already match; baseline acknowledgement requires separate review');
        return blocked('BLOCKED — local edits must be reviewed before pulling');
      }
      if (!remoteChanges.length) return blocked('NO CLOUD NOTE CHANGE TO PULL — local, baseline, and cloud agree');
      if (remoteChanges.length !== 1 || remoteChanges[0].entity !== 'notes') return blocked('BLOCKED — exactly one existing cloud note change is supported');
      const target = remoteChanges[0], locals = (s.notes || []).filter(n => n.id === target.supabase_id && n.legacy_id === String(target.localId));
      const clouds = (v.snapshot?.notes || []).filter(n => n.id === target.supabase_id);
      if (locals.length !== 1 || clouds.length !== 1) return blocked('BLOCKED — existing note mapping not proven');
      const local = locals[0], cloud = clouds[0];
      try {
        content(local); content(cloud);
        if (local.user_id !== s.owner || cloud.user_id !== s.owner || local.legacy_id !== cloud.legacy_id ||
            typeof cloud.title !== 'string' || typeof cloud.body !== 'string' ||
            await fingerprint(local) !== target.contentFingerprint || await fingerprint(cloud) !== target.cloudContentFingerprint) throw Error('Unsupported mapping');
      } catch (_) { return blocked('BLOCKED — complete cloud note cannot be represented safely'); }
      return { allowed: true, mode: 'pull', status: 'CLOUD NOTE CHANGE — pull preview ready', action: 'PULL ONE EXISTING NOTE',
        fields: ['title', 'body', 'note_date'].filter(k => !eq(local[k], cloud[k])), local: copy(local), cloud: copy(cloud) };
    }
    if (direction === 'resolve') {
      if (v.mismatchCount !== 0) return blocked('BLOCKED — validation mismatches require review before resolving');
      if (s.entries.length) return blocked('BLOCKED — pending operations must be reviewed before resolving');
      const localChanges = records.filter(r => r.contentFingerprint !== base.get(key(r)).contentFingerprint);
      const remoteChanges = records.filter(r => r.cloudContentFingerprint !== base.get(key(r)).contentFingerprint);
      if (!localChanges.length && !remoteChanges.length) return blocked('NO CONFLICT TO RESOLVE — local, baseline, and cloud agree');
      if (!localChanges.length) return blocked('BLOCKED — cloud-only change; use the pull preview');
      if (!remoteChanges.length) return blocked('BLOCKED — local-only change; use the manual sync preview');
      if (localChanges.length !== 1 || remoteChanges.length !== 1 || key(localChanges[0]) !== key(remoteChanges[0]) || localChanges[0].entity !== 'notes')
        return blocked('BLOCKED — exactly one existing note conflict is supported');
      const target = localChanges[0], record = base.get(key(target));
      if (records.some(r => key(r) !== key(target) && (r.contentFingerprint !== base.get(key(r)).contentFingerprint || r.cloudContentFingerprint !== base.get(key(r)).contentFingerprint)))
        return blocked('BLOCKED — unrelated local/cloud changes require review');
      if (target.contentFingerprint === target.cloudContentFingerprint) return blocked('BLOCKED — local and cloud already match; baseline review required');
      const locals = (s.notes || []).filter(n => n.id === target.supabase_id && n.legacy_id === String(target.localId));
      const clouds = (v.snapshot?.notes || []).filter(n => n.id === target.supabase_id && n.user_id === s.owner);
      if (locals.length !== 1 || clouds.length !== 1) return blocked('BLOCKED — existing note mapping not proven');
      const local = locals[0], cloud = clouds[0];
      try {
        content(local); content(cloud);
        if (local.user_id !== s.owner || cloud.user_id !== s.owner || local.legacy_id !== cloud.legacy_id ||
            await fingerprint(local) !== target.contentFingerprint || await fingerprint(cloud) !== target.cloudContentFingerprint ||
            target.contentFingerprint === record.contentFingerprint || target.cloudContentFingerprint === record.contentFingerprint) throw Error('Invalid conflict');
      } catch (_) { return blocked('BLOCKED — complete conflict content or ownership not proven'); }
      return { allowed: true, mode: 'resolve', status: 'CONFLICT — resolution preview ready', action: 'REVIEW ONE NOTE CONFLICT',
        fields: ['title', 'body', 'note_date'].filter(k => !eq(local[k], cloud[k])), local: copy(local), cloud: copy(cloud),
        record: copy(record), canKeepCloud: true, canKeepLocal: false };
    }
    const pending = s.entries[0];
    if (pending && (pending.source !== SOURCE || pending.entity !== 'notes' || pending.operation !== 'upsert' ||
        pending.user_id !== s.owner || typeof pending.id !== 'string' || !pending.id || !pending.manual_original)) return blocked('BLOCKED — unrelated queued operation; preserved');
    const changed = records.filter(r => r.contentFingerprint !== base.get(key(r)).contentFingerprint);
    const targets = pending ? records.filter(r => r.entity === 'notes' && r.supabase_id === pending.supabase_id && String(r.localId) === pending.local_id) : changed;
    if (!pending && !changed.length && records.every(r => r.contentFingerprint === r.cloudContentFingerprint)) return blocked('NO NOTE EDIT TO QUEUE — local, baseline, and cloud agree');
    if (targets.length !== 1 || targets[0].entity !== 'notes') return blocked('BLOCKED — exactly one existing note edit is supported');
    const target = targets[0], originalBase = base.get(key(target));
    if (records.some(r => key(r) !== key(target) && (r.contentFingerprint !== base.get(key(r)).contentFingerprint || r.cloudContentFingerprint !== base.get(key(r)).contentFingerprint))) return blocked('BLOCKED — unrelated local/cloud changes require review');
    if (target.cloudContentFingerprint !== originalBase.contentFingerprint && target.cloudContentFingerprint !== target.contentFingerprint) {
      let fields = [];
      try {
        const local = (s.notes || []).find(n => n.id === target.supabase_id && n.legacy_id === String(target.localId));
        const cloud = (v.snapshot?.notes || []).find(n => n.id === target.supabase_id && n.user_id === s.owner);
        if (local && cloud) { content(local); content(cloud); fields = ['title', 'body', 'note_date'].filter(k => !eq(local[k], cloud[k])); }
      } catch (_) {}
      return { ...blocked('CONFLICT — cloud note changed; no overwrite permitted'), conflict: true, fields };
    }
    if (!pending && target.cloudContentFingerprint !== originalBase.contentFingerprint) return blocked('BLOCKED — unqueued convergence needs baseline review; no evidence replaced');
    const locals = (s.notes || []).filter(n => n.id === target.supabase_id && n.legacy_id === String(target.localId));
    const clouds = (v.snapshot?.notes || []).filter(n => n.id === target.supabase_id);
    if (locals.length !== 1 || clouds.length !== 1) return blocked('BLOCKED — existing note mapping not proven');
    const local = locals[0], cloud = clouds[0];
    try {
      content(local); content(cloud);
      if (local.user_id !== s.owner || cloud.user_id !== s.owner || local.legacy_id !== cloud.legacy_id ||
          await fingerprint(local) !== target.contentFingerprint || await fingerprint(cloud) !== target.cloudContentFingerprint) throw Error('Invalid mapping');
      if (pending && (!eq(content(pending.payload), content(local)) || pending.payload.id !== local.id || pending.payload.user_id !== s.owner ||
          pending.manual_original.id !== local.id || pending.manual_original.user_id !== s.owner || pending.manual_original.legacy_id !== local.legacy_id ||
          await fingerprint(pending.manual_original) !== originalBase.contentFingerprint)) return blocked('BLOCKED — queued edit no longer matches local note or baseline; pending work retained');
    } catch (_) { return blocked('BLOCKED — complete note content or ownership not proven'); }
    const fields = ['title', 'body', 'note_date'].filter(k => !eq(local[k], cloud[k]));
    return { allowed: true, status: pending ? 'PENDING NOTE — preview ready' : 'LOCAL NOTE EDIT — preview ready',
      mode: pending ? 'push' : 'queue', action: target.contentFingerprint === target.cloudContentFingerprint ? 'ACKNOWLEDGE ONLY' : 'UPDATE ONE EXISTING NOTE',
      fields, local: copy(local), original: copy(pending ? pending.manual_original : cloud), entry: pending ? copy(pending) : null };
  }

  function localRow(localId) {
    const prep = migrationPrepare();
    if (prep.blockingProblems.length) throw Error('Local validation failed');
    const p = buildSupabaseMigrationPlan(prep), matches = (p.tables.find(t => t[0] === 'notes')?.[1] || []).filter(n => n.legacy_id === String(localId));
    if (matches.length !== 1) throw Error('Ambiguous local note');
    return matches[0];
  }
  const current = () => localStorage.getItem('pera') === JSON.stringify(S);
  const financial = () => JSON.stringify(Object.fromEntries(['accts', 'tx', 'pend', 'xfer', 'bills', 'goals', 'debts', 'budgets'].map(k => [k, S[k]])));
  function guard(receipt) {
    try { return current() && typeof claude === 'undefined' && CapSupabase.status().userId === receipt.owner &&
      JSON.stringify(S) === receipt.state && financial() === receipt.financial && eq(localRow(receipt.decision.local.legacy_id), receipt.decision.local); }
    catch (_) { return false; }
  }
  async function inspect(direction = 'push') {
    if (!window.CAP_DEV_TOOLS || typeof claude !== 'undefined' || !current()) return blocked('BLOCKED — developer/local-only mode or persisted state not proven');
    // Array notes have stable title/date mapping; legacy text notes require
    // separate local migration review rather than implicit conversion here.
    if (!Array.isArray(S.notes)) return blocked('BLOCKED — stable note-list representation required; no conversion performed');
    const state = JSON.stringify(S), finance = financial(), u = await CapSupabase.currentUser();
    const baseline = await CapOff.syncStore('syncmeta', 'get', 'baseline'), entries = await CapOff.syncStore('outbox', 'all');
    const recovery = await CapOff.syncStore('syncmeta', 'get', 'controlled-notes-test-v1'), refresh = await CapOff.syncStore('syncmeta', 'get', 'demo-local-refresh-state-v1');
    const pullRecovery = await CapOff.syncStore('syncmeta', 'get', 'manual-notes-pull-v1');
    if (recovery || refresh || pullRecovery) return blocked('BLOCKED — unresolved recovery checkpoint; no action permitted');
    if (['pull', 'resolve'].includes(direction) && (await CapOff.syncStore('kv', 'get', 'state'))?.json !== state) return blocked('BLOCKED — IndexedDB and local state differ; reload and inspect before pulling');
    const prep = migrationPrepare(); if (prep.blockingProblems.length) return blocked('BLOCKED — local data validation failed');
    const p = buildSupabaseMigrationPlan(prep);
    if (!u?.id || p.userId !== u.id) return blocked('BLOCKED — authentication or mapping not proven');
    const validation = await CapSupabase.validateRealData(p), records = await CapSync.recordFingerprints(p, validation);
    // The older validator does not count missing/duplicate profile rows. Require
    // exact snapshot coverage as well as its reported errors before proceeding.
    if (validation.snapshot?.profiles?.length !== 1 || validation.snapshot?.user_preferences?.length !== 1 ||
        validation.snapshot.profiles[0].id !== u.id || validation.snapshot.user_preferences[0].user_id !== u.id ||
        p.tables.some(([table, rows]) => !Array.isArray(validation.snapshot?.[table]) || validation.snapshot[table].length !== rows.length ||
          new Set(validation.snapshot[table].map(row => row.id)).size !== rows.length ||
          validation.snapshot[table].some(cloud => cloud.user_id !== u.id || !rows.some(local => local.id === cloud.id && local.legacy_id === cloud.legacy_id)))) return blocked('BLOCKED — complete cloud snapshot coverage not proven');
    const decision = await plan({ owner: u.id, syncOff: (await CapSync.status()).mode === 'off', persisted: current(), baseline, entries, recovery, refresh, pullRecovery, validation, records, notes: p.tables.find(t => t[0] === 'notes')?.[1] }, direction);
    if (!decision.allowed) return decision;
    const receipt = { allowed: true, owner: u.id, state, financial: finance, baseline, entries, decision };
    if (!guard(receipt)) return blocked('BLOCKED — local state changed during preview');
    receipt.ticket = await CapSync.contentFingerprint({ direction, owner: u.id, state, baseline: JSON.stringify(baseline), entries: JSON.stringify(entries), desired: JSON.stringify(decision.local), cloud: JSON.stringify(validation.snapshot.notes) });
    return receipt;
  }

  let busy = false;
  async function run(mode, ticket, io) {
    if (!['queue', 'push', 'pull', 'resolve'].includes(mode) || !ticket || !io || ['withLock', 'inspect', 'confirm', ...(mode === 'pull' ? ['pull'] : mode === 'resolve' ? ['resolve'] : ['stage', 'push'])].some(k => typeof io[k] !== 'function')) return blocked('BLOCKED — explicit preview and action adapters required');
    if (busy) return blocked('BLOCKED — manual notes action already running');
    busy = true;
    let started = false;
    try {
      return await io.withLock(async () => {
        const first = await io.inspect();
        if (!first.allowed || first.ticket !== ticket || first.decision.mode !== mode) return blocked('BLOCKED — preview changed; inspect again before acting');
        if (await io.confirm(mode, first) !== true) return blocked('CANCELLED — nothing changed');
        const second = await io.inspect();
        if (!second.allowed || second.ticket !== ticket || second.decision.mode !== mode) return blocked('BLOCKED — evidence changed during confirmation; nothing applied');
        started = true;
        if (mode === 'pull') {
          const result = await io.pull(second);
          return result?.committed === true && result.verified === true ? { allowed: true, status: 'PULLED — VERIFIED AND FINALIZED; LOCAL BACKUP RETAINED' } : blocked('STOPPED — pull verification incomplete; inspect recovery before any retry');
        }
        if (mode === 'resolve') {
          const result = await io.resolve(second);
          return result?.committed === true && result.verified === true ? { allowed: true, status: 'RESOLVED — CLOUD VERSION KEPT; LOCAL BACKUP RETAINED' } : blocked('STOPPED — resolution verification incomplete; inspect note-pull recovery before any retry');
        }
        if (mode === 'queue') {
          const result = await io.stage(second);
          return result?.committed === true && result.verified === true ? { allowed: true, status: 'QUEUED LOCALLY — no cloud write; preview again before pushing' } : blocked('STOPPED — local queue verification failed; inspect before retrying');
        }
        const result = await io.push(second);
        return { allowed: result?.finalized === true, status: result?.status || 'STOPPED — push not verified; pending work retained' };
      });
    } catch (error) {
      if (mode === 'pull' && error?.committed === true) return blocked('LOCAL WRITE OCCURRED — PULL VERIFICATION FAILED; inspect note-pull recovery');
      if (mode === 'pull' && error?.backedUp === true) return blocked('STOPPED — PULL BACKUP/CHECKPOINT RETAINED; LOCAL DATA NOT REPLACED');
      if (mode === 'resolve' && error?.committed === true) return blocked('LOCAL WRITE OCCURRED — RESOLUTION VERIFICATION FAILED; inspect note-pull recovery');
      if (mode === 'resolve' && error?.backedUp === true) return blocked('STOPPED — RESOLUTION BACKUP/CHECKPOINT RETAINED; LOCAL DATA NOT REPLACED');
      return blocked(started ? 'STOPPED — action outcome requires inspection; do not clear or automatically retry' : 'BLOCKED — read or lock failed; no action started');
    }
    finally { busy = false; }
  }
  function adapters(direction = 'push', choice = null) {
    return {
      withLock: run => {
        if (!navigator.locks?.request) throw Error('Cross-tab lock unavailable');
        return navigator.locks.request(LOCK, { mode: 'exclusive', ifAvailable: true }, lock => { if (!lock) throw Error('Another action is active'); return run(); });
      }, inspect: () => inspect(direction),
      confirm: mode => mode === 'resolve' ? window.confirm(choice === 'cloud' ? 'Keep the CLOUD version of this one conflicted note?\n\nThis browser’s local note will be replaced by the reviewed cloud version. A local backup of the conflicted state and baseline is saved first. No Supabase record is changed, no outbox entry is created, and financial data is untouched. Cloud Sync stays OFF. Keep other tabs idle.' : 'Keep the LOCAL version?\n\nThis destructive cloud overwrite is not available in this phase. Nothing will change.') : mode === 'pull' ? window.confirm('Pull ONE existing cloud note into this browser?\n\nThe local note must still match its baseline. A local recovery backup is saved first. Only this note and its baseline acknowledgement will change; no financial or Supabase record is written and no outbox entry is removed. Cloud Sync stays OFF. Keep other tabs idle.') : mode === 'queue' ? window.confirm('Queue ONE existing note edit locally?\n\nNo cloud write occurs. The current note content is kept in the local outbox; no note or baseline is changed. Cloud Sync stays OFF.') : window.confirm('Push ONE queued note edit to Supabase?\n\nThis can make one real cloud note write. The queued content must still match the local note, and the cloud must match the verified baseline or already match the edit. After cloud verification, only this note baseline is acknowledged and its exact outbox entry removed. No financial record changes. Cloud Sync stays OFF. Keep other tabs idle.'),
      resolve: async r => {
        if (choice !== 'cloud') throw Error('Keep-local resolution is not implemented');
        const cloud = r.decision.cloud, local = r.decision.local, record = r.decision.record;
        const nextRecord = { ...record, contentFingerprint: await fingerprint(cloud), cloud_updated_at: cloud.updated_at || null, last_resolution_id: crypto.randomUUID() };
        return CapOff.applyVerifiedNoteResolution({ userId: r.owner, expectedLocalJson: r.state, expectedBaseline: r.baseline, expectedRecord: record,
          expectedLocalFingerprint: await fingerprint(local), local, cloud, nextRecord, backupKey: 'manual-notes-pull-backup:' + crypto.randomUUID() },
        () => typeof claude === 'undefined' && CapSupabase.status().userId === r.owner,
        async () => {
          const user = await CapSupabase.currentUser();
          if (user?.id !== r.owner) return false;
          const rows = await CapSupabase.syncRequest('/rest/v1/notes?select=*&user_id=eq.' + encodeURIComponent(r.owner) + '&id=eq.' + encodeURIComponent(cloud.id));
          return Array.isArray(rows) && rows.length === 1 && rows[0].id === cloud.id && rows[0].user_id === r.owner && eq(content(rows[0]), content(cloud));
        });
      },
      pull: async r => {
        const cloud = r.decision.cloud, record = r.baseline.records.find(x => x.entity === 'notes' && x.supabase_id === cloud.id);
        const nextRecord = { ...record, contentFingerprint: await fingerprint(cloud), cloud_updated_at: cloud.updated_at || null, last_pull_id: crypto.randomUUID() };
        return CapOff.applyVerifiedNotePull({ userId: r.owner, expectedLocalJson: r.state, expectedBaseline: r.baseline, expectedRecord: record,
          nextRecord, cloud, backupKey: 'manual-notes-pull-backup:' + crypto.randomUUID() },
        () => typeof claude === 'undefined' && CapSupabase.status().userId === r.owner,
        async () => {
          const user = await CapSupabase.currentUser();
          if (user?.id !== r.owner) return false;
          const rows = await CapSupabase.syncRequest('/rest/v1/notes?select=*&user_id=eq.' + encodeURIComponent(r.owner) + '&id=eq.' + encodeURIComponent(cloud.id));
          return Array.isArray(rows) && rows.length === 1 && rows[0].id === cloud.id && rows[0].user_id === r.owner && eq(content(rows[0]), content(cloud));
        });
      },
      stage: r => {
        const entry = { id: crypto.randomUUID(), source: SOURCE, entity: 'notes', operation: 'upsert', user_id: r.owner,
          local_id: r.decision.local.legacy_id, supabase_id: r.decision.local.id, payload: r.decision.local, manual_original: r.decision.original,
          queued_at: new Date().toISOString(), local_updated_at: new Date().toISOString(), retry_count: 0, last_error: null };
        return CapOff.stageVerifiedManualNote({ userId: r.owner, entry, expectedBaseline: r.baseline }, () => guard(r));
      },
      push: r => CapSync.rehearseNotePush(r.decision.entry.id, {
        currentUser: () => CapSupabase.currentUser(),
        readState: async () => {
          if (!guard(r) || await CapOff.syncStore('syncmeta', 'get', 'controlled-notes-test-v1') || await CapOff.syncStore('syncmeta', 'get', 'demo-local-refresh-state-v1') || await CapOff.syncStore('syncmeta', 'get', 'manual-notes-pull-v1')) throw Error('Changed local context');
          const baseline = await CapOff.syncStore('syncmeta', 'get', 'baseline'), entries = await CapOff.syncStore('outbox', 'all');
          if (!eq(baseline, r.baseline) || !eq(entries, r.entries)) throw Error('Changed persistent context');
          return { baseline, entries };
        },
        readLocal: entry => localRow(entry.local_id),
        readCloud: async entry => {
          const rows = await CapSupabase.syncRequest('/rest/v1/notes?select=*&user_id=eq.' + encodeURIComponent(r.owner) + '&id=eq.' + encodeURIComponent(entry.supabase_id));
          if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== entry.supabase_id || rows[0].user_id !== r.owner) throw Error('BLOCKED — RECORD ABSENCE NOT PROVEN');
          content(rows[0]); return rows[0];
        },
        ready: () => CapSupabase.refreshNotesRpcReadiness(),
        cas: async args => {
          const u = await CapSupabase.currentUser();
          const recovery = await CapOff.syncStore('syncmeta', 'get', 'controlled-notes-test-v1'), refresh = await CapOff.syncStore('syncmeta', 'get', 'demo-local-refresh-state-v1');
          const baseline = await CapOff.syncStore('syncmeta', 'get', 'baseline'), entries = await CapOff.syncStore('outbox', 'all');
          const pullRecovery = await CapOff.syncStore('syncmeta', 'get', 'manual-notes-pull-v1');
          if (u?.id !== r.owner || recovery || refresh || pullRecovery || !eq(baseline, r.baseline) || !eq(entries, r.entries) ||
              !guard(r) || !CapSupabase.notesRpcReady() || args.p_expected === null || args.p_id !== r.decision.local.id ||
              !eq(args.p_desired, content(r.decision.local))) throw Error('Write authorization changed');
          return CapSupabase.syncRequest('/rest/v1/rpc/cap_sync_note_put', { method: 'POST', body: JSON.stringify(args) });
        },
        finalize: receipt => CapOff.finalizeVerifiedNotePush(receipt, () => guard(r)),
      }),
    };
  }
  function mountPreview(parent, direction) {
    const preview = document.createElement('button'), out = document.createElement('div');
    preview.type = 'button'; preview.className = 'btn s'; preview.textContent = direction === 'pull' ? 'Preview cloud note pull (read-only)' : 'Preview manual note sync (read-only)';
    out.className = 'st-note'; out.style.whiteSpace = 'pre-line'; out.setAttribute('role', 'status'); out.setAttribute('aria-live', 'polite');
    preview.onclick = async () => {
      preview.disabled = true; out.textContent = 'Reading manual note preview…';
      try {
        const r = await inspect(direction);
        if (!r.allowed) {
          out.textContent = r.status + '\nNo changes made. Cloud Sync remains OFF.' +
            (r.conflict ? '\nFields with different local/cloud values: ' + (r.fields?.length ? r.fields.join(', ') : 'not available') +
              '\nBoth versions are preserved. No pull or push action is offered.' : '');
          return;
        }
        out.textContent = r.decision.status + '\nOne existing note · ' + r.decision.action + '\nFields: ' + (r.decision.fields.join(', ') || 'none; acknowledgement only') + '\nNo content, financial values, or identifiers displayed. No changes made. Cloud Sync remains OFF.';
        const action = document.createElement('button'); action.type = 'button'; action.className = 'btn s';
        action.textContent = r.decision.mode === 'pull' ? 'Pull this cloud note locally (confirm)' : r.decision.mode === 'queue' ? 'Queue this note edit locally (confirm)' : 'Push this queued note (real cloud write, confirm)';
        action.onclick = async () => {
          action.disabled = true; preview.disabled = true;
          try { const result = await run(r.decision.mode, r.ticket, adapters(direction)); out.textContent = result.status + '\nCloud Sync remains OFF. No automatic retry.' + (r.decision.mode === 'pull' ? ' If stopped, inspect note-pull recovery before any further action.' : ' Preview again to inspect pending work.'); }
          finally { preview.disabled = false; }
        };
        out.appendChild(action);
      } catch (_) { out.textContent = 'BLOCKED — read-only comparison could not complete. Record absence not proven. No changes made.'; }
      finally { preview.disabled = false; }
    };
    parent.appendChild(preview); parent.appendChild(out);
  }
  async function inspectPullRecovery() {
    const checkpoint = await CapOff.syncStore('syncmeta', 'get', 'manual-notes-pull-v1');
    if (!checkpoint) return { status: 'NO NOTE-PULL RECOVERY CHECKPOINT', present: false };
    const report = { present: true, phase: ['prepared', 'applied'].includes(checkpoint.phase) ? checkpoint.phase : 'unknown',
      kind: checkpoint.kind === 'manual-note-resolution' ? 'resolution' : 'pull',
      owned: false, backupVerified: false, outbox: -1, local: 'not compared', baseline: 'not compared', persisted: false,
      financialUnchanged: false, cloud: 'BLOCKED — CLOUD SNAPSHOT NOT PROVEN' };
    const baseline = await CapOff.syncStore('syncmeta', 'get', 'baseline'), entries = await CapOff.syncStore('outbox', 'all');
    const state = await CapOff.syncStore('kv', 'get', 'state');
    if (Array.isArray(entries)) report.outbox = entries.length;
    try {
      const u = await CapSupabase.currentUser(); report.owned = !!u?.id && u.id === checkpoint.owner && baseline?.user_id === u.id;
      if (report.owned) {
        const cloud = checkpoint.cloud;
        const rows = await CapSupabase.syncRequest('/rest/v1/notes?select=*&user_id=eq.' + encodeURIComponent(u.id) + '&id=eq.' + encodeURIComponent(cloud.id));
        if (Array.isArray(rows) && rows.length === 1 && rows[0].user_id === u.id && rows[0].id === cloud.id) report.cloud = eq(content(rows[0]), content(cloud)) ? 'matches pulled snapshot' : 'different content';
      }
    } catch (_) {}
    if (typeof checkpoint.backupKey === 'string' && checkpoint.backupKey.startsWith('manual-notes-pull-backup:')) {
      const backup = await CapOff.syncStore('syncmeta', 'get', checkpoint.backupKey);
      report.backupVerified = !!backup && backup.owner === checkpoint.owner && backup.localJson === checkpoint.expectedLocalJson && eq(backup.baseline, checkpoint.expectedBaseline);
    }
    const json = JSON.stringify(S);
    report.local = json === checkpoint.expectedLocalJson ? 'matches original' : json === checkpoint.nextLocalJson ? 'matches pulled snapshot' : 'differs';
    report.baseline = eq(baseline, checkpoint.expectedBaseline) ? 'matches original' : eq(baseline, checkpoint.nextBaseline) ? 'matches pulled snapshot' : 'differs';
    report.persisted = localStorage.getItem('pera') === json && state?.json === json;
    try { const old = JSON.parse(checkpoint.expectedLocalJson); report.financialUnchanged = financial() === JSON.stringify(Object.fromEntries(['accts','tx','pend','xfer','bills','goals','debts','budgets'].map(k => [k, old[k]]))); } catch (_) {}
    report.status = !report.owned || !report.backupVerified || report.outbox !== 0 || !report.persisted || !report.financialUnchanged || report.cloud !== 'matches pulled snapshot' ? `BLOCKED — ${report.kind === 'resolution' ? 'RESOLUTION' : 'PULL'} RECOVERY REQUIRES REVIEW` :
      report.local === 'matches original' && report.baseline === 'matches original' ? `${report.kind === 'resolution' ? 'RESOLUTION' : 'PULL'} NOT APPLIED — BACKUP RETAINED; REVIEW REQUIRED` :
      report.local === 'matches pulled snapshot' && report.baseline === 'matches pulled snapshot' ? `${report.kind === 'resolution' ? 'RESOLUTION' : 'PULL'} DATA VERIFIED — CHECKPOINT RETAINED; REVIEW REQUIRED` : `BLOCKED — ${report.kind === 'resolution' ? 'RESOLUTION' : 'PULL'} STATE DIFFERS; REVIEW REQUIRED`;
    return report;
  }
  /* Pure in-memory proof that simultaneous edits are refused. It uses fixed
     synthetic rows only and never reads storage, real notes, or the network. */
  async function selfCheck() {
    const fixtureOwner = 'conflict-self-check-owner', base = { id: 'conflict-self-check-note', user_id: fixtureOwner, legacy_id: '1',
      title: 'Conflict self-check title', body: 'baseline-value', note_date: '2026-01-01' };
    const local = { ...base, body: 'local-value' }, cloud = { ...base, body: 'cloud-value' };
    const baseHash = await fingerprint(base), localHash = await fingerprint(local), cloudHash = await fingerprint(cloud);
    const record = { entity: 'notes', localId: '1', supabase_id: base.id, user_id: fixtureOwner, contentFingerprint: baseHash };
    const common = { owner: fixtureOwner, syncOff: true, persisted: true, recovery: null, refresh: null, pullRecovery: null,
      notes: [local], baseline: { version: 2, user_id: fixtureOwner, records: [record] },
      records: [{ ...record, contentFingerprint: localHash, cloudContentFingerprint: cloudHash }],
      validation: { missingCount: 0, unexpectedCount: 0, mismatchCount: 0, foreignKeyErrorCount: 0, snapshot: { notes: [cloud] } } };
    const pending = { id: 'conflict-self-check-op', source: SOURCE, entity: 'notes', operation: 'upsert', user_id: fixtureOwner,
      local_id: '1', supabase_id: base.id, payload: local, manual_original: base };
    const pullSnapshot = { ...common, entries: [] }, pushSnapshot = { ...common, entries: [pending] }, resolveSnapshot = { ...common, entries: [] };
    const before = JSON.stringify([pullSnapshot, pushSnapshot, resolveSnapshot]);
    const pullResult = await plan(pullSnapshot, 'pull'), pushResult = await plan(pushSnapshot, 'push');
    const resolveResult = await plan(resolveSnapshot, 'resolve');
    const cloudOnlyResult = await plan({ ...common, entries: [], notes: [base], records: [{ ...record, cloudContentFingerprint: cloudHash }] }, 'pull');
    const pullBlocked = pullResult.allowed === false && pullResult.conflict === true && /^CONFLICT/.test(pullResult.status) &&
      eq(pullResult.fields, ['body']);
    const pushBlocked = pushResult.allowed === false && pushResult.conflict === true && /^CONFLICT/.test(pushResult.status) && eq(pushResult.fields, ['body']);
    const cloudOnly = cloudOnlyResult.allowed === true && cloudOnlyResult.mode === 'pull';
    const resolutionPreview = resolveResult.allowed === true && resolveResult.mode === 'resolve' &&
      resolveResult.canKeepCloud === true && resolveResult.canKeepLocal === false;
    const unchanged = JSON.stringify([pullSnapshot, pushSnapshot, resolveSnapshot]) === before;
    return { passed: pullBlocked && pushBlocked && cloudOnly && resolutionPreview && unchanged,
      pullBlocked, pushBlocked, cloudOnly, resolutionPreview, unchanged, fields: pullResult.fields };
  }
  function mountResolution(parent) {
    const review = document.createElement('button'), out = document.createElement('div');
    review.type = 'button'; review.className = 'btn s'; review.textContent = 'Review note conflict (read-only)';
    out.className = 'st-note'; out.style.whiteSpace = 'pre-line'; out.setAttribute('role', 'status');
    review.onclick = async () => {
      review.disabled = true; out.textContent = 'Comparing this browser and cloud note versions…';
      try {
        const r = await inspect('resolve');
        if (!r.allowed) { out.textContent = r.status + '\nNo changes made. Cloud Sync remains OFF.'; return; }
        const d = r.decision, fmt = row => 'Title: ' + row.title + '\nDate: ' + (row.note_date === null ? '—' : row.note_date) + '\nBody:\n' + row.body;
        out.textContent = d.status + '\nFields differing: ' + (d.fields.join(', ') || 'none') +
          '\n\nTHIS BROWSER VERSION\n' + fmt(d.local) + '\n\nCLOUD VERSION\n' + fmt(d.cloud) +
          '\n\nPrivate preview on this device only; content is not written to diagnostics.' +
          '\nKeeping cloud replaces this browser’s note and updates only its baseline. No Supabase record is written; no financial data changes. Cloud Sync remains OFF.';
        const cloudAction = document.createElement('button'); cloudAction.type = 'button'; cloudAction.className = 'btn s';
        cloudAction.textContent = 'Keep cloud version (confirm)';
        cloudAction.onclick = async () => {
          cloudAction.disabled = true; review.disabled = true;
          try {
            const result = await run('resolve', r.ticket, adapters('resolve', 'cloud'));
            out.textContent = result.status + '\nCloud Sync remains OFF. No automatic retry. If stopped, inspect note-pull recovery before any further action.';
          } finally { review.disabled = false; }
        };
        const localAction = document.createElement('button'); localAction.type = 'button'; localAction.className = 'btn s';
        localAction.textContent = 'Keep this browser’s version (not available yet)'; localAction.disabled = true;
        out.appendChild(cloudAction); out.appendChild(localAction);
      } catch (_) { out.textContent = 'BLOCKED — conflict review could not complete. Record absence not proven. No changes made.'; }
      finally { review.disabled = false; }
    };
    parent.appendChild(review); parent.appendChild(out);
  }
  function mount(parent) {
    mountPreview(parent, 'push'); mountPreview(parent, 'pull');
    const button = document.createElement('button'), out = document.createElement('div');
    button.type = 'button'; button.className = 'btn s'; button.textContent = 'Inspect note-pull recovery (read-only)';
    out.className = 'st-note'; out.style.whiteSpace = 'pre-line'; out.setAttribute('role', 'status');
    button.onclick = async () => {
      button.disabled = true;
      try {
        const r = await inspectPullRecovery();
        out.textContent = (r.kind === 'resolution' ? 'READ-ONLY NOTE-RESOLUTION RECOVERY\n' : 'READ-ONLY NOTE-PULL RECOVERY\n') + r.status + (r.present ? '\nCheckpoint: present · phase ' + r.phase + '\nOwnership: ' + (r.owned ? 'verified' : 'not proven') +
          '\nBackup: ' + (r.backupVerified ? 'verified' : 'not proven') + '\nOutbox: ' + (r.outbox < 0 ? 'not read' : r.outbox) + '\nLocal state: ' + r.local + '\nBaseline: ' + r.baseline +
          '\nPersistence: ' + (r.persisted ? 'current' : 'differs') + '\nFinancial state: ' + (r.financialUnchanged ? 'unchanged' : 'not proven') + '\nCloud: ' + r.cloud : '') +
          '\nNo changes made. Cloud Sync remains OFF. Do not reset, retry, or delete recovery metadata without review.';
      } catch (_) { out.textContent = 'BLOCKED — note-pull recovery could not be read. No changes made.'; }
      finally { button.disabled = false; }
    };
    parent.appendChild(button); parent.appendChild(out);
    const check = document.createElement('button'), checkOut = document.createElement('div');
    check.type = 'button'; check.className = 'btn s'; check.textContent = 'Run conflict protection self-check (read-only)';
    checkOut.className = 'st-note'; checkOut.style.whiteSpace = 'pre-line'; checkOut.setAttribute('role', 'status');
    check.onclick = async () => {
      check.disabled = true;
      try {
        const r = await selfCheck();
        checkOut.textContent = 'READ-ONLY CONFLICT SELF-CHECK\n' + (r.passed ?
          'PASS — simultaneous local/cloud note changes are blocked; nothing overwritten\nPASS — the same conflict blocks the push planner; no cloud write\nPASS — a cloud-only change still previews as a pull\nPASS — one conflicted note can be previewed; keep-cloud only, no overwrite\nPASS — synthetic self-check made no storage or network changes' :
          'FAIL — conflict protection did not pass; do not proceed') +
          '\nNo real note, financial, or cloud data was read or changed. Cloud Sync remains OFF.';
      } catch (_) { checkOut.textContent = 'BLOCKED — conflict self-check could not complete. No changes made.'; }
      finally { check.disabled = false; }
    };
    parent.appendChild(check); parent.appendChild(checkOut);
    mountResolution(parent);
  }
  window.CapManualNotes = { plan, inspect, run, mount, inspectPullRecovery, selfCheck };
})();
