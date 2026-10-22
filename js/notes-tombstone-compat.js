/* Unwired, pure note compatibility previews. No S mutation, storage, UI, cloud,
   confirmation, or executor. privateNotes/privateJson are NOT diagnostics. */
(function (root) {
  'use strict';
  const VERSION = 'notes-tombstone-compat-v1';
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const text = x => typeof x === 'string' && x.trim().length > 0;
  const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
  const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  const keys = (x, required) => object(x) && required.every(k => Object.hasOwn(x, k)) && Object.keys(x).every(k => required.includes(k));
  function canonical(x) {
    if (x === null || ['string', 'boolean'].includes(typeof x)) return x;
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (Array.isArray(x)) return x.map(canonical);
    if (!object(x) || Object.prototype.toString.call(x) !== '[object Object]') throw Error();
    return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  }
  const json = x => JSON.stringify(canonical(x)), equal = (a, b) => json(a) === json(b), copy = x => JSON.parse(json(x));
  async function hash(x) {
    const b = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(json(x)));
    return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
  }
  const iso = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
  const date = x => x === null || typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x;
  const lifecycle = x => keys(x, ['version', 'revision', 'deleted_at', 'operation_id']) && x.version === 1 && Number.isSafeInteger(x.revision) && x.revision > 0 &&
    (x.deleted_at === null || iso(x.deleted_at)) && (x.deleted_at === null ? x.operation_id === null || text(x.operation_id) : text(x.operation_id));
  const localId = x => text(x) || Number.isSafeInteger(x) && x >= 0;
  const content = row => ({ body: row.body, note_date: row.note_date, title: row.title });
  const localContent = row => ({ body: row.b, note_date: row.d ?? null, title: row.t });
  const visible = row => Object.fromEntries(Object.entries(row).filter(([k]) => k !== '_u'));
  const matchesDeletedContent = (n, t, owner) => Object.keys(n).every(k => ['id','t','b','d','_u'].includes(k)) &&
    equal(localContent(n), content(original(t, owner)));
  const result = (classification, status) => ({ version: VERSION, classification, status, previewReady: false, executable: false,
    authorized: false, canRestore: false, canPurge: false });
  const blocked = () => result('BLOCKED', 'BLOCKED — note lifecycle compatibility not proven; nothing changed');
  const conflict = () => result('CONFLICT', 'CONFLICT — note edit/deletion evidence requires review; preserve all versions');
  function original(t, owner) {
    const r = t.origin === 'cloud' ? t.original : t.intent?.original;
    if (!object(r) || Object.keys(r).some(k => !['id','user_id','legacy_id','title','body','note_date','created_at','updated_at'].includes(k)) ||
        r.id !== t.supabase_id || r.user_id !== owner || r.legacy_id !== t.localId || typeof r.title !== 'string' || typeof r.body !== 'string' || !Object.hasOwn(r, 'note_date') || !date(r.note_date)) throw Error();
    return r;
  }
  async function validateTomb(t, owner) {
    const remote = t?.origin === 'cloud';
    if (!keys(t, ['id','user_id','localId','supabase_id', ...(remote ? ['origin','original'] : ['intent']), 'acknowledged','staged_at']) ||
        !uuid(t.id) || t.user_id !== owner || !text(t.localId) || !uuid(t.supabase_id) || !iso(t.staged_at)) throw Error();
    const r = original(t, owner), fingerprint = await hash(content(r));
    if (!remote) {
      const i = t.intent;
      if (!keys(i, ['version','operation_id','user_id','localId','supabase_id','original','expected']) || i.version !== 1 || i.operation_id !== t.id ||
          i.user_id !== owner || i.localId !== t.localId || i.supabase_id !== t.supabase_id ||
          !keys(i.expected, ['contentFingerprint','lifecycle']) || i.expected.contentFingerprint !== fingerprint || !lifecycle(i.expected.lifecycle) || i.expected.lifecycle.deleted_at !== null) throw Error();
    }
    if (remote || t.acknowledged !== null) {
      const a = t.acknowledged;
      if (!keys(a, ['contentFingerprint','lifecycle']) || a.contentFingerprint !== fingerprint || !lifecycle(a.lifecycle) || a.lifecycle.deleted_at === null ||
          !remote && (a.lifecycle.operation_id !== t.id || a.lifecycle.revision !== t.intent.expected.lifecycle.revision + 1)) throw Error();
    }
  }
  async function parse(state, owner) {
    if (!text(owner) || !object(state)) throw Error();
    const tombs = Object.hasOwn(state, 'noteTombstones') ? state.noteTombstones : [];
    if (!Array.isArray(tombs)) throw Error();
    const notes = Object.hasOwn(state, 'notes') ? state.notes : [];
    if (typeof notes === 'string') { if (tombs.length) throw Error(); return { legacy: true, notes, tombs }; }
    if (!Array.isArray(notes) || notes.some(n => !object(n) || !localId(n.id) || typeof n.t !== 'string' || typeof n.b !== 'string' || !date(n.d ?? null))) throw Error();
    if (new Set(notes.map(n => String(n.id))).size !== notes.length) throw Error();
    const ids = new Set(), locals = new Set(), clouds = new Set();
    for (const t of tombs) {
      await validateTomb(t, owner);
      if (ids.has(t.id) || locals.has(t.localId) || clouds.has(t.supabase_id) || notes.some(n => String(n.id) === t.localId)) throw Error();
      ids.add(t.id); locals.add(t.localId); clouds.add(t.supabase_id);
    }
    return { legacy: false, notes, tombs };
  }
  async function inspect(state, owner) {
    try {
      const p = await parse(copy(state), owner);
      return { ...result('VALID', 'NOTE LIFECYCLE SHAPE VERIFIED — no normalization or write performed'), valid: true,
        counts: { active: p.legacy ? null : p.notes.length, tombstones: p.tombs.length }, legacyText: p.legacy };
    } catch (_) { return { ...blocked(), valid: false }; }
  }
  function unionTombs(parts) {
    const locals = new Map(), clouds = new Map(), operations = new Map();
    for (const p of parts) for (const t of p.tombs) {
      const prior = locals.get(t.localId), byCloud = clouds.get(t.supabase_id), byOperation = operations.get(t.id);
      if (prior && !equal(prior, t) || byCloud && !equal(byCloud, t) || byOperation && !equal(byOperation, t)) return null;
      locals.set(t.localId, t); clouds.set(t.supabase_id, t); operations.set(t.id, t);
    }
    return [...locals.values()];
  }
  async function preview(kind, input, notes, tombs, suppressed) {
    return { ...result('PREVIEW', 'PREVIEW ONLY — deletion evidence retained; no restore, purge, or write'), previewReady: true,
      requiresConfirmation: true, counts: { active: notes.length, tombstones: tombs.length, staleActiveSuppressed: suppressed },
      ticket: await hash({ version: VERSION, kind, input }), privateNotes: { notes: copy(notes), noteTombstones: copy(tombs) } };
  }
  async function planMerge(input) {
    try {
      const s = copy(input);
      if (!keys(s, ['owner','base','local','remote'])) throw Error();
      const [base, local, remote] = await Promise.all([s.base,s.local,s.remote].map(d => parse(d, s.owner)));
      if ([base,local,remote].some(p => p.legacy)) return result('LEGACY_REVIEW', 'BLOCKED — legacy text notes need separate review; no conversion');
      const tombs = unionTombs([local, remote, base]); if (!tombs) return conflict();
      const maps = [base,local,remote].map(p => new Map(p.notes.map(n => [String(n.id), n])));
      const tombIds = new Map(tombs.map(t => [t.localId, t])), noteIds = new Set(maps.flatMap(m => [...m.keys()]));
      const notes = []; let suppressed = 0;
      for (const id of noteIds) {
        const [b,l,r] = maps.map(m => m.get(id)), t = tombIds.get(id);
        if (t) {
          if ([b,l,r].some(n => n && !matchesDeletedContent(n, t, s.owner))) return conflict();
          suppressed += [l,r].filter(Boolean).length; continue;
        }
        if (b && (!l || !r)) return result('MISSING_INTENT', 'BLOCKED — omitted notes are not deletion intent');
        if (l && r) {
          if (equal(visible(l), visible(r))) notes.push(l);
          else if (b && equal(visible(l), visible(b))) notes.push(r);
          else if (b && equal(visible(r), visible(b))) notes.push(l);
          else return conflict();
        } else if (l || r) notes.push(l || r);
      }
      return await preview('merge', s, notes, tombs, suppressed);
    } catch (_) { return blocked(); }
  }
  function imported(value, owner) {
    if (!object(value)) throw Error();
    if (value.format === 'cap-notes-lifecycle-backup-v1') {
      if (!keys(value, ['format','owner','data']) || value.owner !== owner) throw Error();
      return value.data;
    }
    if (value.app === 'cap-finance-tracker') {
      if (value.version !== '1.01' || !object(value.data)) throw Error(); return value.data;
    }
    if (Object.hasOwn(value, 'format') || Object.hasOwn(value, 'app')) throw Error();
    return value;
  }
  async function planImport(input) {
    try {
      const s = copy(input);
      if (!keys(s, ['owner','current','incoming','format','mode']) || !['json','csv'].includes(s.format) || !['merge','replace','undo'].includes(s.mode)) throw Error();
      const current = await parse(s.current, s.owner);
      if (current.legacy) return result('LEGACY_REVIEW', 'BLOCKED — legacy text notes need separate review; no conversion');
      if (s.format === 'csv') {
        if (s.mode !== 'merge' || !object(s.incoming) || Object.hasOwn(s.incoming, 'notes') || Object.hasOwn(s.incoming, 'noteTombstones')) throw Error();
        return await preview('import', s, current.notes, current.tombs, 0);
      }
      const data = imported(s.incoming, s.owner), incoming = await parse(data, s.owner);
      if (incoming.legacy) return result('LEGACY_REVIEW', 'BLOCKED — legacy text notes need separate review; no conversion');
      // A backup is not fresh server evidence or permission to hide another note.
      for (const t of incoming.tombs) if (!current.tombs.some(c => equal(c, t)))
        return result('IMPORTED_EVIDENCE', 'BLOCKED — imported deletion evidence needs independent verification');
      const tombs = unionTombs([current, incoming]); if (!tombs) return conflict();
      const active = new Map(current.notes.map(n => [String(n.id), n])), tombIds = new Map(tombs.map(t => [t.localId,t]));
      let suppressed = 0;
      for (const n of incoming.notes) {
        const id = String(n.id), t = tombIds.get(id), c = active.get(id);
        if (t) { if (!matchesDeletedContent(n, t, s.owner)) return conflict(); suppressed++; continue; }
        if (c && !equal(visible(c), visible(n))) return conflict();
        if (!c) active.set(id, n);
      }
      if (s.mode !== 'merge' && current.notes.some(n => !incoming.notes.some(i => String(i.id) === String(n.id))))
        return result('MISSING_INTENT', 'BLOCKED — replace/undo omission cannot delete active notes');
      return await preview('import', s, [...active.values()], tombs, suppressed);
    } catch (_) { return blocked(); }
  }
  async function review(kind, input, ticket) {
    if (!['merge','import'].includes(kind) || !hex(ticket)) return blocked();
    const r = await (kind === 'merge' ? planMerge(input) : planImport(input));
    if (!r.previewReady || r.ticket !== ticket) return result('STALE', 'BLOCKED — compatibility evidence changed; review again');
    return r;
  }
  async function exportPrivate(state, owner) {
    try {
      const data = copy(state); await parse(data, owner);
      return { exported: true, privateJson: JSON.stringify({ format: 'cap-notes-lifecycle-backup-v1', owner, data }) };
    } catch (_) { return { ...blocked(), exported: false }; }
  }
  const api = Object.freeze({ inspect, planMerge, planImport, review, exportPrivate });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CapNotesTombstoneCompat = api;
})(globalThis);
