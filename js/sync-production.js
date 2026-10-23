/* Phase 6L. Default OFF. No raw REST upserts/deletes, migration, baseline
   initialization, or test-prefix bypass. The production server contract must
   explicitly attest readiness before this controller can be enabled. */
(function () {
  'use strict';
  const SOURCE = 'production-sync-v1', VERSION = 'CAP_PRODUCTION_SYNC_V1';
  const SNAPSHOT_VERSION = 'CAP_SYNC_SNAPSHOT_V1';
  const copy = x => JSON.parse(JSON.stringify(x));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const key = r => r.entity + ':' + (r.supabase_id || r.row?.id || r.row?.user_id);
  const failure = code => Object.assign(Error(code), { code });
  const hex = x => /^[a-f0-9]{64}$/i.test(x || '');
  const entities = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals',
    'debts', 'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'];
  const supported = new Set(entities);
  // Exact server-derived readiness checks/contracts. A top-level boolean alone
  // is never sufficient: an old, partial or locally fabricated report fails.
  const readinessChecks = ['snapshot_contract', 'snapshot_read_access', 'readiness_contract',
    'transaction_create_contract', 'durable_receipts', 'notes_receipts', 'notes_sidecar',
    'rpc_only_reads', 'legacy_lockout', 'writer_privileges', 'service_role_private'];
  const contracts = {
    readiness: 'CAP_PRODUCTION_SYNC_READINESS_V1',
    snapshot: SNAPSHOT_VERSION,
    transaction_create: 'CAP_TX_CREATE_CAS_RECEIPT_V1',
    notes_change: 'CAP_NOTES_SIDECAR_V1'
  };

  function checkBaseline(s, owner, allowConflicts = false) {
    const b = s.baseline;
    if (!owner || b?.version !== 2 || b.user_id !== owner || !Array.isArray(b.records) || !b.records.length ||
        new Set(b.records.map(key)).size !== b.records.length ||
        new Set(b.records.map(r => r.entity + ':' + r.localId)).size !== b.records.length || b.records.some(r =>
          r.localId === undefined || r.localId === null || String(r.localId) === '' ||
          r.user_id !== owner || !supported.has(r.entity) || !r.supabase_id || !hex(r.contentFingerprint))) throw failure('BASELINE_INVALID');
    if (s.recovery.some(Boolean)) throw failure('RECOVERY_REQUIRED');
    if (s.outbox.some(e => e.user_id !== owner || e.source !== SOURCE)) throw failure('OTHER_OUTBOX_REQUIRES_REVIEW');
    if (!allowConflicts && s.conflicts.length) throw failure('CONFLICT_REVIEW_REQUIRED');
  }

  function checkRecords(records, owner) {
    if (!Array.isArray(records) || new Set(records.map(key)).size !== records.length) throw failure('SNAPSHOT_INVALID');
    for (const r of records) {
      if (!supported.has(r.entity) || !r.row || typeof r.row !== 'object' || Array.isArray(r.row) ||
          (r.entity === 'profiles' ? r.row.id : r.row.user_id) !== owner ||
          !(r.row.id || r.entity === 'user_preferences' && r.row.user_id)) throw failure('SNAPSHOT_OWNERSHIP_INVALID');
    }
  }

  // A record array alone cannot prove completeness: the server response must
  // enumerate every synchronized entity with exact counts and no truncation.
  function validateSnapshot(r, owner) {
    if (!r || r.version !== SNAPSHOT_VERSION || r.owner !== owner || r.complete !== true ||
        !Array.isArray(r.records) || !Number.isSafeInteger(r.record_count) ||
        r.record_count !== r.records.length || !r.counts || typeof r.counts !== 'object' ||
        Array.isArray(r.counts) || Object.keys(r.counts).length !== entities.length ||
        entities.some(e => !Number.isSafeInteger(r.counts[e]) || r.counts[e] < 0) ||
        entities.reduce((n, e) => n + r.counts[e], 0) !== r.record_count) {
      throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
    }
    checkRecords(r.records, owner);
    const actual = Object.fromEntries(entities.map(e => [e, 0]));
    for (const record of r.records) actual[record.entity]++;
    if (entities.some(e => actual[e] !== r.counts[e])) throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
    return r.records;
  }

  // Phase 6N: Check if a transaction+account pair forms a valid supported pull group
  async function isSupportedPullGroup(s, base, local, cloud, hash) {
    // Find transaction in cloud but not in local/baseline (new cloud-only transaction)
    const txKeys = [...cloud.keys()].filter(k => k.startsWith('transactions:') && !local.has(k) && !base.has(k));
    // Initial policy B: one financial group per snapshot, never guess aggregate deltas.
    if (txKeys.length !== 1 || s.outbox.length || s.conflicts.length) return null;
    for (const txKey of txKeys) {
      const txCloud = cloud.get(txKey);
      if (!txCloud || txCloud.entity !== 'transactions' || txCloud.row.status !== 'posted') continue;
      const tx = txCloud.row;
      const legacy = String(tx.legacy_id ?? '');
      const metadataKeys = new Set(['id','ts','_u','d','amt','cat','acct','note','desc','pd']);
      if (!/^[1-9]\d*$/.test(legacy) || !Number.isSafeInteger(Number(legacy)) ||
          String(Number(legacy)) !== legacy || tx.id !== cloudMapper().migrationStableUuid('transactions:' + legacy) ||
          !tx.metadata || typeof tx.metadata !== 'object' || Array.isArray(tx.metadata) ||
          Object.keys(tx.metadata).some(k => !metadataKeys.has(k)) ||
          tx.bill_id || tx.parent_transaction_id || tx.statement_id || tx.metadata?.opening || tx.metadata?.cardFee ||
          !Number.isFinite(tx.amount) || !tx.amount ||
          [...local.values()].some(r => r.entity === 'transactions' && String(r.row.legacy_id) === legacy) ||
          [...base.values()].some(r => r.entity === 'transactions' && String(r.localId) === legacy)) continue;
      const acctKey = 'accounts:' + tx.account_id;
      const b = base.get(acctKey), l = local.get(acctKey), acctCloud = cloud.get(acctKey);

      // Must have matching account in cloud and baseline/local
      if (!acctCloud || !l || !b) continue;

      // Verify local account matches baseline (no local unsynced changes)
      const localHash = await hash('accounts', l.row);
      if (localHash !== b.contentFingerprint) continue;

      // Verify cloud account differs from baseline exactly as expected
      const bAcct = l.row, cAcct = acctCloud.row;
      if (!['debit','ewallet','credit'].includes(bAcct.account_type) || !Number.isFinite(bAcct.balance) ||
          !Number.isFinite(cAcct.balance) || String(b.localId) !== String(bAcct.legacy_id) ||
          cAcct.legacy_id !== bAcct.legacy_id ||
          bAcct.id !== cloudMapper().migrationStableUuid('accounts:' + bAcct.legacy_id)) continue;
      if (Object.hasOwn(tx.metadata,'id') && String(tx.metadata.id) !== legacy ||
          Object.hasOwn(tx.metadata,'acct') && String(tx.metadata.acct) !== String(b.localId) ||
          Object.hasOwn(tx.metadata,'amt') && tx.metadata.amt !== tx.amount ||
          Object.hasOwn(tx.metadata,'d') && tx.metadata.d !== tx.transaction_date) continue;
      const delta = bAcct.account_type === 'credit' ? -tx.amount : tx.amount;
      const expectedBalance = Math.round((Number(bAcct.balance) + delta) * 100) / 100;
      if (Math.abs(Number(cAcct.balance) - expectedBalance) > 0.000001) continue;
      if (cAcct.balance === bAcct.balance) continue; // No actual change

      // Verify cloud account matches baseline in all other fields
      const cAcctHash = await hash('accounts', cAcct);
      if (cAcctHash === b.contentFingerprint) continue; // No actual change
      if (await hash('accounts', { ...cAcct, balance: bAcct.balance }) !== localHash) continue;
      if (tx.category_id && (!local.has('categories:' + tx.category_id) || !cloud.has('categories:' + tx.category_id))) continue;

      // Verify transaction is not referenced by other pending items
      const hasPendingRef = [...cloud.keys()].some(k => {
        const item = cloud.get(k);
        return k !== txKey && item && item.row && (item.row.parent_transaction_id === tx.id || item.row.transaction_id === tx.id);
      });
      if (hasPendingRef) continue;

      // All checks passed - this is a supported pull group
      return { txKey, acctKey, tx: txCloud, acct: cloud.get(acctKey) };
    }
    return null;
  }

  function cloudMapper() {
    if (typeof window !== 'undefined' && window.CapCloudToLocal) return window.CapCloudToLocal;
    throw failure('CLOUD_MAPPER_UNAVAILABLE');
  }

  // Pure, three-way planning. Absence never authorizes physical deletion.
  async function plan(s, model, remote, hash) {
    const owner = s.baseline.user_id;
    checkBaseline(s, owner); checkRecords(model.records, owner); checkRecords(remote, owner);
    for (const r of remote.filter(r => r.entity === 'notes')) {
      const l = r.lifecycle;
      if (!l || l.version !== 1 || !Number.isSafeInteger(l.revision) || l.revision < 1 ||
          l.deleted_at !== null || !(l.operation_id === null || typeof l.operation_id === 'string')) throw failure('NOTE_LIFECYCLE_REQUIRES_REVIEW');
    }
    const local = new Map(model.records.map(r => [key(r), r]));
    const cloud = new Map(remote.map(r => [key(r), r]));
    const base = new Map(s.baseline.records.map(r => [key(r), r]));
    const result = { pushes: [], pulls: [], converged: [], conflicts: [], blocked: [] };
    for (const k of new Set([...base.keys(), ...local.keys(), ...cloud.keys()])) {
      const b = base.get(k), l = local.get(k), c = cloud.get(k);
      const lf = l ? await hash(l.entity, l.row) : null, cf = c ? await hash(c.entity, c.row) : null;
      const item = { key: k, base: b || null, local: l || null, cloud: c || null, localHash: lf, cloudHash: cf };
      if (!l || !c) {
        if (!b && l && !c) result.pushes.push(item);
        else result.blocked.push({ ...item, reason: 'PRESENCE_CHANGE_REQUIRES_REVIEW' });
      } else if (lf === cf) {
        if (!b || lf !== b.contentFingerprint || s.outbox.some(e => e.record_key === k)) result.converged.push(item);
      } else if (!b || lf !== b.contentFingerprint && cf !== b.contentFingerprint) result.conflicts.push(item);
      else if (cf === b.contentFingerprint) result.pushes.push(item);
      else result.pulls.push(item);
    }

    // Phase 6N: Detect supported transaction-create + account delta pull groups
    const pullGroup = await isSupportedPullGroup(s, base, local, cloud, hash);
    if (pullGroup) {
      const { txKey, acctKey } = pullGroup;
      const txItem = result.blocked.find(i => i.key === txKey);
      const acctItem = result.pulls.find(i => i.key === acctKey);
      if (txItem && acctItem && result.blocked.length === 1 && !result.pushes.length &&
          !result.conflicts.length && !result.converged.length && result.pulls.length === 1) {
        result.blocked = [];
        result.pulls = [];
        result.pulls.push({
          kind: 'transaction-pull',
          items: [
            txItem, acctItem
          ],
          entries: [], remote: copy(remote)
        });
      }
    }

    return result;
  }

  function ready(v) {
    if (!(v && v.version === VERSION && v.ready === true && v.legacy_lockout === true &&
        v.private_sidecar === true && v.rpc_only_reads === true && v.writer_bypassrls === false &&
        v.atomic_transaction_create === true && v.durable_operation_receipts === true)) return false;
    if (!v.checks || typeof v.checks !== 'object' || Array.isArray(v.checks) ||
        Object.keys(v.checks).length !== readinessChecks.length ||
        readinessChecks.some(k => v.checks[k] !== true)) return false;
    if (!v.contracts || typeof v.contracts !== 'object' || Array.isArray(v.contracts) ||
        Object.keys(v.contracts).length !== Object.keys(contracts).length ||
        Object.keys(contracts).some(k => v.contracts[k] !== contracts[k])) return false;
    return true;
  }

  function createEngine(io) {
    let view = { enabled: false, phase: 'off', pending: 0, conflicts: 0, reason: null };
    let stopped = false, halted = false, epoch = 0, busy = false;
    const publish = patch => { view = { ...view, ...patch }; io.changed?.(copy(view)); };
    const status = () => copy(view);
    const snapshot = () => io.snapshot();
    const commit = (s, patch, model) => io.commit(s, patch, () =>
      (!model || io.localJson() === model.json && (!io.localPersisted || io.localPersisted(model.json))) && io.localOwner() === s.baseline?.user_id);
    const current = async (owner, generation, runEpoch) => {
      const s = await snapshot();
      if (stopped || epoch !== runEpoch || !io.online() || !s.settings?.enabled || s.settings.owner !== owner ||
          io.localOwner() !== owner || io.sessionGeneration() !== generation) throw failure('RUN_CANCELLED');
      return s;
    };

    async function capture(s, model) {
      checkBaseline(s, s.settings.owner, true); checkRecords(model.records, s.settings.owner);
      if (new Set(s.outbox.map(e => e.id)).size !== s.outbox.length) throw failure('OUTBOX_INVALID');
      for (const e of s.outbox) {
        if (!e.id || !Number.isSafeInteger(e.sequence) || e.sequence < 1 || !supported.has(e.entity) ||
            !['upsert','delete'].includes(e.operation) || e.record_key !== e.entity + ':' + e.supabase_id ||
            e.operation === 'upsert' && (!e.payload || (e.entity === 'profiles' ? e.payload.id : e.payload.user_id) !== s.settings.owner ||
              (e.payload.id || e.payload.user_id) !== e.supabase_id || await io.hash(e.entity,e.payload) !== e.fingerprint) ||
            e.operation === 'delete' && (e.payload !== null || e.fingerprint !== null)) throw failure('OUTBOX_INVALID');
      }
      const baseline = new Map(s.baseline.records.map(r => [key(r), r]));
      const local = new Map(model.records.map(r => [key(r), r]));
      const additions = [];
      for (const k of new Set([...baseline.keys(), ...local.keys()])) {
        const row = local.get(k), b = baseline.get(k);
        const fingerprint = row ? await io.hash(row.entity, row.row) : null;
        const versions = s.outbox.filter(e => e.record_key === k).sort((a,b) => a.sequence - b.sequence);
        const latest = versions[versions.length - 1];
        if (latest ? latest.fingerprint === fingerprint && latest.operation === (row ? 'upsert' : 'delete') :
          b && fingerprint === b.contentFingerprint) continue;
        if (!row && !b) continue;
        additions.push({ id: io.uuid(), source: SOURCE, user_id: s.settings.owner,
          record_key: k, entity: row?.entity || b.entity, local_id: String(row?.localId ?? b.localId),
          supabase_id: row?.row.id || row?.row.user_id || b.supabase_id,
          operation: row ? 'upsert' : 'delete', payload: row ? copy(row.row) : null, fingerprint,
          expectedFingerprint: b?.contentFingerprint || null, sequence: (s.settings.sequence || 0) + additions.length + 1,
          queued_at: io.now(), retry_count: 0, last_error: null });
      }
      if (additions.length) {
        await commit(s, { putEntries: additions, state: { json: model.json, mt: model.mt },
          settings: { ...s.settings, sequence: (s.settings.sequence || 0) + additions.length } }, model);
      }
      return snapshot();
    }

    function entriesFor(s, items) {
      return items.flatMap(item => {
        const versions = s.outbox.filter(e => e.record_key === item.key).sort((a,b) => a.sequence - b.sequence);
        const latest = versions[versions.length - 1];
        // Earlier unsent versions are retired only with a verified acknowledgement
        // of the current version, and are retained in a private receipt below.
        return latest?.fingerprint === item.localHash ? versions : [];
      });
    }

    // Only one simple posted transaction + its exact account delta is currently
    // supported. Edits, pending/post transitions, fees, transfers and deletes
    // must not degrade into independent account or transaction upserts.
    async function groups(s, p) {
      const result = [], remaining = new Map(p.pushes.map(x => [x.key, x]));
      for (const item of p.pushes.filter(x => x.local.entity === 'transactions')) {
        const tx = item.local.row, acct = remaining.get('accounts:' + tx.account_id);
        const others = p.pushes.filter(x => x.local.entity === 'transactions' && x.local.row.account_id === tx.account_id);
        if (item.base || !acct?.base || !acct.cloud || others.length !== 1 || tx.status !== 'posted' ||
            tx.bill_id || tx.parent_transaction_id || tx.statement_id || tx.metadata?.opening || tx.metadata?.cardFee ||
            !Number.isFinite(tx.amount) || !tx.amount) throw failure('UNSUPPORTED_FINANCIAL_GROUP');
        const account = acct.local.row, old = acct.cloud.row;
        const delta = old.account_type === 'credit' ? -tx.amount : tx.amount;
        if (await io.hash('accounts', { ...account, balance: old.balance }) !== acct.cloudHash ||
            Math.abs(account.balance - Math.round((Number(old.balance) + delta) * 100) / 100) > 0.000001 ||
            acct.cloudHash !== acct.base.contentFingerprint) throw failure('ACCOUNT_DEPENDENCY_CONFLICT');
        const items = [item, acct];
        result.push({ kind: 'transaction-create', items, entries: entriesFor(s, items) });
        remaining.delete(item.key); remaining.delete(acct.key);
      }
      for (const item of remaining.values()) {
        if (item.local.entity !== 'notes' || !item.base || !item.cloud?.lifecycle) throw failure('UNSUPPORTED_WRITE');
        result.push({ kind: 'note-update', items: [item], entries: entriesFor(s, [item]) });
      }
      for (const group of result) {
        if (!group.entries.length || group.items.some(i => !group.entries.some(e => e.record_key === i.key))) throw failure('OUTBOX_CAPTURE_MISSING');
        // Bind retries to the oldest matching immutable operation, not a new UUID.
        group.operationId = group.entries[0].id;
      }
      return result;
    }

    async function acknowledge(s, items, entries, model) {
      const base = s.baseline.records.slice();
      for (const item of items) {
        const r = item.local || item.cloud;
        const next = { ...(item.base || {}), entity: r.entity, supabase_id: r.row.id || r.row.user_id,
          localId: String(r.localId ?? item.base?.localId), user_id: s.baseline.user_id,
          contentFingerprint: item.localHash || item.cloudHash, cloud_updated_at: item.cloud?.row.updated_at || null };
        const i = base.findIndex(b => key(b) === item.key);
        if (i < 0) base.push(next); else base[i] = next;
      }
      await commit(s, { baseline: { ...s.baseline, records: base,
        revision: (s.baseline.revision || 0) + 1, aggregateFingerprintStale: true },
        removeEntries: entries.map(e => e.id), journal: null,
        receipt: { id: s.journal?.group.operationId || io.uuid(), owner: s.baseline.user_id,
          entries, records: items, verified_at: io.now() } }, model);
    }

    async function send(s, group, model, generation, runEpoch) {
      if (!['transaction-create','note-update'].includes(group?.kind) || !Array.isArray(group.items) ||
          !Array.isArray(group.entries) || !group.entries.some(e => e.id === group.operationId) ||
          group.entries.some(e => !s.outbox.some(current => same(current,e)))) throw failure('JOURNAL_INVALID');
      for (const item of group.items) {
        const matches = s.baseline.records.filter(b => key(b) === item.key);
        if (item.base ? matches.length !== 1 || !same(matches[0], item.base) : matches.length !== 0) throw failure('JOURNAL_BASELINE_CHANGED');
        checkRecords([item.local], s.settings.owner);
        if (await io.hash(item.local.entity,item.local.row) !== item.localHash ||
            !group.entries.some(e => e.record_key === item.key && e.fingerprint === item.localHash)) throw failure('JOURNAL_INVALID');
      }
      if (!s.journal) {
        const journal = { owner: s.settings.owner, group: copy(group), created_at: io.now() };
        await commit(s, { journal }, model);
        s = await snapshot();
      }
      await current(s.settings.owner, generation, runEpoch);
      const response = await io.write(group);
      if (response?.status === 'CONFLICT') {
        try {
          const latest = await snapshot();
          await commit(latest, { putConflicts: [{ id: io.uuid(), source: SOURCE, owner: s.settings.owner,
            kind: 'server-cas-conflict', group: copy(group), requiresFreshCloudReview: true,
            status: 'unresolved', created_at: io.now() }] }, model);
        } catch (_) { halted = true; }
        throw failure('SERVER_CONFLICT');
      }
      if (!['APPLIED', 'ALREADY_APPLIED'].includes(response?.status)) throw failure('UNVERIFIED_WRITE_OUTCOME');
      await current(s.settings.owner, generation, runEpoch);
      const remote = await io.remote(s.settings.owner);
      checkRecords(remote, s.settings.owner);
      for (const item of group.items) {
        const c = remote.find(r => key(r) === item.key);
        if (!c || await io.hash(c.entity, c.row) !== item.localHash) throw failure('POST_WRITE_VERIFICATION_FAILED');
        item.cloud = c;
      }
      const latest = await snapshot();
      if (!same(latest.baseline, s.baseline) || !same(latest.journal, s.journal)) throw failure('ACKNOWLEDGEMENT_CHANGED');
      await acknowledge(latest, group.items, group.entries, model);
    }

    // A financial pull never enters groups()/send()/write(). IDB state, baseline
    // and a durable before-image journal commit together, then all copies and
    // canonical fingerprints are verified before the journal can be removed.
    async function financialPull(s, group, model, generation, runEpoch) {
      if (!io.pullModel || !io.installLocal || !io.rollbackLocal || !io.modelState || s.outbox.length || s.conflicts.length)
        throw failure('PULL_REQUIRES_REVIEW');
      const owner = s.settings.owner, mapper = cloudMapper();
      const remoteSignature = rows => mapper.stable(rows.slice().sort((a,b) => key(a).localeCompare(key(b))));
      const initial = remoteSignature(group.remote);
      const verifyRemote = async () => {
        const remote = await io.remote(owner); checkRecords(remote, owner);
        if (remoteSignature(remote) !== initial) throw failure('CLOUD_CHANGED_DURING_PULL');
      };
      await current(owner, generation, runEpoch);
      await verifyRemote();
      const fresh = await snapshot();
      if (!same(fresh, s) || fresh.state?.json !== model.json) throw failure('LOCAL_CHANGED_DURING_PULL');
      const proved = await plan(fresh, io.model(owner, fresh.baseline), group.remote, io.hash);
      if (proved.pulls.length !== 1 || !same(proved.pulls[0], group) || proved.blocked.length || proved.conflicts.length)
        throw failure('PULL_REQUIRES_REVIEW');
      const nextModel = io.pullModel(model, [group]);
      const verifyModel = async candidate => {
        checkRecords(candidate.records, owner);
        if (candidate.records.length !== group.remote.length) throw failure('PULL_FINGERPRINT_MISMATCH');
        for (const r of group.remote) {
          const local = candidate.records.find(l => key(l) === key(r));
          if (!local || await io.hash(r.entity, local.row) !== await io.hash(r.entity, r.row))
            throw failure('PULL_FINGERPRINT_MISMATCH');
        }
      };
      await verifyModel(io.modelState(nextModel.json, owner, s.baseline));
      const records = copy(s.baseline.records);
      for (const item of group.items) {
        const r = item.cloud;
        const entry = { ...(item.base || {}), entity: r.entity, supabase_id: r.row.id,
          localId: String(r.row.legacy_id), user_id: owner, contentFingerprint: item.cloudHash,
          cloud_updated_at: r.row.updated_at || null };
        const i = records.findIndex(b => key(b) === item.key);
        if (i < 0) records.push(entry); else records[i] = entry;
      }
      const baseline = { ...s.baseline, records, revision: (s.baseline.revision || 0) + 1, aggregateFingerprintStale: true };
      const journal = { kind: 'local-pull', version: 2, owner, beforeJson: model.json, beforeState: s.state,
        beforeBaseline: s.baseline, nextJson: nextModel.json, nextBaseline: baseline, created_at: io.now() };
      await verifyRemote();
      await current(owner, generation, runEpoch);
      // productionSyncCommit re-reads the entire persisted snapshot in its IDB transaction.
      await commit(s, { journal, baseline, state: { json: nextModel.json, mt: nextModel.mt } }, model);
      try {
        io.installLocal(nextModel.json, model.json);
        const after = await current(owner, generation, runEpoch);
        if (!same(after.journal, journal) || !same(after.baseline, baseline) || after.state?.json !== nextModel.json ||
            io.localJson() !== nextModel.json || !io.localPersisted(nextModel.json)) throw failure('PULL_PERSISTENCE_MISMATCH');
        await verifyModel(io.model(owner, baseline));
        await verifyRemote();
        await current(owner, generation, runEpoch);
        await commit(after, { journal: null }, nextModel);
      } catch (error) {
        try {
          const after = await snapshot();
          if (!same(after.journal, journal) || !same(after.baseline, baseline) || after.state?.json !== nextModel.json ||
              after.outbox.length || after.conflicts.length) throw failure('ROLLBACK_CONCURRENT_CHANGE');
          // Guard each memory/storage copy independently; an interrupted install
          // can leave one old and one new. Never overwrite a third/concurrent value.
          io.rollbackLocal(model.json, nextModel.json);
          await commit(after, { baseline: s.baseline, state: s.state, journal: null }, model);
        } catch (_) { halted = true; throw failure('LOCAL_PULL_RECOVERY_REQUIRED'); }
        throw error;
      }
    }

    async function pull(s, items, model, generation, runEpoch) {
      if (items.some(i => i.kind === 'transaction-pull')) {
        if (items.length !== 1) throw failure('PULL_REQUIRES_REVIEW');
        return financialPull(s, items[0], model, generation, runEpoch);
      }
      if (!io.pullModel || !io.installLocal || items.some(i => i.local?.entity !== 'notes' || !i.base || !i.cloud?.lifecycle))
        throw failure('PULL_REQUIRES_REVIEW');
      await current(s.settings.owner, generation, runEpoch);
      const nextModel = io.pullModel(model, items);
      const records = s.baseline.records.map(b => {
        const item = items.find(i => i.key === key(b));
        return item ? { ...b, contentFingerprint: item.cloudHash,
          cloud_updated_at: item.cloud.row.updated_at || null } : b;
      });
      const journal = { kind: 'local-pull', owner: s.settings.owner, beforeJson: model.json,
        nextJson: nextModel.json, items, created_at: io.now() };
      // The rollback copy, local IDB state and exact baseline advance are one
      // transaction. A crash before updating localStorage leaves this journal.
      await commit(s, { journal, state: { json: nextModel.json, mt: nextModel.mt },
        baseline: { ...s.baseline, records, revision: (s.baseline.revision || 0) + 1, aggregateFingerprintStale: true },
        receipt: { id: io.uuid(), owner: s.settings.owner, kind: 'pull-backup', beforeJson: model.json,
          baseline: s.baseline, items, verified_at: io.now() } }, model);
      io.installLocal(nextModel.json, model.json);
      const after = await snapshot();
      if (!same(after.journal, journal) || after.state?.json !== nextModel.json) throw failure('LOCAL_PULL_RECOVERY_REQUIRED');
      await commit(after, { journal: null }, nextModel);
    }

    async function cycle() {
      if (busy || stopped || halted) return;
      busy = true;
      let activeOwner = null, runEpoch = epoch;
      try {
        await io.lock(async () => {
          let s = await snapshot();
          if (stopped || !s.settings?.enabled) { publish({ enabled: false, phase: 'off' }); return; }
          activeOwner = s.settings.owner;
          publish({ enabled: true, phase: 'capturing', reason: null });
          if (io.localOwner() !== activeOwner) throw failure('ACCOUNT_CHANGED');
          checkBaseline(s, activeOwner, true);
          if (s.journal?.kind === 'local-pull') throw failure('LOCAL_PULL_RECOVERY_REQUIRED');
          const model = io.model(activeOwner, s.baseline);
          s = await capture(s, model);
          publish({ pending: s.outbox.length });
          if (s.conflicts.length) throw failure('CONFLICT_REVIEW_REQUIRED');
          if (!io.online()) { publish({ phase: 'offline' }); return; }
          const generation = io.sessionGeneration();
          const user = await io.authenticate();
          if (user?.id !== activeOwner) throw failure('ACCOUNT_CHANGED');
          if (!ready(await io.readiness())) throw failure('SERVER_NOT_READY');
          await current(activeOwner, generation, runEpoch);
          if (s.settings.retryAt && Date.parse(s.settings.retryAt) > Date.parse(io.now())) {
            publish({ phase: 'retry-wait' }); return;
          }
          if (s.journal) {
            if (s.journal.owner !== activeOwner) throw failure('JOURNAL_OWNERSHIP_INVALID');
            if (s.journal.kind === 'local-pull') throw failure('LOCAL_PULL_RECOVERY_REQUIRED');
            await send(s, copy(s.journal.group), model, generation, runEpoch);
            publish({ phase: 'idle', reason: null }); return;
          }
          const remote = await io.remote(activeOwner);
          const p = await plan(s, model, remote, io.hash);
          if (p.conflicts.length) {
            await commit(s, { putConflicts: p.conflicts.map(item => ({ id: io.uuid(), source: SOURCE,
              owner: activeOwner, key: item.key, baseline: item.base, local: item.local, cloud: item.cloud,
              created_at: io.now(), status: 'unresolved' })) }, model);
            publish({ conflicts: p.conflicts.length }); throw failure('CONFLICT_REVIEW_REQUIRED');
          }
          if (p.blocked.length) throw failure('PRESENCE_CHANGE_REQUIRES_REVIEW');
          const work = await groups(s, p); // Validate the entire batch before any writes.
          // Generic financial pulls are deliberately not guessed or partially applied.
          // Allow notes pulls and transaction-pull groups (cloud transaction-create + account delta)
          if (p.pulls.some(i => i.local?.entity !== 'notes' && i.kind !== 'transaction-pull')) throw failure('PULL_REQUIRES_REVIEW');
          if (p.pulls.length) {
            await pull(s, p.pulls, model, generation, runEpoch);
            publish({ phase: 'idle' }); return;
          }
          if (work.length) {
            await send(s, work[0], model, generation, runEpoch);
            publish({ phase: 'idle' }); return;
          }
          if (p.converged.length) {
            await current(activeOwner, generation, runEpoch);
            await acknowledge(s, p.converged, entriesFor(s, p.converged), model);
          }
          publish({ phase: 'idle', pending: (await snapshot()).outbox.length, reason: null });
        });
      } catch (error) {
        const known = error?.code || 'RECOVERABLE_FAILURE';
        publish({ phase: known === 'RUN_CANCELLED' ? (stopped ? 'off' : 'paused') : 'paused', reason: known });
        // Never store raw backend errors (which may contain private values).
        if (activeOwner && known === 'RECOVERABLE_FAILURE') {
          try {
            const s = await snapshot();
            if (s.settings?.owner === activeOwner && s.settings.enabled) {
              const retries = Math.min((s.settings.retries || 0) + 1, 10);
              await commit(s, { settings: { ...s.settings, retries,
                retryAt: new Date(Date.parse(io.now()) + Math.min(300000, 2000 * 2 ** retries) + io.jitter()).toISOString() } });
            }
          } catch (_) { /* Keep the queue and journal on a persistence failure. */ }
        }
      } finally { busy = false; }
    }

    async function setEnabled(enabled) {
      if (!enabled) { stopped = true; ++epoch; publish({ enabled: false, phase: 'off', reason: null }); }
      await io.lock(async () => {
        const s = await snapshot();
        if (enabled) {
          const user = await io.authenticate();
          if (!user?.id || io.localOwner() !== user.id) throw failure('ACCOUNT_CHANGED');
          checkBaseline(s, user.id);
          if (!ready(await io.readiness())) throw failure('SERVER_NOT_READY');
          if (s.settings?.owner && s.settings.owner !== user.id || s.journal?.kind === 'local-pull') throw failure('RECOVERY_REQUIRED');
          // First enable requires equality. A previously enabled same-owner
          // device can resume its immutable queue/journal without clearing it.
          const returning = s.settings?.version === 1 && s.settings.owner === user.id;
          const model = io.model(user.id, s.baseline), remote = await io.remote(user.id);
          const p = await plan(s, model, remote, io.hash);
          if (!returning && (s.outbox.length || s.journal || Object.values(p).some(a => a.length)) ||
              returning && (p.conflicts.length || p.blocked.length)) throw failure('ENABLE_PREFLIGHT_NOT_CLEAN');
          await commit(s, { settings: { ...(s.settings || {}), version: 1, owner: user.id,
            enabled: true, sequence: s.settings?.sequence || 0 } }, model);
          stopped = false; halted = false; ++epoch;
          publish({ enabled: true, phase: 'idle', reason: null });
        } else {
          // OFF must also work while signed out or offline; it only changes settings.
          await io.commit(s, { settings: { ...(s.settings || {}), version: 1, enabled: false } }, () => true);
        }
      });
    }
    async function boot() {
      const s = await snapshot();
      publish({ enabled: s.settings?.enabled === true, phase: s.settings?.enabled ? 'waiting' : 'off',
        pending: s.outbox?.length || 0, conflicts: s.conflicts?.length || 0 });
      return status();
    }
    function pause(reason) { halted = true; ++epoch; publish({ phase: 'paused', reason }); }
    return { status, boot, cycle, setEnabled, pause, authChanged: () => {
      if (view.enabled) { ++epoch; publish({ phase: 'paused', reason: 'AUTHENTICATION_CHANGED' }); }
    } };
  }

  // Production transport. These versioned server endpoints are deployment gates,
  // NOT fallbacks to the old raw table/test-only execution paths.
  function browserIO() {
    const modelState = (json, owner, baseline) => {
      const state = JSON.parse(json), report = migrationPrepare(state);
      if (report.blockingProblems.length) throw failure('LOCAL_MAPPING_INVALID');
      const p = buildSupabaseMigrationPlan(report, owner, state);
      const records = [...p.tables.flatMap(([entity, rows]) => rows.map(row => ({ entity, row }))),
        { entity: 'profiles', row: p.profile }, { entity: 'user_preferences', row: p.preferences }];
      records.forEach(r => { r.localId = baseline.records.find(b => key(b) === key(r))?.localId ?? r.row.legacy_id ?? r.row.id ?? owner; });
      return { json, mt: state._mt || 0, records };
    };
    const model = (owner, baseline) => modelState(JSON.stringify(S), owner, baseline);
    const rpc = (name, body = {}) => CapSupabase.syncRequest('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(body) });
    return {
      snapshot: () => CapOff.productionSyncSnapshot(), commit: (...args) => CapOff.productionSyncCommit(...args),
      localJson: () => JSON.stringify(S), localOwner: () => CapSupabase.localIdentity(),
      localPersisted: json => localStorage.getItem('pera') === json,
      sessionGeneration: () => CapSupabase.sessionGeneration(), model, modelState,
      hash: (entity, row) => CapSync.fingerprintRow(entity, row),
      uuid: () => crypto.randomUUID(), now: () => new Date().toISOString(), jitter: () => Math.floor(Math.random() * 1000),
      online: () => navigator.onLine !== false, authenticate: () => CapSupabase.currentUser(),
      readiness: () => rpc('cap_verify_production_sync_v1'),
      remote: async owner => validateSnapshot(await rpc('cap_sync_snapshot_v1'), owner),
      write: group => {
        if (group.kind === 'transaction-create') {
          // The production promotion must retain the verified atomic INSERT +
          // account delta algorithm and add expected-account CAS + receipts.
          const tx = group.items[0].local.row, account = group.items[1].cloud.row;
          return rpc('cap_sync_transaction_create', { p_operation_id: group.operationId,
            p_transaction: tx, p_expected_account: account });
        }
        if (group.kind === 'note-update') {
          const item = group.items[0], c = item.cloud;
          return rpc('cap_notes_change', { p_id: item.local.row.id, p_operation_id: group.operationId,
            p_action: 'edit', p_expected: { content: Object.fromEntries(['legacy_id','title','body','note_date'].map(k => [k,c.row[k]])),
              lifecycle: c.lifecycle }, p_desired: Object.fromEntries(['legacy_id','title','body','note_date'].map(k => [k,item.local.row[k]])) });
        }
        throw failure('UNSUPPORTED_WRITE');
      },
      pullModel: (model, items) => {
        if (document.activeElement?.matches('input,textarea,[contenteditable="true"]')) throw failure('PULL_DEFERRED_WHILE_EDITING');
        const state = JSON.parse(model.json);
        for (const item of items) {
          if (item.kind === 'transaction-pull') {
            const tx = item.items[0], acct = item.items[1];
            const mapper = cloudMapper(), remote = item.remote;
            const raw = { version: SNAPSHOT_VERSION, complete: true, owner: tx.cloud.row.user_id,
              record_count: remote.length, counts: Object.fromEntries(entities.map(e => [e, remote.filter(r => r.entity === e).length])), records: remote };
            const restored = mapper.hydrate(raw, raw.owner);
            const id = Number(tx.cloud.row.legacy_id), accountId = Number(acct.base.localId);
            const incoming = restored.tx.filter(t => t.id === id);
            const accounts = state.accts.filter(a => a.id === accountId);
            if (tx.base || tx.local || incoming.length !== 1 || accounts.length !== 1 ||
                [...state.tx, ...(state.pend || [])].some(t => t.id === id)) throw failure('PULL_MAPPING_INVALID');
            state.tx.push(incoming[0]);
            // Install the authoritative balance, never call transaction business logic.
            accounts[0].bal = acct.cloud.row.balance;
          } else {
            // Handle notes pull (existing logic)
            if (!Array.isArray(state.notes)) throw failure('PULL_MAPPING_INVALID');
            const notes = state.notes.filter(n => String(n.id) === String(item.base.localId));
            const row = item.cloud.row;
            if (notes.length !== 1 || row.legacy_id !== String(item.base.localId) ||
                typeof row.title !== 'string' || typeof row.body !== 'string') throw failure('PULL_MAPPING_INVALID');
            Object.assign(notes[0], { t: row.title, b: row.body, d: row.note_date || '' });
          }
        }
        return { json: JSON.stringify(state), mt: state._mt || 0 };
      },
      rollbackLocal: (before, next) => {
        if (![before,next].includes(JSON.stringify(S)) || ![before,next].includes(localStorage.getItem('pera')))
          throw failure('ROLLBACK_CONCURRENT_CHANGE');
        localStorage.setItem('pera', before); S = JSON.parse(before);
        CapOff.resetProductionTracking();
      },
      installLocal: (json, expected) => {
        if (JSON.stringify(S) !== expected || localStorage.getItem('pera') !== expected) throw failure('LOCAL_PULL_RECOVERY_REQUIRED');
        localStorage.setItem('pera', json);
        S = JSON.parse(json);
        CapOff.resetProductionTracking();
        window.CAP_PRODUCTION_RENDER_ONLY = true;
        try { if (typeof render === 'function') render(); }
        finally { window.CAP_PRODUCTION_RENDER_ONLY = false; }
        if (JSON.stringify(S) !== json || localStorage.getItem('pera') !== json) throw failure('LOCAL_PULL_RECOVERY_REQUIRED');
      },
      lock: fn => {
        if (!navigator.locks?.request) throw failure('CROSS_TAB_LOCK_UNAVAILABLE');
        return navigator.locks.request('cap-controlled-notes-test', { mode: 'exclusive' }, fn);
      },
      changed: () => paint()
    };
  }

  let engine, timer = null, booted = false, offSaveFailed = false, toggleBusy = false, toggleNotice = '';
  const activationReasons = {
    SERVER_NOT_READY: 'Production Phase 6L server readiness has not passed. Cloud Sync remains OFF.',
    ACCOUNT_CHANGED: 'The signed-in account does not match this device’s sync owner.',
    BASELINE_INVALID: 'The existing baseline could not be verified. It was not recreated or reset.',
    RECOVERY_REQUIRED: 'An unfinished recovery operation needs review before sync can start.',
    CONFLICT_REVIEW_REQUIRED: 'Unresolved conflicts require explicit review before sync can start.',
    OTHER_OUTBOX_REQUIRES_REVIEW: 'Existing pending operations require review. The outbox was preserved.',
    ENABLE_PREFLIGHT_NOT_CLEAN: 'Local, baseline and cloud state did not pass the activation comparison.',
    CROSS_TAB_LOCK_UNAVAILABLE: 'Safe cross-tab coordination is unavailable in this browser.',
    REMOTE_SNAPSHOT_INCOMPLETE: 'A complete owned cloud snapshot could not be verified.',
    SNAPSHOT_INVALID: 'The sync snapshot is incomplete or ambiguous.',
    SNAPSHOT_OWNERSHIP_INVALID: 'Ownership of the sync snapshot could not be verified.',
    SNAPSHOT_SIDECAR_INCOMPLETE: 'The production notes lifecycle sidecar is incomplete; snapshot reads were rejected.',
    SNAPSHOT_TOO_LARGE: 'The owned cloud snapshot exceeded the safe production size limit. Nothing was applied.',
    SNAPSHOT_CONTRACT_NOT_VERIFIED: 'The production snapshot contract could not be verified on the server.',
    SNAPSHOT_FAILED: 'The production snapshot could not be read safely. Nothing was applied.',
    READINESS_CONTRACT_NOT_VERIFIED: 'The production readiness contract could not be verified on the server.',
    READINESS_FAILED: 'Production readiness could not be verified. Nothing was enabled.',
    NOTE_LIFECYCLE_REQUIRES_REVIEW: 'The production notes lifecycle contract requires review.',
    LOCAL_MAPPING_INVALID: 'Local record mappings need review before automatic sync can start.'
  };
  function activationReason(error) {
    if (activationReasons[error?.code]) return activationReasons[error.code];
    if (typeof error?.message === 'string') {
      const code = Object.keys(activationReasons).find(k => error.message.includes(k));
      if (code) return activationReasons[code];
    }
    if (navigator.onLine === false) return 'Reconnect to verify authentication and production readiness. Local data stays on this device.';
    if (error?.status === 401 || error?.status === 403) return 'Supabase authentication or permissions could not be verified.';
    if (error?.status === 404 || error?.code === 'PGRST202') return 'The required Phase 6L production RPC is not available.';
    if (error?.status === 429) return 'Supabase is rate-limiting requests. Try again later.';
    if (error?.status >= 500) return 'Supabase is temporarily unavailable. Pending operations were preserved.';
    if (!CapSupabase.status().authenticated) return 'Online Supabase authentication could not be verified. Sign in and try again.';
    return 'Activation or local persistence could not be verified. No baseline or pending operations were cleared.';
  }
  function request() {
    if (!engine || !booted || !engine.status().enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => { engine.cycle().catch(() => {}); }, 600);
  }
  function statusText(s) {
    return toggleBusy ? 'Checking the requested Cloud Sync setting…' : toggleNotice ||
      'Cloud Sync: ' + (s.enabled ? 'ON' : 'OFF') + ' · ' + s.phase +
      ' · queued ' + s.pending + ' · conflicts ' + s.conflicts + (s.reason ? ' · ' + s.reason : '');
  }
  function paint() {
    const output = document.getElementById('production-sync-status'), button = document.getElementById('production-sync-toggle');
    if (!engine) return;
    const s = engine.status();
    if (button) {
      button.checked = s.enabled;
      button.setAttribute('aria-checked', String(s.enabled));
      button.disabled = toggleBusy || !booted;
      button.setAttribute('aria-busy', String(toggleBusy));
      button.setAttribute('aria-label', offSaveFailed ? 'Retry saving Cloud Sync OFF' : 'Cloud Sync');
    }
    const label = document.getElementById('production-sync-label');
    if (label) label.textContent = 'Cloud Sync: ' + (s.enabled ? 'ON' : 'OFF');
    if (output) output.textContent = statusText(s);
  }
  function settingsHtml() {
    const s = engine?.status() || { enabled: false, phase: 'off', pending: 0, conflicts: 0 };
    const message = statusText(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<div class="st-r"><span class="f"><b id="production-sync-label">Cloud Sync: ' + (s.enabled ? 'ON' : 'OFF') +
      '</b><small>Local-first. Conflicts pause automatic writes. Unsupported changes stay queued.</small></span>' +
      '<label class="cap-cloud-switch"><input type="checkbox" class="toggle-input" id="production-sync-toggle" role="switch" aria-label="Cloud Sync" aria-describedby="production-sync-status" aria-checked="' + s.enabled +
      '"' + (s.enabled ? ' checked' : '') + (toggleBusy || !booted ? ' disabled' : '') + ' onchange="CapProductionSync.toggle(this.checked)">' +
      '<span class="cloud-toggle-minimal" aria-hidden="true"><span class="cloud-toggle-knob">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M6.5 18h11a4.5 4.5 0 0 0 .6-8.96A6.25 6.25 0 0 0 6.2 7.5 5.25 5.25 0 0 0 6.5 18Z"/></svg>' +
      '</span></span></label></div>' +
      '<div class="st-note" role="status" aria-live="polite" aria-atomic="true" id="production-sync-status">' + message + '</div>';
  }
  const api = { createEngine, plan, ready, validateSnapshot, browserIO, settingsHtml, request, status: () => engine?.status() || { enabled: false },
    pause: reason => engine?.pause(reason), authChanged: () => engine?.authChanged(),
    toggle: async requested => {
      if (toggleBusy || !booted) { paint(); return; }
      const enabled = offSaveFailed ? false : typeof requested === 'boolean' ? requested : !engine.status().enabled;
      // Native checkbox changes are proposals, not proof of engine activation.
      paint();
      if (enabled && !window.confirm('Enable automatic Cloud Sync on this device?\n\nA fresh production-server and baseline preflight must pass first. Unsupported operations and conflicts pause sync without overwriting data.')) { paint(); return; }
      toggleBusy = true; toggleNotice = ''; paint();
      try { await engine.setEnabled(enabled); offSaveFailed = false; request(); }
      catch (error) {
        if (!enabled) offSaveFailed = true;
        toggleNotice = enabled ? 'Cloud Sync: OFF — ' + activationReason(error) :
          'STOPPED IN THIS TAB — OFF preference could not be saved. Keep this tab open and retry saving OFF before reloading.';
      }
      finally { toggleBusy = false; paint(); }
    }
  };
  window.CapProductionSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createEngine, plan, ready, validateSnapshot };
  if (!window.CapOff || !window.CapSupabase || !document.addEventListener) return;
  engine = createEngine(browserIO());
  // Boot reads settings only when OFF. No setting, queue, baseline or record is
  // created by loading this module into the existing synchronized browser.
  document.addEventListener('DOMContentLoaded', async () => {
    try { await engine.boot(); booted = true; paint(); request(); } catch (_) { engine.pause('STORAGE_UNAVAILABLE'); }
  }, { once: true });
  addEventListener('online', request);
  addEventListener('pageshow', request);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) request(); });
  navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'cap-sync') request(); });
  setInterval(() => { if (!document.hidden) request(); }, 15000);
})();
