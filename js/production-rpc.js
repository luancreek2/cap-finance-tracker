/* Phase 6L: the shipped client's only cloud data surface.
   Production RPC-only. No direct table endpoints, no legacy or test RPCs.
   Every call here is one of the reviewed production contracts:
      cap_verify_production_sync_v1 / cap_sync_snapshot_v1 /
      cap_sync_transaction_create / cap_sync_transaction_update /
      cap_sync_transaction_delete / cap_notes_change / cap_notes_read /
      cap_verify_notes_lifecycle
   Local-first behaviour is unchanged: this module never touches local
   storage, the baseline or the outbox. */
(function () {
  'use strict';
  const RPC = {
    readiness: 'cap_verify_production_sync_v1',
    snapshot: 'cap_sync_snapshot_v1',
    transactionCreate: 'cap_sync_transaction_create',
    transactionUpdate: 'cap_sync_transaction_update',
    transactionDelete: 'cap_sync_transaction_delete',
    transactionCapability: 'cap_verify_transaction_update_delete_v1',
    notesChange: 'cap_notes_change',
    notesRead: 'cap_notes_read',
    notesVerify: 'cap_verify_notes_lifecycle'
  };
  const ALLOWED = Object.keys(RPC).map(k => RPC[k]);
  const ENTITIES = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals',
    'debts', 'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments',
    'budgets', 'notes'];
  const READINESS_CHECKS = ['snapshot_contract', 'snapshot_read_access', 'readiness_contract',
    'transaction_create_contract', 'durable_receipts', 'notes_receipts', 'notes_sidecar',
    'rpc_only_reads', 'legacy_lockout', 'writer_privileges', 'service_role_private'];
  const CONTRACTS = {
    readiness: 'CAP_PRODUCTION_SYNC_READINESS_V1',
    snapshot: 'CAP_SYNC_SNAPSHOT_V1',
    transaction_create: 'CAP_TX_CREATE_CAS_RECEIPT_V1',
    notes_change: 'CAP_NOTES_SIDECAR_V1'
  };
  const CONTENT = ['legacy_id', 'title', 'body', 'note_date'];
  const failure = code => Object.assign(Error(code), { code });
  const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const uuid = v => typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

  function transport() {
    const api = window.CapSupabase;
    if (!api || typeof api.syncRequest !== 'function') throw failure('CLOUD_TRANSPORT_UNAVAILABLE');
    return api.syncRequest;
  }
  // Single entry point for every production RPC. Anything that is not a
  // reviewed production contract is refused before a request is made.
  async function call(name, body) {
    if (!ALLOWED.includes(name)) throw failure('UNSUPPORTED_PRODUCTION_RPC');
    const raw = await transport()('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(body || {}) });
    return Array.isArray(raw) ? (raw.length === 1 ? raw[0] : null) : raw;
  }
  function contentOf(row) {
    if (!isObject(row)) throw failure('NOTE_CONTENT_INVALID');
    const out = {};
    for (const k of CONTENT) {
      if (!Object.prototype.hasOwnProperty.call(row, k)) throw failure('NOTE_CONTENT_INVALID');
      const v = row[k];
      if (k === 'legacy_id') { if (typeof v !== 'string' || !v.trim()) throw failure('NOTE_CONTENT_INVALID'); }
      else if (v !== null && typeof v !== 'string') throw failure('NOTE_CONTENT_INVALID');
      out[k] = v;
    }
    if (out.note_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(out.note_date))) throw failure('NOTE_CONTENT_INVALID');
    return out;
  }
  function lifecycleOf(value) {
    if (!isObject(value) || value.version !== 1) throw failure('NOTE_LIFECYCLE_INVALID');
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw failure('NOTE_LIFECYCLE_INVALID');
    if (value.deleted_at !== null && typeof value.deleted_at !== 'string') throw failure('NOTE_LIFECYCLE_INVALID');
    if (value.operation_id !== null && !uuid(value.operation_id)) throw failure('NOTE_LIFECYCLE_INVALID');
    return { version: 1, revision: value.revision, deleted_at: value.deleted_at, operation_id: value.operation_id };
  }
  // Exact server-derived readiness. A top-level boolean alone is never enough.
  function ready(v) {
    if (!(isObject(v) && v.version === 'CAP_PRODUCTION_SYNC_V1' && v.ready === true &&
        v.legacy_lockout === true && v.private_sidecar === true && v.rpc_only_reads === true &&
        v.writer_bypassrls === false && v.atomic_transaction_create === true &&
        v.durable_operation_receipts === true)) return false;
    if (!isObject(v.checks) || Object.keys(v.checks).length !== READINESS_CHECKS.length) return false;
    if (READINESS_CHECKS.some(k => v.checks[k] !== true)) return false;
    if (!isObject(v.contracts) || Object.keys(v.contracts).length !== Object.keys(CONTRACTS).length) return false;
    if (Object.keys(CONTRACTS).some(k => v.contracts[k] !== CONTRACTS[k])) return false;
    return true;
  }
  async function readiness() {
    try { const raw = await call(RPC.readiness); return { ok: ready(raw), raw, reason: ready(raw) ? null : 'CONTRACT_NOT_VERIFIED' }; }
    catch (e) { return { ok: false, raw: null, reason: String(e?.message || e) }; }
  }
  async function notesContract() {
    try {
      const raw = await call(RPC.notesVerify);
      // Every server-derived flag must pass explicitly. The notes verifier
      // never claims global or production readiness on its own.
      const ok = !!(isObject(raw) && raw.version === 'CAP_NOTES_SIDECAR_V1' &&
        raw.contract_ready === true && raw.roles_ok === true && raw.tables_ok === true &&
        raw.rls_ok === true && raw.policies_ok === true && raw.grants_ok === true &&
        raw.functions_ok === true && raw.legacy_lockout_ok === true && raw.coverage_ok === true &&
        raw.ready === false && raw.production_ready === false);
      return { ok, raw, reason: ok ? null : 'NOTES_CONTRACT_NOT_VERIFIED' };
    } catch (e) { return { ok: false, raw: null, reason: String(e?.message || e) }; }
  }
  // One owner-scoped, complete snapshot. Every synchronized entity, including
  // empty collections, is returned. Nothing is filtered client-side.
  async function snapshot(owner) {
    const raw = await call(RPC.snapshot);
    if (!isObject(raw) || raw.version !== 'CAP_SYNC_SNAPSHOT_V1' || raw.complete !== true) throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
    if (owner && raw.owner !== owner) throw failure('REMOTE_SNAPSHOT_OWNER_MISMATCH');
    if (!Array.isArray(raw.records) || !Number.isSafeInteger(raw.record_count) || raw.record_count !== raw.records.length) throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
    if (!isObject(raw.counts) || Object.keys(raw.counts).length !== ENTITIES.length) throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
    if (ENTITIES.some(e => !Number.isSafeInteger(raw.counts[e]) || raw.counts[e] < 0)) throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
    if (ENTITIES.reduce((n, e) => n + raw.counts[e], 0) !== raw.record_count) throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
    return raw;
  }
  // Snapshot rows indexed for one owner, so callers never need a table read.
  async function snapshotRows(owner) {
    const raw = await snapshot(owner);
    const rows = {};
    for (const e of ENTITIES) rows[e] = [];
    for (const record of raw.records) {
      if (!isObject(record) || !ENTITIES.includes(record.entity) || !isObject(record.row)) throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
      rows[record.entity].push(record);
    }
    return { snapshot: raw, rows };
  }
  function noteRecord(record, owner) {
    const row = record.row;
    const content = contentOf(row);
    const lifecycle = lifecycleOf(record.lifecycle);
    const id = String(row.id);
    return {
      row: { id, user_id: owner || row.user_id, legacy_id: content.legacy_id, title: content.title, body: content.body, note_date: content.note_date },
      lifecycle
    };
  }
  // One note plus its lifecycle envelope, read through the production contract.
  async function readNote(id, owner) {
    if (!uuid(id)) throw failure('NOTE_ID_INVALID');
    const raw = await call(RPC.notesRead, { p_id: id });
    if (!isObject(raw)) throw failure('NOTE_NOT_FOUND');
    const content = contentOf(raw.content);
    const lifecycle = lifecycleOf(raw.lifecycle);
    return { row: { id: String(id), user_id: owner || null, legacy_id: content.legacy_id, title: content.title, body: content.body, note_date: content.note_date }, lifecycle };
  }
  // One note record from the owner snapshot. Absence is null, never an error,
  // and the lifecycle envelope travels next to the row instead of inside it.
  async function readNoteRecord(owner, selector) {
    const id = selector?.id ? String(selector.id) : null;
    const localId = selector?.localId === undefined || selector?.localId === null ? null : String(selector.localId);
    if (!id && localId === null) throw failure('NOTE_SELECTOR_INVALID');
    const { rows } = await snapshotRows(owner);
    const records = rows.notes || [];
    const found = records.filter(r => id ? String(r.row?.id) === id : String(r.row?.legacy_id) === localId);
    if (found.length > 1) throw failure('REMOTE_SNAPSHOT_INCOMPLETE');
    if (!found.length) return null;
    const record = found[0];
    const content = contentOf(record.row);
    return {
      row: {
        id: String(record.row.id), user_id: owner || record.row.user_id,
        legacy_id: content.legacy_id, title: content.title, body: content.body,
        note_date: content.note_date, created_at: record.row.created_at || null,
        updated_at: record.row.updated_at || null
      },
      lifecycle: lifecycleOf(record.lifecycle)
    };
  }
  // The only note write path. `expected` is the full content + lifecycle
  // envelope for edit/tombstone and SQL NULL for create.
  async function changeNote(options) {
    const id = options?.id, action = options?.action, desired = options?.desired;
    if (!uuid(id)) throw failure('NOTE_ID_INVALID');
    if (!['create', 'edit', 'tombstone'].includes(action)) throw failure('NOTE_ACTION_UNSUPPORTED');
    if (!uuid(options?.operationId)) throw failure('OPERATION_ID_REQUIRED');
    const body = { p_id: id, p_action: action, p_operation_id: options.operationId };
    if (action === 'create') body.p_expected = null;
    else body.p_expected = { content: contentOf(options?.expected?.content), lifecycle: lifecycleOf(options?.expected?.lifecycle) };
    if (action === 'tombstone') body.p_desired = null;
    else body.p_desired = contentOf(desired);
    const raw = await call(RPC.notesChange, body);
    if (!isObject(raw) || !['APPLIED', 'ALREADY_APPLIED', 'CONFLICT'].includes(raw.status)) throw failure('NOTE_WRITE_UNVERIFIED');
    return raw;
  }
  // The only financial write path: one new posted transaction plus its exact
  // dependent account delta, guarded by an expected-account CAS.
  async function createTransaction(options) {
    if (!uuid(options?.operationId)) throw failure('OPERATION_ID_REQUIRED');
    if (!isObject(options?.transaction)) throw failure('TRANSACTION_PAYLOAD_INVALID');
    if (!isObject(options?.expectedAccount)) throw failure('EXPECTED_ACCOUNT_INVALID');
    const raw = await call(RPC.transactionCreate, {
      p_operation_id: options.operationId,
      p_transaction: options.transaction,
      p_expected_account: options.expectedAccount
    });
    if (!isObject(raw) || !['APPLIED', 'ALREADY_APPLIED', 'CONFLICT'].includes(raw.status)) throw failure('TRANSACTION_WRITE_UNVERIFIED');
    return raw;
  }
  async function updateTransaction(options) {
    if (!uuid(options?.operationId)) throw failure('OPERATION_ID_REQUIRED');
    if (!uuid(options?.id)) throw failure('TRANSACTION_ID_REQUIRED');
    if (!isObject(options?.transaction)) throw failure('TRANSACTION_PAYLOAD_INVALID');
    if (!isObject(options?.expectedTransaction)) throw failure('EXPECTED_TRANSACTION_REQUIRED');
    if (!Array.isArray(options?.expectedAccounts) || options.expectedAccounts.length > 2 ||
        options.expectedAccounts.some(a => !isObject(a))) throw failure('EXPECTED_ACCOUNT_REQUIRED');
    const raw = await call(RPC.transactionUpdate, {
      p_operation_id: options.operationId,
      p_id: options.id,
      p_transaction: options.transaction,
      p_expected_transaction: options.expectedTransaction,
      p_expected_accounts: options.expectedAccounts
    });
    if (!isObject(raw) || !['APPLIED', 'ALREADY_APPLIED', 'CONFLICT'].includes(raw.status)) throw failure('TRANSACTION_WRITE_UNVERIFIED');
    return raw;
  }
  async function deleteTransaction(options) {
    if (!uuid(options?.operationId)) throw failure('OPERATION_ID_REQUIRED');
    if (!uuid(options?.id)) throw failure('TRANSACTION_ID_REQUIRED');
    if (!isObject(options?.expectedTransaction)) throw failure('EXPECTED_TRANSACTION_REQUIRED');
    if (!Array.isArray(options?.expectedAccounts) || options.expectedAccounts.length > 1 ||
        options.expectedAccounts.some(a => !isObject(a))) throw failure('EXPECTED_ACCOUNT_REQUIRED');
    const raw = await call(RPC.transactionDelete, {
      p_operation_id: options.operationId,
      p_id: options.id,
      p_expected_transaction: options.expectedTransaction,
      p_expected_accounts: options.expectedAccounts
    });
    if (!isObject(raw) || !['APPLIED', 'ALREADY_APPLIED', 'CONFLICT'].includes(raw.status)) throw failure('TRANSACTION_WRITE_UNVERIFIED');
    return raw;
  }
  // Narrow, separate attestation for the update/delete rollout. It never widens
  // the main readiness contract, so Phase 6N stays independently deployable.
  async function transactionCapabilities() {
    try {
      const raw = await call(RPC.transactionCapability);
      const ok = !!(isObject(raw) && raw.version === 'CAP_TX_UPDATE_DELETE_READINESS_V1' && raw.ready === true &&
        raw.update_contract === 'CAP_TX_UPDATE_CAS_RECEIPT_V1' &&
        raw.delete_contract === 'CAP_TX_DELETE_CAS_RECEIPT_V1');
      return { ok, raw, reason: ok ? null : 'TRANSACTION_WRITE_CONTRACT_NOT_READY' };
    } catch (e) { return { ok: false, raw: null, reason: String(e?.message || e) }; }
  }
  // Operations without a production RPC adapter fail closed with a fixed code.
  function unsupported(operation) { return failure('UNSUPPORTED_OPERATION:' + operation); }
  window.CapProductionRpc = {
    RPC, ALLOWED, ENTITIES, READINESS_CHECKS, CONTRACTS, CONTENT,
    call, ready, readiness, notesContract, snapshot, snapshotRows,
    readNote, readNoteRecord, changeNote, createTransaction, updateTransaction, deleteTransaction,
    transactionCapabilities, unsupported, contentOf, lifecycleOf
  };
})();
