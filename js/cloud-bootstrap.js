/* Phase 6M: explicit, cloud-read-only device provisioning. Never a merge or sync cycle.
   Uses shared cloud-to-local conversion from js/cloud-to-local.js. */
(function () {
  'use strict';

  const { ENTITIES, UUID: UUID_RE, HEX: HEX_RE, copy, fail, stable, signature, validateSnapshot, assertFresh,
    hydrate } =
    (typeof window !== 'undefined' && window.CapCloudToLocal) ||
    (typeof module !== 'undefined' && module.exports && require('./cloud-to-local.js'));

  function assertIdle(image) {
    const meta = new Map(image.syncmeta);
    if (meta.has('baseline') || meta.get('production-sync-v1')?.enabled || image.outbox.length || image.syncconflicts.length ||
        ['production-sync-journal-v1', 'cloud-bootstrap-pending-v1', 'controlled-notes-test-v1', 'demo-local-refresh-state-v1', 'manual-notes-pull-v1'].some(k => meta.has(k))) fail('Device has baseline, pending operations or recovery state');
  }

  function createController(io) {
    let busy = false;
    return {
      async run() {
        if (busy) fail('Bootstrap already running');
        busy = true; let installed = false, cp;
        try {
          return await io.lock(async () => {
            const before = await io.capture(); assertIdle(before.image); assertFresh(before.state, io.defaults());
            const stored = new Map(before.image.kv).get('state');
            if (stored) assertFresh(JSON.parse(stored.json), io.defaults());
            if (before.localStorageJson !== null && stable(JSON.parse(before.localStorageJson)) !== stable(before.state)) fail('Local memory and storage differ');
            const user = await io.authenticate(); if (!UUID_RE.test(user?.id)) fail('Authenticated owner required');
            const owner = user.id, generation = io.generation();
            const guard = () => io.online() && io.owner() === owner && io.generation() === generation && !io.enabled() && io.unchanged(before);
            if (!guard()) fail('Device authentication/state changed');
            const ready = await io.readiness(); if (!ready.ok) fail('Production readiness not verified');
            const raw = validateSnapshot(await io.remote(owner), owner), initial = signature(raw);
            const candidate = hydrate(raw, owner);
            if (!candidate.cats.length) fail('Cloud has no categories; default insertion would change it');
            const verified = await io.verify(candidate, raw, owner);
            if (!guard()) fail('Device changed during validation');
            const latest = validateSnapshot(await io.remote(owner), owner);
            if (signature(latest) !== initial) fail('Cloud changed during bootstrap');
            if (!await io.confirm(raw.record_count)) return { cancelled: true };
            const final = validateSnapshot(await io.remote(owner), owner);
            if (signature(final) !== initial || !guard()) fail('Cloud or device changed before commit');
            cp = await io.install(before, candidate, verified.baseline, guard); installed = true;
            try {
              const persisted = await io.persisted();
              if (stable(persisted.state) !== stable(candidate) || stable(persisted.baseline) !== stable(verified.baseline) ||
                  persisted.outbox || persisted.conflicts || persisted.enabled) fail('Persisted installation invalid');
              const post = validateSnapshot(await io.remote(owner), owner);
              if (signature(post) !== initial) fail('Cloud changed during installation');
              await io.verify(persisted.state, post, owner);
              if (io.owner() !== owner || io.generation() !== generation) fail('Authentication changed after installation');
              await io.finish(cp);
              installed = false;
              return { ok: true, records: raw.record_count, message: 'Device ready — Cloud Sync can now be enabled' };
            } catch (e) { throw e; }
          });
        } catch (e) {
          if (installed) {
            try { await io.lock(() => io.rollback(cp)); }
            catch (rollback) { fail('HARD FAILURE: bootstrap rollback failed; keep this device OFF. ' + rollback.message); }
          }
          throw e;
        } finally { busy = false; }
      }
    };
  }

  async function verifyCandidate(state, raw, owner) {
    // Apply the same compatibility normalization used by rendering, but to the candidate only.
    // If this changes a synchronized cloud field, the round-trip checks below must refuse it.
    migrate(state);
    const prep = migrationPrepare(state);
    if (prep.blockingProblems.length) fail('Restored state has mapping problems');
    const p = buildSupabaseMigrationPlan(prep, owner, state), v = await CapSupabase.validateRealData(p);
    const expected = Object.fromEntries(ENTITIES.map(e => [e, raw.records.filter(r => r.entity === e).map(r => r.row)]));
    for (const e of ENTITIES) {
      const sort = arr => arr.slice().sort((a, b) => String(a.id || a.user_id).localeCompare(String(b.id || b.user_id)));
      if (stable(sort(expected[e])) !== stable(sort(v.snapshot[e] || []))) fail('Cloud changed during candidate verification');
    }
    if (!v.dataOk || v.missingCount || v.unexpectedCount || v.mismatchCount || v.foreignKeyErrorCount ||
        v.dryRun.wouldPush || v.dryRun.wouldPull || v.dryRun.conflicts) fail('Restored state failed validation');
    const records = await CapSync.recordFingerprints(p, v);
    const baseline = { key: 'baseline', version: 2, user_id: owner, created_at: new Date().toISOString(), fingerprint: v.fingerprint,
      records: records.map(({ cloudContentFingerprint, canonicalDiffs, ...r }) => r) };
    const diag = CapSync.fingerprintDiagnostics(records, baseline);
    if (!diag.ok || records.length !== raw.record_count || records.some(r => !UUID_RE.test(r.supabase_id) || !HEX_RE.test(r.contentFingerprint) ||
        r.contentFingerprint !== r.cloudContentFingerprint || r.user_id !== owner)) fail('Restored fingerprints or UUID mappings differ');
    const model = { records: [...p.tables.flatMap(([entity, rows]) => rows.map(row => ({ entity, row }))),
      { entity: 'profiles', row: p.profile }, { entity: 'user_preferences', row: p.preferences }] };
    const plan = await CapProductionSync.plan({ baseline, outbox: [], conflicts: [], recovery: [] }, model, raw.records, CapSync.fingerprintRow);
    if (Object.values(plan).some(a => a.length)) fail('Restored device would not enable with zero changes');
    return { baseline, validation: v };
  }

  function browserIO() {
    const memory = () => JSON.stringify(S);
    return {
      lock: fn => navigator.locks ? navigator.locks.request('cap-controlled-notes-test', { mode: 'exclusive' }, fn) : Promise.reject(Error('Safe device lock unavailable')),
      defaults: () => CAT0.map(c => ({ n: c.n, i: c.i })),
      capture: async () => ({ image: await CapOff.bootstrapStorage('read'), state: copy(S), memoryJson: memory(), localStorageJson: localStorage.getItem('pera'),
        localSnapshot: await CapOff.localSnapshot() }),
      authenticate: () => CapSupabase.currentUser(), owner: () => CapSupabase.localIdentity(), generation: () => CapSupabase.sessionGeneration(),
      online: () => navigator.onLine !== false, enabled: () => CapProductionSync.status().enabled,
      unchanged: b => !window.CAP_BOOTSTRAP_HARD_FAILURE && memory() === b.memoryJson && localStorage.getItem('pera') === b.localStorageJson,
      readiness: () => CapProductionRpc.readiness(), remote: owner => CapProductionRpc.snapshot(owner), verify: verifyCandidate,
      confirm: n => window.confirm('Set up this device from ' + n + ' cloud records?\n\nOnly this empty device will change. A local rollback copy is retained. Cloud Sync stays OFF.'),
      install: async (before, state, baseline, guard) => {
        const cp = await CapOff.bootstrapStorage('install', { before: before.image, memoryJson: before.memoryJson, localStorageJson: before.localStorageJson, localSnapshot: before.localSnapshot,
          state: { json: JSON.stringify(state), mt: state._mt || 0 }, baseline, backupKey: 'cloud-bootstrap-backup:' + crypto.randomUUID() }, guard);
        try { CapOff.installBootstrapState(cp.state.json, before.memoryJson); }
        catch (e) {
          try { await CapOff.recoverBootstrap(); }
          catch (rollback) { fail('HARD FAILURE: bootstrap rollback failed. ' + rollback.message); }
          throw e;
        }
        return cp;
      },
      persisted: async () => {
        const image = await CapOff.bootstrapStorage('read'), kv = new Map(image.kv), meta = new Map(image.syncmeta);
        const json = kv.get('state')?.json;
        if (json !== memory() || json !== localStorage.getItem('pera')) fail('Local persistence copies differ');
        return { state: JSON.parse(json), baseline: meta.get('baseline'), enabled: meta.get('production-sync-v1')?.enabled,
          outbox: image.outbox.length, conflicts: image.syncconflicts.length };
      },
      finish: cp => CapOff.bootstrapStorage('finish', cp, () => !CapProductionSync.status().enabled && memory() === cp.state.json && CapSupabase.localIdentity() === cp.baseline.user_id),
      rollback: () => CapOff.recoverBootstrap()
    };
  }

  async function availability() {
    if (!CapSupabase.status().authenticated || navigator.onLine === false || CapProductionSync.status().enabled || window.CAP_BOOTSTRAP_HARD_FAILURE) return false;
    try { const image = await CapOff.bootstrapStorage('read'); assertIdle(image); assertFresh(S, CAT0.map(c => ({ n: c.n, i: c.i }))); return true; }
    catch (_) { return false; }
  }

  const api = {
    ENTITIES, validateSnapshot, signature, assertFresh, hydrate, assertIdle, createController, verifyCandidate, availability,
    settingsHtml: () => '<div class="st-box st-col"><button type="button" class="btn s" id="cloud-bootstrap-button" disabled onclick="CapCloudBootstrap.run()">Set Up This Device From Cloud</button><small class="st-note" id="cloud-bootstrap-result">Available only on an empty, signed-in device with Cloud Sync OFF and no baseline or pending work.</small></div>',
    refresh: async () => {
      const b = document.getElementById('cloud-bootstrap-button');
      if (b) {
        b.disabled = !await availability();
      } else {
        setTimeout(() => CapCloudBootstrap.refresh(), 100);
      }
    },
    run: async () => {
      const b = document.getElementById('cloud-bootstrap-button'), out = document.getElementById('cloud-bootstrap-result');
      if (b) b.disabled = true;
      try {
        const r = await controller.run();
        if (out) out.textContent = r.message || 'Setup cancelled. Nothing changed.';
        return r;
      } catch (e) { if (out) out.textContent = 'Device setup stopped: ' + e.message; return { ok: false, error: e.message }; }
      finally { await api.refresh(); }
    }
  };

  let controller;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.CapCloudBootstrap = api; controller = createController(browserIO()); }
  // If Settings panel is already open when module loads, refresh button state
  if (typeof document !== 'undefined' && document.getElementById('cloud-bootstrap-button')) {
    CapCloudBootstrap.refresh();
  }
})();
