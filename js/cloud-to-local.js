/* Phase 6N/6M: Shared cloud→local conversion and validation.
   Single source of truth for Supabase→Cap financial data mapping.
   Used by: Phase 6M bootstrap (js/cloud-bootstrap.js) and Phase 6N pulls (js/sync-production.js). */
(function () {
  'use strict';

  const ENTITIES = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals',
    'debts', 'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const HEX = /^[0-9a-f]{64}$/i;
  const copy = x => JSON.parse(JSON.stringify(x));
  const fail = text => { throw Error(text); };
  const object = x => x && typeof x === 'object' && !Array.isArray(x);

  function stable(x) {
    if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
    if (object(x)) return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}';
    return JSON.stringify(x);
  }

  function signature(raw) {
    return stable({ owner: raw.owner, counts: raw.counts, records: raw.records.slice().sort((a, b) =>
      (a.entity + ':' + (a.row.id || a.row.user_id)).localeCompare(b.entity + ':' + (b.row.id || b.row.user_id))) });
  }

  function validateSnapshot(raw, owner) {
    if (!UUID.test(owner) || !object(raw) || raw.version !== 'CAP_SYNC_SNAPSHOT_V1' || raw.complete !== true ||
        raw.owner !== owner || !Array.isArray(raw.records) || !Number.isSafeInteger(raw.record_count) ||
        raw.record_count !== raw.records.length || !raw.record_count || !object(raw.counts) ||
        Object.keys(raw.counts).length !== 13) throw Error('Incomplete or wrong-owner cloud snapshot');
    const counts = Object.fromEntries(['profiles', 'user_preferences', 'categories', 'accounts', 'goals',
      'debts', 'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes']
      .map(e => [e, 0]));
    const seen = new Set();
    for (const r of raw.records) {
      if (!Object.hasOwn(counts, r.entity) || !object(r.row)) throw Error('Unknown snapshot entity');
      const row = r.row, id = row.id || (r.entity === 'user_preferences' && row.user_id);
      if (!UUID.test(id) || (r.entity === 'profiles' ? row.id : row.user_id) !== owner || seen.has(r.entity + ':' + id)) throw Error('Snapshot ownership/identity invalid');
      seen.add(r.entity + ':' + id); counts[r.entity]++;
      if (r.entity === 'notes') {
        const l = r.lifecycle;
        if (!l || l.version !== 1 || !Number.isSafeInteger(l.revision) || l.revision < 1 || l.deleted_at !== null ||
            !(l.operation_id === null || UUID.test(l.operation_id))) throw Error('Unsafe Notes lifecycle');
      }
    }
    for (const e of ['profiles', 'user_preferences', 'categories', 'accounts', 'goals',
      'debts', 'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes']) {
      if (!Number.isSafeInteger(raw.counts[e]) || raw.counts[e] !== counts[e]) throw Error('Cloud record counts invalid');
    }
    if (counts.profiles !== 1 || counts.user_preferences !== 1 || !counts.accounts) throw Error('Cloud dataset is not provisionable');
    return raw;
  }

  function assertFresh(state, defaults) {
    const emptyLists = ['accts', 'tx', 'pend', 'xfer', 'bills', 'goals', 'debts'];
    for (const k of emptyLists) if (state[k] !== undefined && (!Array.isArray(state[k]) || state[k].length)) throw Error('Existing local data: ' + k);
    if (state.notes && !(Array.isArray(state.notes) && !state.notes.length)) throw Error('Existing local Notes');
    if (state.budgets && (!object(state.budgets) || Object.keys(state.budgets).length)) throw Error('Existing local budgets');
    if (state.cats !== undefined && !Array.isArray(state.cats)) throw Error('Invalid local categories');
    if (new Set((state.cats || []).map(c => c.n)).size !== (state.cats || []).length) throw Error('Duplicate local categories');
    for (const c of state.cats || []) if (!(defaults || []).some(d => stable(c) === stable(d))) throw Error('Customized local categories');
    const allowed = new Set(['accts', 'tx', 'pend', 'xfer', 'bills', 'goals', 'debts', 'notes', 'budgets', 'cats', '_mt']);
    const settings = { cur: 'PHP', name: '', photo: null, nf: 'us', neg: 'sign', dec: 0, theme: 'auto', anim: 1, rm: 0, snd: 1, hap: 1,
      hide: 0, logoChoice: 'default', accountView: 'all', accountSort: 'manual', accountOrder: [] };
    for (const [k, v] of Object.entries(state)) {
      if (allowed.has(k)) continue;
      if (!Object.hasOwn(settings, k) || stable(v) !== stable(settings[k])) throw Error('Existing local user customization: ' + k);
    }
  }

  function migrationStableUuid(value) {
    let h = 2166136261;
    for (let i = 0; i < String(value).length; i++) { h ^= String(value).charCodeAt(i); h = Math.imul(h, 16777619); }
    const w = n => (Math.imul(h ^ n, 2246822519) >>> 0).toString(16).padStart(8, '0');
    const hex = Array.from({ length: 8 }, (_, i) => w(i)).join('');
    const variant = (8 + (parseInt(hex[16], 16) % 4)).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  function hydrate(raw, owner) {
    validateSnapshot(raw, owner);
    const rows = e => raw.records.filter(r => r.entity === e).map(r => r.row);
    const localId = r => {
      const s = String(r.legacy_id ?? ''); const n = Number(s);
      if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < 1 || String(n) !== s) throw Error('Unsupported legacy ID: ' + s);
      return n;
    };
    const maps = {};
    for (const e of ['accounts', 'transactions', 'bills', 'goals', 'debts', 'transfers', 'notes'])
      maps[e] = new Map(rows(e).map(r => [r.id, localId(r)]));
    const localRef = (e, id) => id == null ? null : (maps[e]?.has(id) ? maps[e].get(id) : fail('Unmapped relationship: ' + e));
    const categories = new Map(rows('categories').map(c => [c.id, c.name]));
    const category = id => id == null ? '' : (categories.has(id) ? categories.get(id) : fail('Unknown category'));
    const s = { accts: [], tx: [], pend: [], xfer: [], bills: [], goals: [], debts: [], cats: [], budgets: {}, notes: [] };
    for (const r of rows('categories')) {
      if (!r.name || ['__proto__', 'constructor', 'prototype'].includes(r.name)) throw Error('Unsafe category name');
      s.cats.push({ id: r.legacy_id, n: r.name, i: r.emoji, l: r.logo_url, a: r.archived ? 1 : 0 });
    }
    for (const r of rows('accounts')) {
      const a = { id: localId(r), bank: r.bank, name: r.name, type: r.account_type, net: r.network, l4: r.last_four, bal: r.balance,
        lim: r.credit_limit, cardStatus: r.status, img: r.card_art, photo: r.photo_url, nickname: r.nickname,
        stmt: r.statement_day, due: r.due_day, dueN: r.due_days, minimumPayment: copy(r.minimum_payment || {}),
        fees: copy(r.fee_settings || {}), statementHistory: copy(r.statement_settings?.statementHistory || []),
        g: ['#334155', '#64748b'] };
      const interestKeys = ['interestEnabled', 'interestRate', 'interestCalc', 'interestCreditFreq', 'interestOtherDays',
        'interestSimulation', 'goalInterestMode', 'interestGoalId'];
      for (const [k, v] of Object.entries(r.interest_settings || {})) {
        if (!['interestEnabled', 'interestRate', 'interestCalc', 'interestCreditFreq', 'interestOtherDays',
          'interestSimulation', 'goalInterestMode', 'interestGoalId'].includes(k)) throw Error('Unsupported account interest setting: ' + k);
        a[k] = copy(v);
      }
      if (!['debit', 'credit', 'ewallet'].includes(a.type) || !Number.isFinite(a.bal)) throw Error('Invalid account');
      s.accts.push(a);
    }
    const statementMap = new Map();
    for (const r of rows('account_statements')) {
      const a = s.accts.find(a => a.id === localRef('accounts', r.account_id));
      if (!a || !object(r.metadata)) throw Error('Statement metadata unavailable');
      const st = { ...copy(r.metadata), st: r.statement_start, en: r.statement_end, opening: r.opening_balance, close: r.closing_balance,
        minimum: r.minimum_due, paid: r.paid_amount, c: { ...(r.metadata.c || {}), st: r.statement_date, due: r.due_date } };
      const legacy = String(st.statementId || `${a.id}:${st.st||st.en||a.statementHistory.length}`);
      statementMap.set(r.id, legacy);
      const found = a.statementHistory.findIndex(x => String(x.statementId || `${a.id}:${x.st||x.en||''}`) === legacy);
      if (found < 0) a.statementHistory.push(st); else a.statementHistory[found] = st;
    }
    const statement = id => id == null ? null : (statementMap.get(id) || fail('Unknown statement'));
    for (const r of rows('transactions')) {
      const t = { ...copy(r.metadata || {}), id: localId(r), d: r.transaction_date, amt: r.amount, acct: r.account_id ? localRef('accounts', r.account_id) : null,
        cat: category(r.category_id), note: r.title || '', desc: r.description || '' };
      for (const [key, value] of [['pd', r.posting_date], ['billId', localRef('bills', r.bill_id)],
        ['parentId', localRef('transactions', r.parent_transaction_id)], ['statementId', statement(r.statement_id)]]) {
        if (value != null) t[key] = value; else delete t[key];
      }
      if (!Number.isFinite(t.amt) || !t.acct || !['posted', 'pending'].includes(r.status)) throw Error('Invalid transaction');
      s[r.status === 'pending' ? 'pend' : 'tx'].push(t);
    }
    for (const r of rows('bills')) s.bills.push({ ...copy(r.metadata || {}), id: localId(r), name: r.name, amt: r.amount, kind: r.kind,
      freq: r.frequency, start: r.start_date, due: r.due_day, logo: r.logo_url, subscriptionStatus: r.status, cancelledOn: r.cancelled_on,
      trialStartDate: r.trial_start, trialEndDate: r.trial_end, al: copy(r.alert_settings || []), acct: localRef('accounts', r.payment_account_id) });
    for (const r of rows('goals')) s.goals.push({ id: localId(r), name: r.name, icon: r.icon, target: r.target_amount, saved: r.saved_amount,
      accountId: localRef('accounts', r.account_id), targetDate: r.target_date, done: r.completed ? 1 : 0 });
    for (const r of rows('debts')) s.debts.push({ id: localId(r), who: r.person, note: r.note, amt: r.amount, dir: r.direction, due: r.due_date || '' });
    for (const r of rows('budgets')) {
      const name = category(r.category_id);
      if (!name || Object.hasOwn(s.budgets, name)) throw Error('Ambiguous budget');
      s.budgets[name] = r.amount;
    }
    for (const r of rows('notes')) s.notes.push({ id: localId(r), t: r.title, b: r.body, d: r.note_date });
    for (const r of rows('transfers')) s.xfer.push({ ...copy(r.metadata || {}), id: localId(r), from: localRef('accounts', r.from_account_id),
      to: localRef('accounts', r.to_account_id), goalId: localRef('goals', r.goal_id), statementId: statement(r.statement_id),
      kind: r.transfer_type, amt: r.amount, d: r.transfer_date, note: r.note || '' });
    for (const r of rows('bill_payments')) {
      if (r.transfer_id || r.status !== 'paid') throw Error('Unsupported bill payment representation');
      const t = s.tx.find(t => t.id === localRef('transactions', r.transaction_id));
      if (!t || t.billId !== localRef('bills', r.bill_id) || t.d !== r.paid_date || Math.abs(t.amt) !== r.amount) throw Error('Bill payment cannot round-trip');
      t.billDue = r.due_date;
    }
    const p = rows('profiles')[0], prefs = rows('user_preferences')[0];
    Object.assign(s, { name: p.display_name || '', photo: p.photo_url || null, cur: prefs.currency, nf: prefs.number_format, neg: prefs.negative_style,
      dec: prefs.show_decimals ? 1 : 0, theme: prefs.theme, anim: prefs.animations_enabled ? 1 : 0, rm: prefs.reduce_motion ? 1 : 0,
      snd: prefs.sound_enabled ? 1 : 0, hap: prefs.haptics_enabled ? 1 : 0, hide: prefs.hide_balances ? 1 : 0,
      logoChoice: prefs.logo_choice, accountView: prefs.account_view, accountSort: prefs.account_sort, accountOrder: copy(prefs.account_order || []) });
    return s;
  }

  // Export all utilities needed by bootstrap and sync-production
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ENTITIES, UUID, HEX, copy, fail, object, stable, signature, validateSnapshot, assertFresh,
      migrationStableUuid, hydrate };
  }
  if (typeof window !== 'undefined') {
    window.CapCloudToLocal = { ENTITIES, UUID, HEX, copy, fail, object, stable, signature, validateSnapshot, assertFresh,
      migrationStableUuid, hydrate };
  }
})();
