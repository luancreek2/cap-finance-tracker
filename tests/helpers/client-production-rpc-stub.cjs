/* Shared stub of the production RPC surface for isolated client tests.
   It mimics js/production-rpc.js: owner-scoped snapshot reads, one note read
   with its lifecycle envelope, and the two reviewed write contracts. No
   direct table endpoint exists in the stub. */
function createStub(config = {}) {
  const owner = config.owner || 'owner';
  const rows = config.rows || {};
  const lifecycleOf = row => (row && row.lifecycle) || { version: 1, revision: 1, deleted_at: null, operation_id: null };
  const wrap = (entity, list) => (list || []).map(row => ({ entity, row, lifecycle: lifecycleOf(row) }));
  const snapshotRows = async (o) => {
    if (config.readFails) throw Error('stub cloud read failed');
    const out = {};
    for (const [entity, list] of Object.entries(rows)) out[entity] = wrap(entity, list);
    if (config.onRead) await config.onRead(null, null, o);
    return {
      snapshot: { version: 'CAP_SYNC_SNAPSHOT_V1', owner: o, complete: true, record_count: 0, counts: {}, records: [] },
      rows: out
    };
  };
  const readNoteRecord = async (o, selector) => {
    if (config.readFails) throw Error('stub cloud read failed');
    const list = rows.notes || [];
    const found = list.filter(r => selector && selector.id
      ? String(r.id) === String(selector.id)
      : String(r.legacy_id) === String(selector && selector.localId));
    if (found.length > 1) throw Error('stub ambiguous note');
    if (config.onRead) await config.onRead('notes', selector, o);
    if (!found.length) return null;
    const row = found[0];
    return {
      row: {
        id: String(row.id), user_id: owner, legacy_id: row.legacy_id, title: row.title,
        body: row.body, note_date: row.note_date === undefined ? null : row.note_date,
        created_at: row.created_at === undefined ? null : row.created_at,
        updated_at: row.updated_at === undefined ? null : row.updated_at
      },
      lifecycle: lifecycleOf(row)
    };
  };
  const changeNote = async options => {
    if (config.onChange) return config.onChange(options);
    return config.changeResult || { status: 'APPLIED' };
  };
  const createTransaction = async options => {
    if (config.onTransaction) return config.onTransaction(options);
    return config.transactionResult || { status: 'APPLIED' };
  };
  return {
    RPC: {
      readiness: 'cap_verify_production_sync_v1', snapshot: 'cap_sync_snapshot_v1',
      transactionCreate: 'cap_sync_transaction_create', notesChange: 'cap_notes_change',
      notesRead: 'cap_notes_read', notesVerify: 'cap_verify_notes_lifecycle'
    },
    ALLOWED: ['cap_verify_production_sync_v1', 'cap_sync_snapshot_v1', 'cap_sync_transaction_create',
      'cap_notes_change', 'cap_notes_read', 'cap_verify_notes_lifecycle'],
    ENTITIES: ['profiles', 'user_preferences', 'categories', 'accounts', 'goals', 'debts', 'bills',
      'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'],
    snapshotRows, readNoteRecord, changeNote, createTransaction,
    snapshot: async o => (await snapshotRows(o)).snapshot,
    readiness: async () => config.readiness || { ok: true, raw: { version: 'CAP_PRODUCTION_SYNC_V1' } },
    notesContract: async () => config.notesContract || { ok: true, raw: { version: 'CAP_NOTES_SIDECAR_V1' } },
    readNote: async () => { throw Error('stub: readNote is not used'); },
    unsupported: operation => Object.assign(Error('UNSUPPORTED_OPERATION:' + operation), { code: 'UNSUPPORTED_OPERATION:' + operation }),
    contentOf: x => x, lifecycleOf: x => x
  };
}
module.exports = { createStub };
