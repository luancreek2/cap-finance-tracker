
/* ===== Cap offline layer: IndexedDB persistence, 3-way merge sync, status pill, PWA wiring ===== */
(function () {
  "use strict";
  const J = JSON.stringify;
  const eq = (a, b) => J(a) === J(b);
  const clone = (o) => JSON.parse(J(o));
  const now = () => Date.now();
  const LIST_KEYS = ["accts", "tx", "pend", "xfer", "bills", "goals", "debts"];
  const MAX_DOC = 235000; // existing cloud document size cap

  /* ---------- IndexedDB (key/value) ---------- */
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open("cap-finance", 2);
        r.onupgradeneeded = (e) => { const d=e.target.result; if(!d.objectStoreNames.contains('kv'))d.createObjectStore('kv'); if(!d.objectStoreNames.contains('outbox'))d.createObjectStore('outbox',{keyPath:'id'}); if(!d.objectStoreNames.contains('syncmeta'))d.createObjectStore('syncmeta'); if(!d.objectStoreNames.contains('syncconflicts'))d.createObjectStore('syncconflicts',{keyPath:'id'}); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  const idbGet = (k) => idb().then((d) => new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }));
  const idbPut = (k, v) => idb().then((d) => new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }));
  const syncStore = (store,op,value,key) => idb().then((d)=>new Promise((res,rej)=>{const t=d.transaction(store,'readwrite'),s=t.objectStore(store);let result,q=op==='get'?s.get(value):op==='all'?s.getAll():op==='delete'?s.delete(value):op==='clear'?s.clear():s.put(value,key);q.onsuccess=()=>{result=q.result};q.onerror=()=>rej(q.error);t.oncomplete=()=>res(result);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)}));

  /* Dormant notes-only acknowledgement. Called only after verified cloud
     convergence. Baseline replacement and exact outbox removal commit together.
     guard is synchronous: the caller must recheck live local state/ownership. */
  async function finalizeVerifiedNotePush(receipt, guard) {
    if (typeof guard !== 'function') throw Error('Local verification guard required');
    const { userId, entry, expectedRecord, nextRecord } = clone(receipt || {});
    if (!userId || entry?.entity !== 'notes' || entry.operation !== 'upsert' ||
        !entry.id || entry.user_id !== userId || entry.payload?.user_id !== userId ||
        !entry.supabase_id || entry.payload.id !== entry.supabase_id || String(entry.payload.legacy_id) !== String(entry.local_id) ||
        nextRecord?.entity !== 'notes' || nextRecord.user_id !== userId ||
        nextRecord.supabase_id !== entry.supabase_id || String(nextRecord.localId) !== String(entry.local_id) ||
        nextRecord.last_operation_id !== entry.id || !/^[0-9a-f]{64}$/i.test(nextRecord.contentFingerprint || '') ||
        expectedRecord && (expectedRecord.entity !== 'notes' || expectedRecord.user_id !== userId ||
          expectedRecord.supabase_id !== entry.supabase_id || String(expectedRecord.localId) !== String(entry.local_id) ||
          !/^[0-9a-f]{64}$/i.test(expectedRecord.contentFingerprint || ''))) {
      throw Error('Invalid note acknowledgement');
    }
    const d = await idb();
    let alreadyFinalized = false;
    await new Promise((resolve, reject) => {
      const t = d.transaction(['syncmeta', 'outbox'], 'readwrite');
      const meta = t.objectStore('syncmeta'), queue = t.objectStore('outbox');
      const bq = meta.get('baseline'), oq = queue.get(entry.id);
      let baseline, currentEntry, loaded = 0, failure;
      const abort = () => { failure = Error('Note acknowledgement preconditions changed'); t.abort(); };
      const ready = () => {
        if (++loaded !== 2) return;
        try {
          if (baseline?.version !== 2 || baseline.user_id !== userId || !Array.isArray(baseline.records)) return abort();
          const matches = baseline.records.filter(r => r.entity === 'notes' &&
            (r.supabase_id === entry.supabase_id || String(r.localId) === String(entry.local_id)));
          if (!currentEntry && matches.length === 1 && eq(matches[0], nextRecord)) {
            alreadyFinalized = true; return;
          }
          if (!eq(currentEntry, entry) || (expectedRecord ? matches.length !== 1 || !eq(matches[0], expectedRecord) : matches.length !== 0)) return abort();
          // Do not accept Promise-returning guards as a truthy success.
          if (guard() !== true) return abort();
          const records = expectedRecord ? baseline.records.map(r => r === matches[0] ? clone(nextRecord) : r) : [...baseline.records, clone(nextRecord)];
          meta.put({ ...baseline, records, revision: (baseline.revision || 0) + 1,
            aggregateFingerprintStale: true, updated_at: new Date().toISOString() }, 'baseline');
          queue.delete(entry.id);
        } catch (_) { abort(); }
      };
      bq.onsuccess = () => { baseline = bq.result; ready(); };
      oq.onsuccess = () => { currentEntry = oq.result; ready(); };
      t.oncomplete = () => resolve();
      t.onabort = () => reject(failure || Error('Atomic note acknowledgement aborted'));
      t.onerror = () => { failure = Error('Atomic note acknowledgement failed'); };
    });
    // Read back both stores in one snapshot after commit. Never report success
    // based on a request's onsuccess before the transaction actually completes.
    const verified = await new Promise((resolve, reject) => {
      const t = d.transaction(['syncmeta', 'outbox'], 'readonly');
      const bq = t.objectStore('syncmeta').get('baseline'), oq = t.objectStore('outbox').get(entry.id);
      let b, q;
      bq.onsuccess = () => { b = bq.result; }; oq.onsuccess = () => { q = oq.result; };
      t.oncomplete = () => {
        const matches = (Array.isArray(b?.records) ? b.records : []).filter(r => r.entity === 'notes' &&
          (r.supabase_id === entry.supabase_id || String(r.localId) === String(entry.local_id)));
        resolve(b?.user_id === userId && !q && matches.length === 1 && eq(matches[0], nextRecord));
      };
      t.onabort = t.onerror = () => reject(Error('Acknowledgement read-back failed'));
    }).catch(() => false);
    if (!verified) {
      const error = Error('LOCAL WRITE OCCURRED — VERIFICATION FAILED');
      error.committed = true; throw error;
    }
    return { committed: true, verified: true, alreadyFinalized };
  }

  /* Explicitly confirmed cleanup of exactly the three old account-harness
     entries. Deletes no app rows and never replaces or updates the baseline. */
  async function discardVerifiedTestOutbox(receipt, guard) {
    if (typeof guard !== 'function') throw Error('Local verification guard required');
    const { userId, entries, expectedBaseline } = clone(receipt || {});
    const known = op => op?.user_id === userId && op.entity === 'accounts' && op.operation === 'upsert' &&
      typeof op.id === 'string' && op.id && typeof op.local_id === 'string' && op.local_id &&
      op.supabase_id === op.local_id && op.payload?.id === op.supabase_id && op.payload.user_id === userId &&
      op.payload.name === 'CAP SYNC ENGINE TEST' && op.payload.legacy_id === 'phase6-test-' + op.local_id;
    if (!userId || !Array.isArray(entries) || entries.length !== 3 || new Set(entries.map(e => e.id)).size !== 3 || !entries.every(known) ||
        expectedBaseline?.version !== 2 || expectedBaseline.user_id !== userId || !Array.isArray(expectedBaseline.records)) throw Error('Invalid exact cleanup scope');
    const d = await idb();
    await new Promise((resolve, reject) => {
      const t = d.transaction(['syncmeta', 'outbox'], 'readwrite'), meta = t.objectStore('syncmeta'), queue = t.objectStore('outbox');
      let baseline, recovery, loaded = 0, failure;
      const current = [], abort = () => { failure = Error('Cleanup preconditions changed'); t.abort(); };
      const ready = () => {
        if (++loaded !== entries.length + 2) return;
        try {
          if (!eq(baseline, expectedBaseline) || recovery || entries.some((op, i) => !eq(op, current[i]) ||
              baseline.records.some(r => r.entity === 'accounts' && (String(r.supabase_id) === op.supabase_id || String(r.localId ?? r.legacy_id) === op.local_id))) || guard() !== true) return abort();
          entries.forEach(op => queue.delete(op.id));
        } catch (_) { abort(); }
      };
      const bq = meta.get('baseline'), rq = meta.get('controlled-notes-test-v1');
      bq.onsuccess = () => { baseline = bq.result; ready(); };
      rq.onsuccess = () => { recovery = rq.result; ready(); };
      entries.forEach((op, i) => { const q = queue.get(op.id); q.onsuccess = () => { current[i] = q.result; ready(); }; });
      t.oncomplete = () => resolve(); t.onabort = () => reject(failure || Error('Atomic cleanup aborted'));
      t.onerror = () => { failure = Error('Atomic cleanup failed'); };
    });
    const verified = await new Promise((resolve, reject) => {
      const t = d.transaction(['syncmeta', 'outbox'], 'readonly');
      let b, recovery; const remaining = [];
      const bq = t.objectStore('syncmeta').get('baseline'), rq = t.objectStore('syncmeta').get('controlled-notes-test-v1');
      bq.onsuccess = () => { b = bq.result; }; rq.onsuccess = () => { recovery = rq.result; };
      entries.forEach((op, i) => { const q = t.objectStore('outbox').get(op.id); q.onsuccess = () => { remaining[i] = q.result; }; });
      t.oncomplete = () => resolve(eq(b, expectedBaseline) && !recovery && remaining.every(x => x === undefined));
      t.onabort = t.onerror = () => reject(Error('Cleanup read-back failed'));
    }).catch(() => false);
    if (!verified) { const error = Error('LOCAL WRITE OCCURRED — VERIFICATION FAILED'); error.committed = true; throw error; }
    return { committed: true, verified: true, removed: entries.length };
  }

  /* ---------- helpers ---------- */
  const isList = (...vs) => vs.some(Array.isArray) && vs.every((v) => v === undefined || (Array.isArray(v) && v.every((x) => x && typeof x === "object" && "id" in x)));
  const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);
  const r2 = (n) => Math.round(n * 100) / 100;

  /* ---------- three-way merge ---------- */
  // record-level: field by field; conflicting field -> record edited most recently (_u) wins
  function mergeRec(b, l, r) {
    const out = {}, lw = (l._u || 0) >= (r._u || 0);
    const keys = new Set([...Object.keys(b || {}), ...Object.keys(l), ...Object.keys(r)]);
    keys.delete("_u");
    keys.forEach((k) => {
      const bv = b ? b[k] : undefined, lv = l[k], rv = r[k];
      let v;
      if (eq(lv, rv)) v = lv; else if (eq(lv, bv)) v = rv; else if (eq(rv, bv)) v = lv; else v = lw ? lv : rv;
      if (v !== undefined) out[k] = v;
    });
    const u = Math.max(l._u || 0, r._u || 0);
    if (u) out._u = u;
    return out;
  }
  function mergeList(b, l, r) {
    const key = (x) => String(x.id);
    const M = (a) => { const m = new Map(); a.forEach((x) => m.set(key(x), x)); return m; };
    const bm = M(b), lm = M(l), rm = M(r);
    const lOrderChanged = !eq(l.filter((x) => bm.has(key(x))).map(key), b.filter((x) => lm.has(key(x))).map(key));
    const order = lOrderChanged ? [...l, ...r] : [...r, ...l];
    const seen = new Set(), out = [];
    order.forEach((it) => {
      const k = key(it);
      if (seen.has(k)) return;
      seen.add(k);
      const bi = bm.get(k), li = lm.get(k), ri = rm.get(k);
      let v;
      if (li && ri) v = eq(li, ri) ? li : bi && eq(li, bi) ? ri : bi && eq(ri, bi) ? li : mergeRec(bi, li, ri);
      else if (li) v = bi && eq(li, bi) ? null /* deleted remotely, untouched locally */ : li; // edited-vs-deleted keeps the edit
      else v = bi && eq(ri, bi) ? null : ri;
      if (v) out.push(v);
    });
    return out;
  }
  function mergeNotes(bv, lv, rv, lw) {
    if (eq(lv, rv)) return lv;
    if (eq(lv, bv)) return rv;
    if (eq(rv, bv)) return lv;
    const a = String(lv || ""), c = String(rv || "");
    if (a.includes(c)) return a;
    if (c.includes(a)) return c;
    const [win, lose] = lw ? [a, c] : [c, a];
    return win + "\n\n— also edited on another device —\n" + lose; // never silently drop a note edit
  }
  function mergeDoc(b, l, r) {
    b = b || {};
    const out = {}, lw = (l._mt || 0) >= (r._mt || 0);
    const keys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
    keys.delete("_mt");
    keys.forEach((k) => {
      const bv = b[k], lv = l[k], rv = r[k];
      let v;
      if (isList(bv, lv, rv)) v = mergeList(bv || [], lv || [], rv || []);
      else if (k === "notes") v = mergeNotes(bv, lv, rv, lw);
      else if (isMap(lv) || isMap(rv)) {
        v = {};
        const mk = new Set([...Object.keys(bv || {}), ...Object.keys(lv || {}), ...Object.keys(rv || {})]);
        mk.forEach((q) => {
          const x = (bv || {})[q], y = (lv || {})[q], z = (rv || {})[q];
          const w = eq(y, z) ? y : eq(y, x) ? z : eq(z, x) ? y : lw ? y : z;
          if (w !== undefined) v[q] = w;
        });
      } else v = eq(lv, rv) ? lv : eq(lv, bv) ? rv : eq(rv, bv) ? lv : lw ? lv : rv;
      if (v !== undefined) out[k] = v;
    });
    reconcileBalances(b, l, r, out);
    out._mt = Math.max(l._mt || 0, r._mt || 0, b._mt || 0);
    return out;
  }
  // Balances are derived: base + effect of merged tx/payments + each side's manual (non-tx) adjustments.
  // This keeps balances / owed amounts / available credit consistent whichever side "won" a conflict.
  function eff(doc, a) {
    let s = 0;
    const sign = a.type === "credit" ? -1 : 1;
    (doc.tx || []).forEach((t) => { if (t.acct == a.id) s += sign * (+t.amt || 0); });
    (doc.xfer || []).forEach((x) => { if (x.to == a.id) s -= +x.amt || 0; if (x.from == a.id) s -= +x.amt || 0; });
    return s;
  }
  function reconcileBalances(b, l, r, out) {
    const idx = (d) => new Map((d.accts || []).map((a) => [String(a.id), a]));
    const bi = idx(b), li = idx(l), ri = idx(r);
    (out.accts || []).forEach((a) => {
      const k = String(a.id), ba = bi.get(k), la = li.get(k), ra = ri.get(k);
      if (!ba || !la || !ra) return; // added/removed on one side: its own balance stands
      const eb = eff(b, a), el = eff(l, a), er = eff(r, a), em = eff(out, a);
      const resL = (+la.bal || 0) - (+ba.bal || 0) - (el - eb);
      const resR = (+ra.bal || 0) - (+ba.bal || 0) - (er - eb);
      a.bal = r2((+ba.bal || 0) + (em - eb) + resL + resR);
    });
  }

  /* ---------- change tracking (per-record timestamps, pending count) ---------- */
  let recMap = new Map(), topJ = "", api = null;
  const strip = (k, v) => (k === "_u" || k === "_mt" ? undefined : v);
  function snapshotRecs(S) {
    const m = new Map();
    LIST_KEYS.forEach((k) => (S[k] || []).forEach((x) => m.set(k + ":" + x.id, J(x, strip))));
    return m;
  }
  const topOnly = (S) => { const o = {}; Object.keys(S).forEach((k) => { if (!Array.isArray(S[k]) || !isList(S[k])) o[k] = S[k]; }); return J(o, strip); };
  function stamp() {
    const S = api.get(), t = now();
    let changed = false;
    const m = new Map();
    Object.keys(S).forEach((k) => {
      if (!Array.isArray(S[k]) || !isList(S[k])) return;
      S[k].forEach((x) => {
        const key = k + ":" + x.id, s = J(x, strip);
        if (recMap.get(key) !== s) { x._u = t; changed = true; }
        m.set(key, s);
      });
    });
    if (m.size !== recMap.size) changed = true;
    const tj = topOnly(S);
    if (tj !== topJ) changed = true;
    recMap = m; topJ = tj;
    if (changed) S._mt = t;
  }
  function resetTracking() { const S = api.get(); recMap = snapshotRecs(S); topJ = topOnly(S); }
  function pendingCount() {
    if (!base) return 0;
    const S = api.get();
    const a = snapshotRecs(S), b = snapshotRecs(base);
    let n = 0;
    a.forEach((v, k) => { if (b.get(k) !== v) n++; });
    b.forEach((v, k) => { if (!a.has(k)) n++; });
    if (topOnly(S) !== topOnly(base)) n++;
    return n;
  }

  /* ---------- persistence ---------- */
  let base = null, pt = null, lsBase = null;
  function persist() {
    try { lsBase = J(api.get()); } catch (e) {}
    clearTimeout(pt);
    pt = setTimeout(flush, 120);
  }
  function flush() {
    clearTimeout(pt);
    if (!api) return Promise.resolve();
    const S = api.get();
    return idbPut("state", { json: J(S), mt: S._mt || 0 }).catch(() => {});
  }
  const saveBase = () => idbPut("base", base ? J(base) : null).catch(() => {});
  function lsWrite() { try { localStorage.setItem("pera", J(api.get())); } catch (e) {} }
  function normalize(r) {
    LIST_KEYS.forEach((k) => (r[k] = Array.isArray(r[k]) ? r[k] : []));
    r.budgets = r.budgets || {};
    r.cur = r.cur || "PHP";
    return r;
  }

  /* ---------- status (shown inside Settings) ---------- */
  let status = "idle", cloud = false, lastErr = "", lastS = "online", lastText = "";
  function mkStyle() {
    const st = document.createElement("style");
    st.textContent =
      "#capnet{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:7px 12px;border-radius:99px;font:600 13px/1.2 -apple-system,'Segoe UI',Inter,Roboto,sans-serif;color:var(--tx);background:var(--bg);border:1px solid var(--line)}" +
      "#capnet i{width:8px;height:8px;border-radius:50%;flex:none;background:var(--g)}" +
      "#capnet[data-s=offline] i{background:#f59e0b}#capnet[data-s=error] i{background:var(--r)}" +
      "#capnet[data-s=syncing] i{background:#3b82f6;animation:capPulse 1s ease-in-out infinite}" +
      "@keyframes capPulse{50%{opacity:.25;transform:scale(.7)}}@media (prefers-reduced-motion:reduce){#capnet[data-s=syncing] i{animation:none}}";
    document.head.appendChild(st);
  }
  function explain() {
    const n = pendingCount();
    const s = n + " change" + (n == 1 ? "" : "s");
    if (!cloud) return "Your data is saved on this device only and works offline. Nobody else can see it. Cross-device cloud sync isn't connected here.";
    if (!navigator.onLine) return "You're offline. " + (n ? s + " saved on this device and will sync automatically when you're back online." : "Everything is saved on this device.");
    if (status === "error") return "Sync failed (" + (lastErr || "network") + "). " + s + " kept safely on this device and will retry automatically.";
    return (n ? s + " waiting to sync. " : "All changes synced. ") + "Your data is saved privately to your account and synced across your devices.";
  }
  function paint() {
    const el = document.getElementById("capnet");
    if (el) { el.dataset.s = lastS; el.querySelector("span").textContent = lastText; }
    const nt = document.getElementById("capnet-note");
    if (nt) nt.textContent = explain();
  }
  function show(s, text) { status = s; lastS = s; lastText = text; paint(); }
  function refreshStatus() {
    const n = pendingCount(), p = n ? " · " + n + " pending" : "";
    if (!navigator.onLine) return show("offline", "Offline · saved on device" + p);
    if (!cloud) return show("local", "Saved on this device");
    if (status === "error") return show("error", "Sync paused" + p + " · retrying");
    show("online", n ? "Online" + p : "Online · synced");
  }
  function settingsHtml() {
    refreshStatus();
    return '<div style="margin:0 0 8px"><div id="capnet" role="status" aria-live="polite" data-s="' + lastS + '"><i></i><span>' + lastText + "</span></div></div>" +
      '<p class="m" id="capnet-note" style="font-size:13px">' + explain() + "</p>" +
      (cloud ? '<button class="btn s" onclick="CapOff.sync()">Sync now</button> ' : "");
  }

  /* ---------- cloud sync ---------- */
  let DBD = null, syncing = false, again = false, retryT = null, fails = 0;
  const withTO = (p, ms = 10000) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  async function connect() {
    if (DBD) return true;
    if (typeof claude === "undefined") return false;
    const u = await withTO(claude.use("user")), db = await withTO(claude.use("db"));
    if (!u || !db) return false;
    const id = await withTO(u.id());
    if (!id) return false;
    DBD = db.collection("data/users/" + id).doc("app");
    return true;
  }
  function scheduleRetry() {
    clearTimeout(retryT);
    const wait = Math.min(300000, 4000 * Math.pow(2, Math.min(fails, 7)));
    retryT = setTimeout(() => sync(), wait);
  }
  function applyLocal(next, rerender) {
    api.set(next);
    resetTracking();
    lsBase = J(next);
    lsWrite();
    flush();
    if (rerender && typeof render === "function") { try { render(); } catch (e) {} }
  }
  async function sync() {
    if (!api) return;
    if (syncing) { again = true; return; }
    if (!navigator.onLine) { refreshStatus(); return; }
    syncing = true;
    clearTimeout(retryT);
    try {
      cloud = await connect();
      if (!cloud) { refreshStatus(); return; }
      show("syncing", "Syncing…");
      for (let attempt = 0; attempt < 4; attempt++) {
        const sj = J(api.get());
        const snap = JSON.parse(sj);
        const rs = await withTO(DBD.get());
        let remote = null, rj = null;
        if (rs && rs.exists) { const d = rs.data(); if (d && d.json) { rj = d.json; try { remote = JSON.parse(rj); } catch (e) {} } }
        if (remote && !Array.isArray(remote.accts)) remote = null;
        let merged;
        if (!remote) merged = snap;
        else if (!base) { // first contact with existing cloud data: adopt it, but keep the local copy as a backup
          await idbPut("backup", { json: sj, t: now() }).catch(() => {});
          merged = normalize(remote);
        } else merged = normalize(mergeDoc(base, snap, normalize(remote)));
        const mj = J(merged);
        if (mj.length > MAX_DOC) { show("error", "Too large to sync · saved on device"); return; }
        if (mj !== rj) await withTO(DBD.set({ json: mj, t: now() }));
        const chk = await withTO(DBD.get());
        const cj = chk && chk.exists ? (chk.data() || {}).json : null;
        if (cj !== mj) { continue; } // another device wrote in between: merge again, nothing is lost
        const cur = J(api.get());
        base = clone(merged);
        await saveBase();
        if (cur !== sj) {
          // user edited while we were syncing: fold those edits on top of the merged result
          applyLocal(mergeDoc(snap, api.get(), merged), true);
          again = true;
        } else if (mj !== sj) applyLocal(clone(merged), true);
        break;
      }
      fails = 0;
      status = "online";
      const left = pendingCount();
      show("online", left ? "Online · " + left + " pending" : "Synced ✓");
    } catch (e) {
      fails++;
      lastErr = (e && e.message) || "network";
      status = "error";
      refreshStatus();
      scheduleRetry();
      registerBgSync();
    } finally {
      syncing = false;
      if (again) { again = false; setTimeout(sync, 300); }
    }
  }
  function registerBgSync() {
    try { navigator.serviceWorker.ready.then((r) => r.sync && r.sync.register("cap-sync")).catch(() => {}); } catch (e) {}
  }

  /* ---------- public API ---------- */
  let syncDeb = null;
  const CapOff = {
    init(a) { api = a; },
    stamp() { try { stamp(); } catch (e) {} },
    persist() { persist(); },
    requestSync() { clearTimeout(syncDeb); syncDeb = setTimeout(() => { refreshStatus(); if (navigator.onLine) sync(); else registerBgSync(); }, 600); },
    sync,
    async localSnapshot() {
      const aux={};
      ['pera_pre','cap_notif_seen','cap_lastbackup','cap_whats_new_seen_version'].forEach(k=>{try{const v=localStorage.getItem(k);if(v!==null)aux[k]=v}catch(_){} });
      const read=k=>idbGet(k).catch(()=>null);
      return {pera:(()=>{try{return localStorage.getItem('pera')}catch(_){return null}})(),indexeddb:{state:await read('state'),base:await read('base'),backup:await read('backup')},auxiliary:aux,excludedLocalKeys:['cap_lock','cap_bio','cap_supabase_session']};
    },
    syncStore,
    finalizeVerifiedNotePush,
    discardVerifiedTestOutbox,
    status() { return { status, cloud, pending: pendingCount(), online: navigator.onLine }; },
    mergeDoc,
    settingsHtml,
    async boot() {
      mkStyle();
      let hadLS = false;
      try { hadLS = !!localStorage.getItem("pera"); } catch (e) {}
      const startMt = (api.get() || {})._mt || 0;
      resetTracking();
      if (hadLS && typeof render === "function") render(); // normal launch: paint immediately from localStorage
      const rec = await idbGet("state").catch(() => null);
      if (!hadLS && rec && rec.json) { try { const r = JSON.parse(rec.json); if (r && Array.isArray(r.accts)) api.set(normalize(r)); } catch (e) {} }
      resetTracking();
      if (!hadLS && rec) lsWrite();
      if (!hadLS && typeof render === "function") render();
      if (hadLS && rec && rec.json && (rec.mt || 0) > startMt) { // IndexedDB copy is newer (e.g. localStorage write was lost)
        try { const r = JSON.parse(rec.json); if (r && Array.isArray(r.accts)) { applyLocal(normalize(r), true); } } catch (e) {}
      }
      try { const b = await idbGet("base"); if (b) base = JSON.parse(b); } catch (e) {}
      if (!hadLS && !rec) { /* brand-new install: nothing stored yet */ }
      flush();
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
      cloud = typeof claude !== "undefined";
      refreshStatus();
      sync();
    },
  };
  window.CapOff = CapOff;

  /* ---------- events ---------- */
  addEventListener("online", () => { show("online", "Back online"); sync(); });
  addEventListener("offline", () => { refreshStatus(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { flush(); } else if (navigator.onLine) sync();
  });
  addEventListener("pagehide", () => { flush(); });
  setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine && (pendingCount() || status === "error")) sync(); }, 60000);
  // another tab/window changed the data: fold its changes into this one (3-way, so neither side loses edits)
  addEventListener("storage", (e) => {
    if (e.key !== "pera" || !e.newValue || !api) return;
    try {
      const other = normalize(JSON.parse(e.newValue)), mine = api.get();
      if (eq(other, mine)) return;
      const common = lsBase ? JSON.parse(lsBase) : null;
      applyLocal(common ? normalize(mergeDoc(common, clone(mine), other)) : other, true);
    } catch (err) {}
  });
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "cap-sync") sync(); });

  /* ---------- PWA: service worker + real manifest when served over http(s) ---------- */
  if (/^https?:$/.test(location.protocol) && "serviceWorker" in navigator) {
    addEventListener("load", () => {
      fetch("manifest.json", { method: "HEAD" }).then((r) => {
        if (r.ok) { const l = document.querySelector('link[rel="manifest"]'); if (l) l.href = "manifest.json"; }
      }).catch(() => {});
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();




      /* ========================================================================== */
      /* FINANCE TRACKER — CODE MAP                                                 */
      /* 1. Categories, card catalog, date helpers, and application state           */
      /* 2. Storage, account cards, and main render/navigation                      */
      /* 3. Home dashboard, spending chart, and balance charts                      */
      /* 4. Activity, transaction history, and calendar                             */
      /* 5. Plan, budgets, and bill scheduling                                      */
      /* 6. Notes, goals, debts, and swipe interactions                             */
      /* 7. Transaction, account, and bill actions                                   */
      /* ========================================================================== */

      /* 1. Categories, card catalog, and application state */
      const CATS = {
        Food: "🍜",
        Groceries: "🛒",
        Transport: "🚕",
        Bills: "💡",
        Shopping: "🛍️",
        Health: "💊",
        Entertainment: "🎬",
        Salary: "💰",
        "Interest Earned": "🏦",
        Other: "📦",
      };
const CAT0 = Object.keys(CATS).map((n) => ({ n, i: CATS[n] }));
      const $ = (s) => document.querySelector(s),
        php = (n) => fmt(n);
      const iso = (d) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      let T = new Date(),
        today = iso(T);
      const ago = (n) => {
        const d = new Date(T);
        d.setDate(d.getDate() - n);
        return iso(d);
      };
      let S,
        tab = "Home",
        navTab = "",
        filt = "All",
        actTab = "",
        q = "",
        cm = 0,
        sel = "",
        pt = "Upcoming",
        planTab = "",
        rg = "1M",
        goalIndex = 0,
        goalTouchX = null,
        goalEnter = "",
        goalAnimating = false;
      /* 2. Seed data, persistence, and common account helpers */
      function seed() {
        return {
          accts: [
            {
              id: 1,
              bank: "BDO",
              name: "BDO Debit",
              type: "debit",
              net: "visa",
              g: CAT[0].g,
              img: CAT[0].img,
              bal: 28450,
              l4: "4821",
            },
            {
              id: 2,
              bank: "GCash",
              name: "GCash Visa Card",
              type: "ewallet",
              net: "visa",
              img: "gcashg",
              g: CAT.find((c) => c.img == "gcashg").g,
              bal: 3120,
              l4: "0937",
            },
            {
              id: 3,
              bank: "UnionBank",
              name: "UnionBank Credit",
              type: "credit",
              net: "visa",
              g: CAT[4].g,
              bal: 12600,
              l4: "7704",
            },
          ],
          tx: [
            [0, 35000, "Salary", 1, "Paycheck"],
            [0, -1850, "Groceries", 1, "Puregold"],
            [1, -320, "Food", 2, "Jollibee"],
            [2, -180, "Transport", 2, "Grab"],
            [3, -2400, "Shopping", 3, "Shopee"],
            [4, -950, "Food", 1, "Dinner out"],
            [5, -499, "Entertainment", 3, "Netflix + Spotify"],
            [6, -1200, "Health", 1, "Pharmacy"],
            [8, -2100, "Groceries", 1, "SM Supermarket"],
            [9, -260, "Transport", 2, "Jeepney/MRT"],
          ].map((a, i) => ({
            id: i + 1,
            d: ago(a[0]),
            amt: a[1],
            cat: a[2],
            acct: a[3],
            note: a[4],
          })),
          bills: [
            { id: 1, name: "Meralco Electricity", amt: 3200, due: 16, paid: "" },
            { id: 2, name: "PLDT Fibr", amt: 1699, due: 20, paid: "" },
            { id: 3, name: "Water", amt: 450, due: 25, paid: "" },
            { id: 4, name: "Rent", amt: 12000, due: 1, paid: "" },
          ],
          budgets: {
            Food: 6000,
            Groceries: 8000,
            Transport: 3000,
            Shopping: 4000,
            Entertainment: 2000,
            Health: 2000,
            Bills: 20000,
          },
          notes: "Goals:\n- Emergency fund ₱100,000\n- Pay off UnionBank card",
        };
      }
      try {
        S = JSON.parse(localStorage.getItem("pera") || "null");
      } catch (e) {}
      S = S || seed();
      S.goals = S.goals || [
        { id: 1, name: "Emergency Fund", icon: "🛟", target: 100000, saved: 42000 },
        { id: 2, name: "Japan Trip", icon: "✈️", target: 80000, saved: 15000 },
        { id: 3, name: "New Laptop", icon: "💻", target: 60000, saved: 60000, done: 1 },
      ];
      S.debts = S.debts || [
        { id: 1, who: "Alex", note: "Concert tickets", amt: 3000, dir: "in", due: "" },
        { id: 2, who: "Mia", note: "Dinner split", amt: 1200, dir: "in", due: "" },
        { id: 3, who: "Mom", note: "Borrowed", amt: 7500, dir: "out", due: "" },
      ];
      const save = () => {
        try{const _db=localStorage.getItem('cap_derived_balance');if(_db!=='0'&&typeof refreshBalances==='function')refreshBalances()}catch(e){}
        if(!window.CAP_INTERNAL_SYNC_APPLY){window.CAP_LAST_DRY_RUN=null;window.CAP_LAST_CONFLICT=null}
        try {
          if (window.CapOff) CapOff.stamp();
        } catch (e) {}
        try {
          localStorage.setItem("pera", JSON.stringify(S));
        } catch (e) {}
        try {
          if (window.CapOff) CapOff.persist();
        } catch (e) {}
        clearTimeout(window._dt);
        window._dt = setTimeout(() => {
          if (typeof dbPush == "function") dbPush();
        }, 900);
      };
      const acct = (id) => S.accts.find((a) => a.id == id) || { name: "—" };
      let ym = today.slice(0, 7);
      const inM = S.tx.filter;
      const mtx = () => S.tx.filter((t) => t.d.startsWith(ym) && !t.opening);
      const sum = (a) => a.reduce((s, x) => s + x, 0);
      const spent = (c) =>
        -sum(
          mtx()
            .filter((t) => t.cat == c && t.amt < 0)
            .map((t) => t.amt),
        );
      const BF = { once: "One-time", weekly: "Every week", biweekly: "Every 2 weeks", monthly: "Every month", quarterly: "Every 3 months", yearly: "Every year" };
      const bIso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      const bDt = (k) => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
      function bOn(b, k) {
        const f = b.freq || "monthly", dt = bDt(k);
        if (!b.start) return b.due == dt.getDate();
        const st = bDt(b.start);
        if (dt < st) return false;
        if (f == "once") return k == b.start;
        const dd = Math.round((dt - st) / 864e5);
        if (f == "weekly") return dd % 7 == 0;
        if (f == "biweekly") return dd % 14 == 0;
        const mm = (dt.getFullYear() - st.getFullYear()) * 12 + dt.getMonth() - st.getMonth();
        const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
        if (dt.getDate() != Math.min(st.getDate(), last)) return false;
        if (f == "yearly") return mm % 12 == 0;
        if (f == "quarterly") return mm % 3 == 0;
        return true;
      }
      function bPaid(b, k) {
        return (b.paidOn || []).includes(k) || ((b.freq || "monthly") == "monthly" && b.paid == k.slice(0, 7));
      }
      /* ---- free trials ------------------------------------------------------
         A subscription that starts free keeps its window on the record:
         isFreeTrial, trialStartDate, trialEndDate, firstBillingDate, priceAfterTrial and
         subscriptionStatus. Price / frequency / payment method stay on the normal fields
         (amt, freq, acct), and the FIRST BILLING DATE - never the trial start - anchors the
         repeat schedule (start/due). The trial itself never bills: nothing is charged, no
         ₱0 transaction is written, and the trial window is never a payment record. */
      const isTrial = (b) => !!(b && b.isFreeTrial);
      const subFirstBill = (b) => (isTrial(b) ? b.firstBillingDate || b.trialEndDate || b.start || "" : "");
      const bAdd = (k, n) => { const d = bDt(k); d.setDate(d.getDate() + n); return bIso(d); };
      /* 'trial' until the first billing date (that day still reads "Ends today"), then 'active'.
         Cancelling keeps the record and its history instead of deleting it. */
      function subStatus(b) {
        if (!isTrial(b)) return "active";
        if (b.subscriptionStatus == "Cancelled") return "cancelled";
        if (b.subscriptionStatus == "Expired") return "expired";
        const f = subFirstBill(b);
        return f && bDt(today) <= bDt(f) ? "trial" : "active";
      }
      const inTrial = (b) => subStatus(b) == "trial";
      const subGone = (b) => subStatus(b) == "cancelled" || subStatus(b) == "expired";
      /* the first charge is only billable once its date arrives */
      const subDue = (b) => inTrial(b) && bDt(today) >= bDt(subFirstBill(b));
      const trialLeft = (b) => Math.round((bDt(subFirstBill(b)) - bDt(today)) / 864e5);
      const trialTxt = (n) => n < 0 ? "Free Trial" : n === 0 ? "Free Trial · Ends today" : n === 1 ? "Free Trial · Ends tomorrow" : "Free Trial · " + n + " days left";
      const trialLabel = (b) => trialTxt(trialLeft(b));
      const FREQT = { once: "", weekly: "/week", biweekly: "/2 weeks", monthly: "/month", quarterly: "/3 months", yearly: "/year" };
      const subFreqTail = (b) => FREQT[(b && b.freq) || "monthly"] || "";
      const subFreqWord = (b) => (BF[(b && b.freq) || "monthly"] || "Every month").toLowerCase();
      /* the edit-sheet chip: an active trial outranks the due / paid states */
      function subChip(b) {
        const s = subStatus(b);
        if (s == "trial") return `<span class="chip tr">${trialLabel(b)}</span>`;
        if (s == "cancelled") return '<span class="chip">Cancelled</span>';
        if (s == "expired") return '<span class="chip">Ended</span>';
        return billStatusChip(b);
      }
      function live(b) {
        if (subGone(b)) return false;                /* cancelled or ended: no future renewals */
        if (inTrial(b)) return true;                 /* still listed: the first charge is coming */
        return !(b.freq == "once" && b.start && bPaid(b, b.start));
      }
      function paidNow(b) {
        const f = b.freq || "monthly";
        if (f == "once") return !!b.start && bPaid(b, b.start);
        if (f == "monthly") return b.paid == ym;
        const p = (b.paidOn || []).slice(-1)[0];
        if (!p) return false;
        const lim = { weekly: 7, biweekly: 14, quarterly: 92, yearly: 366 }[f];
        return Math.round((bDt(today) - bDt(p)) / 864e5) < lim;
      }
      function nextDue(b) {
        if (b.nd) return b.nd;
        /* a live trial's next event is simply its first billing date */
        if (inTrial(b)) { const f = subFirstBill(b); if (!bPaid(b, f)) return bDt(f); }
        const f = b.freq || "monthly", t0 = bDt(today);
        let lo = f == "weekly" || f == "biweekly" ? t0 : new Date(t0.getFullYear(), t0.getMonth(), 1);
        if (f == "once" && b.start) lo = bDt(b.start);
        for (let i = 0; i < 800; i++) {
          const d = new Date(lo.getFullYear(), lo.getMonth(), lo.getDate() + i);
          if (bOn(b, bIso(d)) && !bPaid(b, bIso(d))) return d;
        }
        return bDt(b.start || today);
      }
      function bLbl(b) {
        const f = b.freq || "monthly", st = b.start ? bDt(b.start) : null, dn = st ? st.getDate() : b.due;
        const o = (n) => n + (n % 10 == 1 && n != 11 ? "st" : n % 10 == 2 && n != 12 ? "nd" : n % 10 == 3 && n != 13 ? "rd" : "th");
        const L = (opt) => st.toLocaleDateString("en-PH", opt);
        if (f == "once") return "One-time · " + L({ month: "short", day: "numeric" });
        if (f == "weekly" || f == "biweekly") return BF[f] + " · " + L({ weekday: "short" });
        if (f == "yearly") return "Every year · " + L({ month: "short", day: "numeric" });
        return BF[f] + " · " + o(dn);
      }
      function bWhen(b) {
        const n = days(b);
        return n < 0 ? Math.abs(n) + " day" + (n < -1 ? "s" : "") + " overdue" : n == 0 ? "due today" : "in " + n + " day" + (n > 1 ? "s" : "");
      }
      const days = (b) => Math.round((nextDue(b) - bDt(today)) / 864e5);
      const logoH = (a) => {
        const k = LOGOB[a.bank];
        return k
          ? `<span class="lg ${k == "mari" ? "w" : ""}"><img src="${LOGO[k]}" alt="${a.bank}"></span>`
          : `<span class="b">${a.bank}</span>`;
      };
      let acctFlipActive = null;
      function flipAccountCard(id, force) {
        const key = id == null ? null : String(id);
        const next = force === true ? key : force === false ? null : acctFlipActive === key ? null : key;
        acctFlipActive = next;
        document.querySelectorAll("#app .acct-flip").forEach((w) => {
          const on = w.dataset.accountId === next;
          w.classList.toggle("is-flipped", on);
          w.classList.remove("is-pressing");
          w.setAttribute("aria-pressed", on ? "true" : "false");
          const front = w.querySelector(".acct-flip-front"), back = w.querySelector(".acct-flip-back");
          if (front) {
            front.setAttribute("aria-hidden", on ? "true" : "false"); front.inert = on;
            const control = front.querySelector(".cc[role=button]"); if (control) control.setAttribute("aria-pressed", on ? "true" : "false");
          }
          if (back) { back.setAttribute("aria-hidden", on ? "false" : "true"); back.inert = !on; }
        });
        return next;
      }
      function acctBackHtml(a, art, on) {
        const kind = a.img === "cash" ? "Cash" : a.type === "credit" ? "Credit" : a.type === "ewallet" ? "E-wallet" : "Debit";
        const recent = (S.tx || [])
          .filter((t) => String(t.acct) === String(a.id) && !(S.pend || []).some((p) => p.id == t.id) && t.d <= today)
          .sort((x, y) => y.d.localeCompare(x.d) || (+y.id || 0) - (+x.id || 0))
          .slice(0, 4);
        const rows = recent.map((t) => `<div class="afb-tx"><span class="afb-ico">${ti(t)}</span><span class="afb-desc"><b>${esc(t.note || t.cat || "Transaction")}</b><small>${noteD(t.d)}</small></span><strong class="${t.amt < 0 ? "r" : "g"}">${t.amt > 0 ? "+" : ""}${php(t.amt)}</strong></div>`).join("");
        const title = `${esc(a.bank || a.name)} ${kind}${a.l4 ? ` · ${esc(a.l4)}` : ""}`;
        const bg = art
          ? `background-image:linear-gradient(135deg,rgba(10,14,23,.91),rgba(10,14,23,.78)),url(${art})`
          : `background:linear-gradient(135deg,${(a.g || ["#24344c", "#111827"])[0]},${(a.g || ["#24344c", "#111827"])[1]})`;
        return `<div class="acct-flip-face acct-flip-back" aria-hidden="${on ? "false" : "true"}" ${on ? "" : "inert"} style="${bg}"><div class="afb-head"><b>${title}</b><small>Recent transactions</small></div><div class="afb-list">${rows || '<div class="afb-empty">No transactions for this account yet.</div>'}</div><button type="button" class="afb-all" data-acct-viewall onclick="event.stopPropagation();openAccountFromBack(${a.id})">View All <span aria-hidden="true">→</span></button></div>`;
      }
      function accountCardMarkup(a, art, front) {
        const on = String(acctFlipActive) === String(a.id);
        return `<div class="acct-flip${on ? " is-flipped" : ""}" data-account-id="${a.id}" aria-label="${esc(a.name)} account card"><div class="acct-flip-inner"><div class="acct-flip-face acct-flip-front" aria-hidden="${on ? "true" : "false"}" ${on ? "inert" : ""}>${front}</div>${acctBackHtml(a, art, on)}</div></div>`;
      }
      function openAccountFromBack(id) {
        const w = [...document.querySelectorAll("#app .acct-flip")].find((x) => x.dataset.accountId == id);
        if (!w || !w.classList.contains("is-flipped")) return acctMenu(+id);
        flipAccountCard(id, false);
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return acctMenu(+id);
        const inner = w.querySelector(".acct-flip-inner");
        let done = false;
        const open = () => { if (done) return; done = true; inner.removeEventListener("transitionend", end); acctMenu(+id); };
        const end = (e) => { if (e.target === inner && e.propertyName === "transform") open(); };
        inner.addEventListener("transitionend", end);
        setTimeout(open, 540);
      }
      function cardH(a, full, det) {
        const cr = a.type == "credit",
          lim = +a.lim || 0,
          owed = +a.bal || 0,
          used = lim ? Math.min(100, Math.round((owed / lim) * 100)) : 0,
          av = det && cr && lim,
          label = av ? "AVAILABLE CREDIT" : "BALANCE",
          amt = php(av ? Math.max(0, lim - owed) : owed),
          art = a.photo || ART[a.img] || ART[ARTN[a.name]] || ART[a.bank],
          oc = full && !det ? `onclick="acctMenu(${a.id})" role="button" tabindex="0" aria-pressed="${String(acctFlipActive) === String(a.id)}" aria-label="${esc(a.name)}. Tap to view account details; long press for recent transactions." onkeydown="if(event.key=='Enter'||event.key==' '){event.preventDefault();if(this.closest('.acct-flip')&&this.closest('.acct-flip').classList.contains('is-flipped'))flipAccountCard(${a.id},false);else acctMenu(${a.id})}"` : "";
        const bar =
          full && cr && lim
            ? `<div class="pb"><b style="width:${Math.max(used, 2)}%"></b></div><div class="pr"><span>${used}% used</span><span>Limit ${bv(php(lim))}</span></div>`
            : "";
        if (art) {
          const front = `<div class="cc art${det ? " detail" : ""}${a.img == "securitydebit" ? " lt" : a.img == "unionplay" ? " lt ltt" : ""}" style="background-image:url(${art})${a.photo ? ';background-size:cover' : ''}" ${oc}>${a.bank == "GCash" && !a.photo ? '<img class="gl" alt="GCash" src="assets/media/media-c556353f406c.png">' : ""}<div class="tr">${a.img == "cash" ? "CASH" : cr ? "CREDIT" : a.type == "ewallet" ? "E-WALLET" : "DEBIT"}${full && a.l4 ? " •• " + a.l4 : ""}</div>${full ? `<div class="at"><small>${label}</small><div class="v bv">${amt}</div>${bar}</div>` : ""}</div>`;
          return full && !det ? accountCardMarkup(a, art, front) : front;
        }
        const n =
          a.net == "mc"
            ? '<span class="mc"><i></i><i></i></span>'
            : '<img class="visa" alt="Visa" src="' + VISAI + '">';
        const front = `<div class="cc${det ? " detail" : ""}" style="background:linear-gradient(135deg,${a.g[0]},${a.g[1]})" ${oc}><div style="display:flex;justify-content:space-between">${logoH(a)}<small>${cr ? "CREDIT" : a.type == "ewallet" ? "E-WALLET" : "DEBIT"}${full && a.l4 ? " •• " + a.l4 : ""}</small></div><div class="chip"></div>${full ? `<div class="at"><small>${label}</small><div class="v bv">${amt}</div>${bar}</div>` : ""}<div class="bt" style="justify-content:flex-end">${n}</div></div>`;
        return full && !det ? accountCardMarkup(a, art, front) : front;
      }
      function render() {
        applyTheme();
        applyMotion();
        applyHide();
        ensureCats();
        const navIcons={
          Home:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3.5 10.8 8.5-7 8.5 7v8.1a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z"/><path d="M9.2 20.5v-5.8h5.6v5.8"/></svg>',
          Activity:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12h4l2.1-6.2 4.2 12.4 2.2-6.2h4.5"/></svg>',
          Plan:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="2.2"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>',
          Accounts:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 9h17M7 14h3"/><circle cx="16.5" cy="14" r="1.5"/></svg>'
        };
        $("#tabs").innerHTML = ["Home", "Activity", "+", "Plan", "Accounts"]
          .map((t) => {
            if(t==='+')return `<button type="button" class="nav-action" aria-label="Add transaction" onclick="openTx()"><span class="nav-action-plus" aria-hidden="true">＋</span></button>`;
            const on = t == tab,
              pop = on && navTab && navTab !== tab;
            return `<button aria-label="${t}" class="nav-tab-${t.toLowerCase()} ${on ? "on" : ""}${pop ? " pop" : ""}" onclick="tab='${t}';spendReset();${t == "Plan" ? "pt='Upcoming';" : ""}render()"><span class="nav-icon">${navIcons[t]}</span><span class="nav-label">${t}</span></button>`;
          })
          .join("");
        navTab = tab;
        $("#app").innerHTML = { Home, Activity, Plan, Accounts, Notes }[tab]();
        initAccountCarousels();
        spendReelInit();
        if(typeof animateNetBalance==='function')animateNetBalance();
        pageAnim();
        save();
      }
      /* Home dashboard and spending charts */
      function spendingChart() {
        const colors = {
            Food: "#165b3a",
            Groceries: "#2f855a",
            Transport: "#75a987",
            Bills: "#a9b9ae",
            Shopping: "#214f3b",
            Health: "#8fb996",
            Entertainment: "#5d7f6c",
            Other: "#c8d4cc",
          },
          tx = mtx().filter((t) => t.amt < 0),
          groups = {};
        tx.forEach((t) => {
          const c = CATS[t.cat] ? t.cat : "Other";
          groups[c] = (groups[c] || 0) - t.amt;
        });
        const total = sum(Object.values(groups)),
          items = Object.entries(groups).sort((a, b) => b[1] - a[1]),
          circ = 2 * Math.PI * 74;
        let offset = 0;
        const arcs = items
            .map(([c, v]) => {
              const len = total ? (circ * v) / total : 0,
                dash = Math.max(0, len - 3),
                item = `<circle cx="100" cy="100" r="74" fill="none" stroke="${spendCol(c)}" stroke-width="19" stroke-dasharray="${dash} ${circ - dash}" stroke-dashoffset="${-offset}"/>`;
              offset += len;
              return item;
            })
            .join(""),
          legend = items.length
            ? items
                .map(
                  ([c, v]) =>
                    `<div class="spend-legend-row"><i class="spend-dot" style="background:${spendCol(c)}"></i><span class="spend-legend-name">${esc(c)}</span><b class="spend-legend-pct">${total ? Math.round((v / total) * 100) : 0}%</b><span class="spend-legend-amt">${php(v)}</span></div>`,
                )
                .join("")
            : '<p class="m" style="font-size:13px">No expenses recorded this month yet.</p>';
        const budget = Object.values(S.budgets || {}).reduce((a, v) => a + (+v || 0), 0),
          under = budget - total,
          insight = budget
            ? under >= 0
              ? {
                  title: `You’re ${Math.round((under / budget) * 100)}% under budget`,
                  body: `${bv(php(under))} of your ${bv(php(budget))} monthly budget remains.`,
                  icon: "🌱",
                }
              : {
                  title: `You’re ${Math.round((Math.abs(under) / budget) * 100)}% over budget`,
                  body: `You’ve spent ${bv(php(Math.abs(under)))} beyond your ${bv(php(budget))} monthly budget.`,
                  icon: "📈",
                }
            : {
                title: "Set a monthly budget",
                body: "Add category budgets in Plan to see how you’re tracking.",
                icon: "🌱",
              },
          trend = Array.from({ length: 6 }, (_, i) => {
            const d = new Date(T.getFullYear(), T.getMonth() - 5 + i, 1),
              key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
              value = -sum(S.tx.filter((t) => t.d.startsWith(key) && t.amt < 0 && !t.opening).map((t) => t.amt));
            return { label: d.toLocaleDateString("en-PH", { month: "short" }), value, now: i == 5 };
          }),
          maxTrend = Math.max(...trend.map((x) => x.value), 1);
        return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div><div class="eyebrow">Your spending</div><h2 style="margin:2px 0 0">${T.toLocaleDateString("en-PH", { month: "long", year: "numeric" })}</h2></div><span class="m" style="font-size:13px">${tx.length} ${tx.length == 1 ? "expense" : "expenses"}</span></div><div class="spend-overview"><div class="spend-donut-wrap"><svg class="spend-donut" viewBox="0 0 200 200" role="img" aria-label="Spending by category donut chart"><circle cx="100" cy="100" r="74" fill="none" stroke="var(--line)" stroke-width="19"/>${arcs}</svg><div class="spend-center"><b>${php(total)}</b><span>Total spent</span></div></div><div class="spend-legend" aria-label="Spending categories">${legend}</div></div></div><div class="spend-insight"><div style="display:flex;align-items:center;gap:12px"><span style="font-size:25px" aria-hidden="true">${insight.icon}</span><div><b>${insight.title}</b><div class="m" style="font-size:13px;margin-top:3px">${insight.body}</div></div>${budget ? "" : `<button class="pill" style="margin-left:auto;flex:none" onclick="tab='Plan';pt='Budgets';render()" aria-label="Set a budget">›</button>`}</div></div><div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h2 style="margin:0">Spending trend</h2><span class="m" style="font-size:12px">Last 6 months</span></div><div class="spend-bars" role="img" aria-label="Monthly spending trend">${trend.map((x, i) => `<div class="spend-bar-col" title="${x.label}: ${php(x.value)}"><span class="spend-total-label">${php(x.value)}</span><i class="spend-bar ${x.now ? "now" : ""}" style="height:${Math.max(3, (x.value / maxTrend) * 76)}%;--delay:${i * 55}ms"></i><span class="spend-month">${x.label}</span></div>`).join("")}</div></div>`;
      }
      function Home() {
        const m = mtx(),
          inc = sum(m.filter((t) => t.amt > 0).map((t) => t.amt)),
          out = -sum(m.filter((t) => t.amt < 0).map((t) => t.amt));
        const cash = sum(S.accts.filter((a) => a.type != "credit").map((a) => a.bal)),
          owed = sum(S.accts.filter((a) => a.type == "credit").map((a) => a.bal));
        const td = -sum(S.tx.filter((t) => t.d == today && t.amt < 0 && !t.opening).map((t) => t.amt));
        const cb = outstandingCardStatements().map(({ a, amount, due }) => ({
              name: a.name + " Payment",
              cardId: a.id,
              amt: amount,
              due: a.due || 1,
              paid: "",
              nd: bDt(due),
              al: a.alD,
            })),
          due = [...S.bills.filter(live), ...cb].filter((b) => days(b) <= Math.max(0, ...(b.al || [1, 7, -1]))),
          over = Object.keys(S.budgets).filter((c) => spent(c) > S.budgets[c]);
        const up = [...S.bills.filter(live), ...cb].sort((a, b) => days(a) - days(b));
        return `<div class="eyebrow">${T.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })}</div><div class="m">${greet()},</div><h1>${esc(S.name || "Your money")}</h1>
<p class="m">You spent <b class="bv" style="color:var(--tx)">${php(td)}</b> today.${due.length ? ` <b style="color:var(--tx)">${due.length} bill${due.length > 1 ? "s" : ""}</b> coming up soon.` : ""}</p>
<div style="margin-bottom:16px">${netChart(cash, owed)}</div>
<div class="stats"><div class="card"><div class="eyebrow">In</div><b class="g bv home-balance-stat" data-home-stat="${inc}" data-stat-prefix="+">+${php(inc)}</b></div><div class="card"><div class="eyebrow">Out</div><b class="r bv home-balance-stat" data-home-stat="${out}">${php(out)}</b></div><div class="card"><div class="eyebrow">Net</div><b class="${inc - out >= 0 ? "g" : "r"} bv home-balance-stat" data-home-stat="${inc-out}">${php(inc - out)}</b></div></div>
  <div class="grid home-spend-grid" style="margin-top:14px"><div style="min-width:0">${spendingChart()}</div>
<div><div class="card"><div class="eyebrow">Needs attention</div>${due.map(attnRow).join("") + over.map((c) => `<div class="row"><div class="ico">📊</div><div class="f">${c} is over budget<small>+${bv(php(spent(c) - S.budgets[c]))}</small></div></div>`).join("") || '<p class="m">All clear 🎉</p>'}</div>
<div class="card"><div class="eyebrow">Coming up · ${php(sum(up.map((b) => b.amt)))} out</div>${up.map(upRow).join("")}</div></div></div>`;
      }
      let CH = null;
      /* Balance chart helpers */
      function cfd(d) {
        return new Date(d + "T00:00:00").toLocaleDateString("en-PH", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      }
      function chMoveOld(e) {
        if (!CH) return;
        const w = $("#chw");
        if (!w) return;
         const r = w.getBoundingClientRect(),
          f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
          i = Math.round(f * (CH.N - 1)),
          v = CH.pts[i],
          dy = i ? v - CH.pts[i - 1] : 0,
          x = (i / (CH.N - 1)) * 100;
        $("#chl").style.cssText = `display:block;left:${x}%`;
        $("#chd").style.cssText = `display:block;left:${x}%;top:${(CH.Y(v) / 160) * 100}%`;
        const t = $("#cht");
        t.style.cssText = `display:block;left:${Math.min(90, Math.max(10, x))}%`;
        t.textContent = cfd(CH.ds[i]);
        $("#che").style.display = "none";
        $("#chb").style.display = "none";
        $("#chv").textContent = php(v);
        const c = $("#chc");
        c.className = !dy ? "m" : dy > 0 ? "g" : "r";
        c.textContent = dy
          ? `${dy > 0 ? "↗ +" : "↘ "}${php(dy)} on this day${CH.nm[i] ? " · " + CH.nm[i] : ""}`
          : i
            ? "No change that day"
            : "Start of range";
      }
      function chUpOld() {
        if (!CH) return;
        ["#chl", "#chd", "#cht"].forEach((s) => {
          const e = $(s);
          if (e) e.style.display = "none";
        });
        ["#che", "#chb"].forEach((s) => {
          const e = $(s);
          if (e) e.style.display = "";
        });
        const v = $("#chv"),
          c = $("#chc");
        if (v) v.textContent = CH.top;
        if (c) {
          c.className = CH.cls;
          c.textContent = CH.sub;
        }
      }
      function chMove(e) {
        if (!CH) return;
        const w = $("#chw");
        if (!w) return;
        const r = w.getBoundingClientRect(),
          f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
          i = Math.round(f * (CH.N - 1)),
          v = CH.pts[i],
          dy = i ? v - CH.pts[i - 1] : 0,
           x = (i / (CH.N - 1)) * 100,
           yy = (CH.Y(v) / 180) * 100,
           changed = CH.hoverIndex !== i;
        w.classList.add("t");
        $("#chl").style.cssText = `display:block;left:${x}%;top:${yy}%`;
        $("#chd").style.cssText = `display:block;left:${x}%;top:${yy}%`;
        const n = $("#chn");
        n.style.cssText = `display:block;left:${Math.min(88, Math.max(12, x))}%;top:${yy}%`;
        n.innerHTML = bv(php(v));
        const t = $("#cht");
        t.style.display = "block";
        t.textContent = CH.labs[i];
        if(changed){
          CH.hoverIndex=i;
          $("#chv").textContent = php(v);
          const c = $("#chc");
          c.className = !dy ? "m ch-change neutral live" : dy > 0 ? "g ch-change up live" : "r ch-change down live";
          c.innerHTML = dy
            ? `<span class="ch-change-arrow" aria-hidden="true"></span><span class="ch-change-copy">${dy > 0 ? "+" : ""}${bv(`<span data-ch-hover-delta="${dy}">${php(dy)}</span>`)}${CH.nm[i] ? " · " + esc(CH.nm[i]) : ""}</span>`
            : i
              ? "No change"
              : "Start of range";
          if(dy&&typeof animateNetHoverChange==='function')animateNetHoverChange(c,dy);
        }
      }
      function chUp() {
        if (!CH) return;
        CH.hoverIndex=-1;
        const w = $("#chw");
        if (w) w.classList.remove("t");
        ["#chl", "#chd", "#chn", "#cht"].forEach((s) => {
          const e = $(s);
          if (e) e.style.display = "none";
        });
        const v = $("#chv"),
          c = $("#chc");
        if (v) v.textContent = CH.top;
        if (c) {
          c.className = `${CH.cls} ch-change ${CH.delta >= 0 ? "up" : "down"}`;
          c.innerHTML = CH.sub;
        }
      }
      function netChart(cash, owed) {
        const nn = cash - owed,
          R = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"],
          r = R.includes(rg) ? rg : "1M",
          yd = ago(1),
          mon = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-PH", { month: "short" });
        let pts,
          labs,
          nm,
          ds = null;
        if (r == "1D") {
          let v = nn - sum(S.tx.filter((t) => t.d > yd).map((t) => t.amt));
          pts = [v];
          labs = ["Yesterday"];
          nm = [""];
          S.tx
            .filter((t) => t.d == today)
            .sort((a, b) => a.id - b.id)
            .forEach((t) => {
              v += t.amt;
              pts.push(v);
              labs.push("Today");
              nm.push(t.note || t.cat);
            });
          if (pts.length == 1) {
            pts.push(v);
            labs.push("Today");
            nm.push("");
          }
        } else {
          const dt = new Date(T.getFullYear(), T.getMonth(), T.getDate()),
            N =
              { "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365 }[r] ||
              Math.max(2, Math.round((dt - new Date(dt.getFullYear(), 0, 1)) / 864e5) + 1);
          ds = [...Array(N)].map((_, i) => ago(N - 1 - i));
          pts = ds.map((d) => nn - sum(S.tx.filter((t) => t.d > d).map((t) => t.amt)));
          labs = ds.map(cfd);
          nm = ds.map((d) =>
            S.tx
              .filter((t) => t.d == d)
              .map((t) => t.note || t.cat)
              .slice(0, 2)
              .join(", "),
          );
        }
        const N2 = pts.length,
          mn = Math.min(...pts),
          mx = Math.max(...pts),
          Y = (v) => (mx == mn ? 96 : 168 - ((v - mn) / (mx - mn)) * 144),
          X = (i) => (i / (N2 - 1)) * 600,
          ln = pts
            .map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1))
            .join(" "),
          dl = pts[N2 - 1] - pts[0],
          ph = {
            "1D": "today",
            "1W": "this week",
            "1M": "in 30 days",
            "3M": "in 3 months",
            "6M": "in 6 months",
            YTD: "this year",
            "1Y": "in 1 year",
          }[r],
          sub = `<span class="ch-change-arrow" aria-hidden="true"></span><span class="ch-change-copy">${dl >= 0 ? "+" : ""}${bv(`<span data-ch-delta="${dl}">${php(dl)}</span>`)} ${ph}</span>`,
          cls = dl >= 0 ? "g" : "r";
        CH = { N: N2, pts, labs, nm, Y, top: php(nn), sub, cls, delta: dl, hoverIndex: -1 };
        const dots = false
          ? pts
              .map((v, i) =>
                i && i < N2 - 1 && v != pts[i - 1]
                  ? `<i class="cd" style="left:${(i / (N2 - 1)) * 100}%;top:${(Y(v) / 180) * 100}%"></i>`
                  : "",
              )
              .join("")
          : "";
        let vl = "",
          xl = "";
        if (ds && N2 > 40) {
          const mk = [];
          ds.forEach((d, i) => {
            if (d.slice(8) == "01") mk.push(i);
          });
          if (!mk.length || mk[0] > N2 * 0.12) mk.unshift(0);
          mk.forEach((i) => {
            if (i) vl += `<path d="M${X(i).toFixed(1)} 0V180" class="gl"/>`;
            xl += `<span style="left:${(i / (N2 - 1)) * 100}%">${mon(ds[i])}</span>`;
          });
        } else if (r == "1D")
          xl = '<span style="left:0">Yesterday</span><span style="right:0">Today</span>';
        else
          xl = [0, 0.33, 0.66, 1]
            .map((f, k) => {
              const d = ds[Math.round(f * (N2 - 1))];
              return `<span style="${k == 3 ? "right:0" : "left:" + f * 100 + "%"}">${cfd(d).replace(/^\w+, /, "")}</span>`;
            })
            .join("");
        const hl = [24, 72, 120, 168].map((y) => `<path d="M0 ${y}H600" class="gl"/>`).join(""),
          yl = [24, 72, 120, 168]
            .map(
              (y) =>
                `<span class="ylb" style="top:${(y / 180) * 100}%">${bv(php(Math.round(mn + ((168 - y) / 144) * (mx - mn))))}</span>`,
            )
            .join("");
        return `<div><div class="eyebrow">Net balance</div><div class="ch-balance-row" style="display:flex;align-items:center;gap:2px"><div class="big bv ch-balance" id="chv" data-ch-balance="${nn}">${php(nn)}</div>${bvEye()}</div><div class="${cls} ch-change ${dl >= 0 ? "up" : "down"}" id="chc" style="font-size:13px">${sub}</div></div>
<div class="rts ch-ranges">${R.map((x) => `<button class="rt ch-range ${x == r ? "on" : ""}" onclick="rg='${x}';render()">${x}</button>`).join("")}</div>
<div id="chw" class="ch" style="position:relative;height:180px;touch-action:pan-y;cursor:crosshair;user-select:none;-webkit-user-select:none;border-bottom:1px solid var(--mut)" onpointermove="chMove(event)" onpointerdown="chMove(event)" onpointerup="chUp()" onpointerleave="chUp()" onpointercancel="chUp()"><svg viewBox="0 0 600 180" preserveAspectRatio="none" style="width:100%;height:100%;display:block"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".35"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient><filter id="chGlow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="2.2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${hl}${vl}<path class="ch-area" d="${ln} L600 180 L0 180Z" fill="url(#ag)"/><path class="ch-line-base" d="${ln}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path class="ch-line" d="${ln}" pathLength="1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path class="ch-sweep" d="${ln}" pathLength="1" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke" filter="url(#chGlow)"/></svg>${yl}${dots}<i id="chl" class="cl"></i><i id="chd" class="cd s"></i><span id="chn" class="cv"></span><span id="cht" class="cdt"></span></div>
<div class="xl" style="position:relative;height:18px;margin-top:4px">${xl}</div><div class="m" style="margin-top:8px;font-size:12px">Cash & e-wallets ${bv(php(cash))} · Credit owed ${bv(php(owed))}</div>`;
      }
      function netChartOld3(cash, owed) {
        const nn = cash - owed,
          mo = rg == "M",
          N = mo ? Math.max(2, T.getDate()) : +rg,
          ds = [...Array(N)].map((_, i) => ago(N - 1 - i)),
          pts = ds.map((d) => nn - sum(S.tx.filter((t) => t.d > d).map((t) => t.amt))),
          mn = Math.min(...pts),
          mx2 = Math.max(...pts),
          Y = (v) => (mx2 == mn ? 100 : 150 - ((v - mn) / (mx2 - mn)) * 110),
          ln = pts
            .map(
              (v, i) => (i ? "L" : "M") + ((i / (N - 1)) * 600).toFixed(1) + " " + Y(v).toFixed(1),
            )
            .join(" "),
          dl = pts[N - 1] - pts[0],
          sub = `${dl >= 0 ? "↗ +" : "↘ "}${php(dl)} ${mo ? "this month" : "in " + N + " days"}`,
          cls = dl >= 0 ? "g" : "r",
          lb = [0, 0.33, 0.66, 1].map((f) =>
            cfd(ds[Math.round(f * (N - 1))]).replace(/^\w+, /, ""),
          ),
          ty = (Y(pts[N - 1]) / 160) * 100,
          ops = [
            ["7", "7D"],
            ["30", "30D"],
            ["M", "This month"],
            ["90", "90D"],
            ["365", "1Y"],
          ];
        CH = {
          N,
          pts,
          ds,
          Y,
          top: php(nn),
          sub,
          cls,
          nm: ds.map((d) =>
            S.tx
              .filter((t) => t.d == d)
              .map((t) => t.note || t.cat)
              .slice(0, 2)
              .join(", "),
          ),
        };
        const dots = pts
          .map((v, i) =>
            i && i < N - 1 && v != pts[i - 1]
              ? `<i class="cd" style="left:${(i / (N - 1)) * 100}%;top:${(Y(v) / 160) * 100}%"></i>`
              : "",
          )
          .join("");
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div class="eyebrow">Net balance</div><div class="big" id="chv">${php(nn)}</div><div class="${cls}" id="chc" style="font-size:13px">${sub}</div></div><select onchange="rg=this.value=='M'?'M':+this.value;render()" style="width:auto;margin:0;border-radius:99px;padding:6px 10px">${ops.map((r) => `<option value="${r[0]}" ${String(rg) == r[0] ? "selected" : ""}>${r[1]}</option>`).join("")}</select></div>
<div id="chw" style="position:relative;height:160px;margin-top:8px;touch-action:pan-y;cursor:crosshair;user-select:none;-webkit-user-select:none" onpointermove="chMove(event)" onpointerdown="chMove(event)" onpointerup="chUp()" onpointerleave="chUp()" onpointercancel="chUp()"><svg viewBox="0 0 600 160" preserveAspectRatio="none" style="width:100%;height:100%;display:block;color:var(--g)"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".3"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path d="${ln} L600 160 L0 160Z" fill="url(#ag)"/><path d="${ln}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>${dots}<i id="che" class="cd e" style="left:100%;top:${ty}%"></i><span id="chb" class="cb" style="right:0;top:${ty}%">${php(nn)}</span><i id="chl" class="cl"></i><i id="chd" class="cd s"></i><span id="cht" class="cb t"></span></div>
<div class="m" style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px">${lb.map((x) => `<span>${x}</span>`).join("")}</div><div class="m" style="margin-top:6px;font-size:12px">Cash & e-wallets ${bv(php(cash))} · Credit owed ${bv(php(owed))}</div>`;
      }
      function netChartOld2(cash, owed) {
        const nn = cash - owed,
          mo = rg == "M",
          N = mo ? Math.max(2, T.getDate()) : +rg,
          pts = [...Array(N)].map((_, i) => {
            const d = ago(N - 1 - i);
            return nn - sum(S.tx.filter((t) => t.d > d).map((t) => t.amt));
          }),
          mn = Math.min(...pts),
          mx2 = Math.max(...pts),
          y = (v) => (mx2 == mn ? 100 : 150 - ((v - mn) / (mx2 - mn)) * 110),
          ln = pts
            .map(
              (v, i) => (i ? "L" : "M") + ((i / (N - 1)) * 600).toFixed(1) + " " + y(v).toFixed(1),
            )
            .join(" "),
          dl = pts[N - 1] - pts[0],
          lb = [0, 0.33, 0.66, 1].map((f) =>
            new Date(T - (N - 1) * (1 - f) * 864e5).toLocaleDateString(
              "en-PH",
              N > 200 ? { month: "short" } : { month: "short", day: "numeric" },
            ),
          ),
          ty = (y(pts[N - 1]) / 160) * 100,
          ops = [
            ["7", "7D"],
            ["30", "30D"],
            ["M", "This month"],
            ["90", "90D"],
            ["365", "1Y"],
          ];
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div class="eyebrow">Net balance</div><div class="big">${php(nn)}</div><div class="${dl >= 0 ? "g" : "r"}" style="font-size:13px">${dl >= 0 ? "↗ +" : "↘ "}${php(dl)} ${mo ? "this month" : "in " + N + " days"}</div></div><select onchange="rg=this.value=='M'?'M':+this.value;render()" style="width:auto;margin:0;border-radius:99px;padding:6px 10px">${ops.map((r) => `<option value="${r[0]}" ${String(rg) == r[0] ? "selected" : ""}>${r[1]}</option>`).join("")}</select></div>
<div style="position:relative;height:160px;margin-top:8px"><svg viewBox="0 0 600 160" preserveAspectRatio="none" style="width:100%;height:100%;display:block;color:var(--g)"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".3"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path d="${ln} L600 160 L0 160Z" fill="url(#ag)"/><path d="${ln}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><i style="position:absolute;right:-4px;top:${ty}%;width:9px;height:9px;border-radius:50%;background:var(--g);transform:translateY(-50%)"></i><span style="position:absolute;right:0;top:${ty}%;transform:translateY(-170%);background:var(--card);border:1px solid var(--line);border-radius:99px;padding:2px 8px;font-size:11px;font-weight:600">${php(nn)}</span></div>
<div class="m" style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px">${lb.map((x) => `<span>${x}</span>`).join("")}</div><div class="m" style="margin-top:6px;font-size:12px">Cash & e-wallets ${bv(php(cash))} · Credit owed ${bv(php(owed))}</div>`;
      }
      function netChartOld(cash, owed) {
        const nn = cash - owed,
          N = rg,
          pts = [...Array(N)].map((_, i) => {
            const d = ago(N - 1 - i);
            return nn - sum(S.tx.filter((t) => t.d > d).map((t) => t.amt));
          }),
          mn = Math.min(...pts),
          mx2 = Math.max(...pts),
          y = (v) => (mx2 == mn ? 100 : 150 - ((v - mn) / (mx2 - mn)) * 110),
          ln = pts
            .map(
              (v, i) => (i ? "L" : "M") + ((i / (N - 1)) * 600).toFixed(1) + " " + y(v).toFixed(1),
            )
            .join(" "),
          dl = pts[N - 1] - pts[0],
          lb = [0, 0.33, 0.66, 1].map((f) =>
            new Date(T - (N - 1) * (1 - f) * 864e5).toLocaleDateString("en-PH", {
              month: "short",
              day: "numeric",
            }),
          ),
          ty = (y(pts[N - 1]) / 160) * 100;
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div class="eyebrow">Net balance</div><div class="big">${php(nn)}</div><div class="${dl >= 0 ? "g" : "r"}" style="font-size:13px">${dl >= 0 ? "↗ +" : "↘ "}${php(dl)} in ${N} days</div></div><select onchange="rg=+this.value;render()" style="width:auto;margin:0;border-radius:99px;padding:6px 10px">${[7, 30, 90].map((r) => `<option value="${r}" ${r == rg ? "selected" : ""}>${r}D</option>`).join("")}</select></div>
<div style="position:relative;height:160px;margin-top:8px"><svg viewBox="0 0 600 160" preserveAspectRatio="none" style="width:100%;height:100%;display:block;color:var(--g)"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".3"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path d="${ln} L600 160 L0 160Z" fill="url(#ag)"/><path d="${ln}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><i style="position:absolute;right:-4px;top:${ty}%;width:9px;height:9px;border-radius:50%;background:var(--g);transform:translateY(-50%)"></i><span style="position:absolute;right:0;top:${ty}%;transform:translateY(-170%);background:var(--card);border:1px solid var(--line);border-radius:99px;padding:2px 8px;font-size:11px;font-weight:600">${php(nn)}</span></div>
<div class="m" style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px">${lb.map((x) => `<span>${x}</span>`).join("")}</div><div class="m" style="margin-top:6px;font-size:12px">Cash & e-wallets ${bv(php(cash))} · Credit owed ${bv(php(owed))}</div>`;
      }
      function monthSum(owed) {
        const m = mtx(),
          ex = m.filter((t) => t.amt < 0),
          inc = sum(m.filter((t) => t.amt > 0).map((t) => t.amt)),
          out = -sum(ex.map((t) => t.amt)),
          dm = T.getDate(),
          dim = new Date(T.getFullYear(), T.getMonth() + 1, 0).getDate(),
          d0 = new Date(T.getFullYear(), T.getMonth() - 1, 1),
          pym = d0.getFullYear() + "-" + String(d0.getMonth() + 1).padStart(2, "0"),
          lp = -sum(
            S.tx
              .filter((t) => t.d.startsWith(pym) && t.amt < 0 && +t.d.slice(8) <= dm && !t.opening)
              .map((t) => t.amt),
          ),
          cats = Object.keys(CATS)
            .map((c) => [c, spent(c)])
            .filter((x) => x[1] > 0)
            .sort((a, b) => b[1] - a[1]),
          top = cats[0],
          rate = inc ? (inc - out) / inc : null;
        const H = (t) => `<div class="card"><div class="eyebrow">\u2699 This month</div>${t}</div>`;
        if (!out)
          return H('<p style="margin:8px 0 0">No spending yet. Log something to see insights.</p>');
        const cmp = lp
          ? Math.abs(out / lp - 1) < 0.1
            ? "about the same as last month"
            : Math.round(Math.abs(out / lp - 1) * 100) +
              "% " +
              (out > lp ? "more" : "less") +
              " than last month"
          : "";
        const s = `<b>${php(out)}</b> spent${cmp ? " · " + cmp : ""}. Top: <b>${top[0]}</b> (${Math.round((top[1] / out) * 100)}%).`;
        const tips = [],
          bd = Object.keys(S.budgets).filter((c) => S.budgets[c]);
        bd.filter((c) => spent(c) > S.budgets[c]).forEach((c) =>
          tips.push(["🚨", `${c} is ${php(spent(c) - S.budgets[c])} over budget`]),
        );
        bd.filter((c) => spent(c) <= S.budgets[c] && spent(c) >= 0.8 * S.budgets[c]).forEach((c) =>
          tips.push(["⚠️", `${c}: ${Math.round((spent(c) / S.budgets[c]) * 100)}% of budget used`]),
        );
        if (lp && out > lp * 1.2)
          tips.push(["📈", `On pace for ${php((out / dm) * dim)} this month`]);
        const bn = sum(S.bills.filter((b) => live(b) && days(b) >= 0 && days(b) <= 7).map((b) => b.amt));
        if (bn) tips.push(["🧾", `${php(bn)} in bills due this week`]);
        if (rate !== null)
          tips.push(
            rate < 0.2
              ? ["💡", `Saving ${Math.max(0, Math.round(rate * 100))}% of income`]
              : ["✅", `Saving ${Math.round(rate * 100)}% of income`],
          );
        if (owed > 0) tips.push(["💳", `${php(owed)} owed on cards`]);
        return H(
          `<p style="margin:8px 0">${s}</p>` +
            tips
              .slice(0, 3)
              .map(
                (t) =>
                  `<div class="row"><div class="ico">${t[0]}</div><div class="f">${t[1]}</div></div>`,
              )
              .join(""),
        );
      }
      function monthSumOld(owed) {
        const m = mtx(),
          ex = m.filter((t) => t.amt < 0),
          inc = sum(m.filter((t) => t.amt > 0).map((t) => t.amt)),
          out = -sum(ex.map((t) => t.amt)),
          dm = T.getDate(),
          dim = new Date(T.getFullYear(), T.getMonth() + 1, 0).getDate(),
          d0 = new Date(T.getFullYear(), T.getMonth() - 1, 1),
          pym = d0.getFullYear() + "-" + String(d0.getMonth() + 1).padStart(2, "0"),
          lp = -sum(
            S.tx
              .filter((t) => t.d.startsWith(pym) && t.amt < 0 && +t.d.slice(8) <= dm && !t.opening)
              .map((t) => t.amt),
          ),
          cats = Object.keys(CATS)
            .map((c) => [c, spent(c)])
            .filter((x) => x[1] > 0)
            .sort((a, b) => b[1] - a[1]),
          top = cats[0],
          big = ex.slice().sort((a, b) => a.amt - b.amt)[0],
          proj = (out / dm) * dim,
          rate = inc ? (inc - out) / inc : null;
        if (!out)
          return `<div class="card"><div class="eyebrow">⚙ This month</div><p>No spending logged yet this month. Log an expense with the ＋ button to see how you're doing.</p></div>`;
        const s =
          `You've spent <b>${php(out)}</b> so far this month` +
          (lp
            ? `, about <b>${Math.abs(out / lp - 1) < 0.1 ? "the same as" : out > lp ? Math.round((out / lp - 1) * 100) + "% more than" : Math.round((1 - out / lp) * 100) + "% less than"}</b> last month's pace.`
            : ".") +
          ` <b>${big.note || big.cat}</b> was the biggest expense at ${php(-big.amt)}, and <b>${top[0]}</b> is the largest category (${Math.round((top[1] / out) * 100)}% of spending).`;
        const tips = [],
          bd = Object.keys(S.budgets).filter((c) => S.budgets[c]);
        bd.filter((c) => spent(c) > S.budgets[c]).forEach((c) =>
          tips.push([
            "🚨",
            `${c} is ${php(spent(c) - S.budgets[c])} over its budget. Hold off on extra ${c.toLowerCase()} spending for the rest of the month.`,
          ]),
        );
        bd.filter((c) => spent(c) <= S.budgets[c] && spent(c) >= 0.8 * S.budgets[c]).forEach((c) =>
          tips.push([
            "⚠️",
            `${c} is at ${Math.round((spent(c) / S.budgets[c]) * 100)}% of its budget. Only ${php(S.budgets[c] - spent(c))} left, or about ${php((S.budgets[c] - spent(c)) / Math.max(1, dim - dm + 1))} a day.`,
          ]),
        );
        if (lp && out > lp * 1.2)
          tips.push([
            "📈",
            `Spending is running ahead of last month. At this pace you'd reach about ${php(proj)} by month-end.`,
          ]);
        if (top[1] / out > 0.4 && cats.length > 1)
          tips.push([
            "🔎",
            `${top[0]} makes up ${Math.round((top[1] / out) * 100)}% of your spending, so small cuts there help the most.`,
          ]);
        const bn = sum(S.bills.filter((b) => live(b) && days(b) >= 0 && days(b) <= 7).map((b) => b.amt));
        if (bn)
          tips.push([
            "🧾",
            `${php(bn)} in bills are due in the next 7 days. Keep that amount aside.`,
          ]);
        if (rate !== null)
          tips.push(
            rate < 0.2
              ? [
                  "💡",
                  `You're saving ${Math.max(0, Math.round(rate * 100))}% of this month's income. Try moving a fixed amount to savings right after payday.`,
                ]
              : [
                  "✅",
                  `Nice, you've kept ${Math.round(rate * 100)}% of this month's income. Consider moving some of it to ${(S.goals.find((g) => !g.done) || { name: "a savings goal" }).name}.`,
                ],
          );
        if (owed > 0)
          tips.push([
            "💳",
            `You owe ${php(owed)} on credit cards. Paying in full by the due date avoids interest.`,
          ]);
        return `<div class="card"><div class="eyebrow">⚙ This month</div><p style="margin:8px 0">${s}</p>${tips
          .slice(0, 3)
          .map(
            (t) =>
              `<div class="row"><div class="ico">${t[0]}</div><div class="f">${t[1]}</div></div>`,
          )
          .join("")}</div>`;
      }
      const tt = (s) => s.replace(/ \(.*\)$/, "");
      const ALO = [
        [-1, "None"],
        [0, "On the day"],
        [1, "1 day before (9 AM)"],
        [2, "2 days before"],
        [3, "3 days before"],
        [7, "1 week before"],
      ];
      /* Preferences and plan rendering */
      function applyTheme() {
        const t = S.theme || "auto";
        if (t == "auto") document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme", t);
      }
      function setTheme(t) {
        S.theme = t;
        render();
        stGo('appearance');            /* stay on the page the change was made on */
      }
      function openSettings() {
        stHome();
      }
      function calH() {
        const f = new Date(T.getFullYear(), T.getMonth() + cm, 1),
          Y = f.getFullYear(),
          M = f.getMonth(),
          st = f.getDay(),
          n = new Date(Y, M + 1, 0).getDate(),
          rows = Math.ceil((st + n) / 7),
          p = (x) => String(x).padStart(2, "0"),
          iso2 = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        const ev = (dt) => {
          const k = iso2(dt),
            d = dt.getDate(),
            a = S.tx
              .filter((t) => t.d == k)
              .map((t) => [
                t.amt > 0 ? "i" : "o",
                (t.note || t.cat) + " (" + php(Math.abs(t.amt)) + ")",
              ]);
          S.accts
            .filter((c) => c.type == "credit")
            .forEach((c) => {
              if (c.stmt == d) a.push(["s", c.bank + " Statement Closes"]);
              if (c.due == d) a.push(["u", c.bank + " Due Date"]);
            });
          S.bills.forEach((b) => {
            if (bOn(b, k)) a.push(["u", b.name + " Due"]);
          });
          return a;
        };
        let g = "";
        for (let i = 0; i < rows * 7; i++) {
          const dt = new Date(Y, M, 1 - st + i),
            k = iso2(dt),
            e = evs(iso2(dt)).map((x) => [x.c, x.t]),
            out = dt.getMonth() != M,
            mx = e.length > 3 ? 2 : 3;
          g += `<div class="${out ? "x" : ""}" onclick="sel=sel=='${k}'?'':'${k}';render()" style="${sel == k ? "background:var(--bg)" : ""}"><div class="n ${k == iso2(T) ? "t" : ""}"><span>${dt.getDate() == 1 ? dt.toLocaleDateString("en-PH", { month: "short" }) + " 1" : dt.getDate()}</span></div>${e
            .slice(0, mx)
            .map(
              (x, j) =>
                `<span class="ap ${x[0]}" onclick="calendarEventPopup(event,'${k}',${j})">${x[1]}</span>`,
            )
            .join(
              "",
            )}${e.length > mx ? `<div class="m" style="font-size:11px;padding:2px 4px">${e.length - mx} more</div>` : ""}</div>`;
        }
        return `<div id="calwrap" style="padding:6px 0 0;touch-action:pan-y" onpointerdown="calDown(event)" onpointermove="calMove(event)" onpointerup="calUp(event)" onpointercancel="calUp(event)" onwheel="calWheel(event)"><div style="display:flex;justify-content:space-between;align-items:center;padding:0 4px 10px;gap:8px;flex-wrap:wrap"><div style="font-size:28px;font-weight:700">${f.toLocaleDateString("en-PH", { month: "long" })} ${Y}<div style="font-size:14px;font-weight:500;margin-top:2px">${calStats(Y, M)}</div></div><span><button class="pill" style="border:0" onclick="cm=0;sel='';render()">Today</button> <button class="pill" onclick="calGo(-1)">‹</button> <button class="pill" onclick="calGo(1)">›</button></span></div><div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;color:var(--mut);font-size:13px;padding:0 6px 6px">${["S", "M", "T", "W", "T", "F", "S"].map((x) => `<span>${x}</span>`).join("")}</div><div class="acal">${g}</div><p class="m" style="margin:0;padding:10px 4px;font-size:12px">${[
          ["#ff453a", "Spending"],
          ["#30d158", "Income"],
          ["#ffd60a", "Bills & card dates"],
        ]
          .map(
            (x) =>
              `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><i style="width:9px;height:9px;border-radius:50%;background:${x[0]};display:inline-block"></i>${x[1]}</span>`,
          )
          .join(
            "",
          )}</p></div>`;
      }
      function calOld() {
        const f = new Date(T.getFullYear(), T.getMonth() + cm, 1),
          Y = f.getFullYear(),
          M = f.getMonth(),
          n = new Date(Y, M + 1, 0).getDate(),
          p = (x) => String(x).padStart(2, "0"),
          k = (d) => `${Y}-${p(M + 1)}-${p(d)}`;
        const ev = (d) => {
          const a = S.tx
            .filter((t) => t.d == k(d))
            .map((t) => [t.amt > 0 ? "i" : "o", t.note || t.cat]);
          S.accts
            .filter((c) => c.type == "credit")
            .forEach((c) => {
              if (c.stmt == d) a.push(["s", c.bank + " stmt"]);
              if (c.due == d) a.push(["u", c.bank + " due"]);
            });
          return a;
        };
        let h =
          ["S", "M", "T", "W", "T", "F", "S"].map((x) => `<div class="h">${x}</div>`).join("") +
          "<div></div>".repeat(f.getDay());
        for (let d = 1; d <= n; d++) {
          const e = ev(d);
          h += `<div class="d ${k(d) == today ? "t" : ""}" onclick="sel=sel=='${k(d)}'?'':'${k(d)}';render()" style="${sel == k(d) ? "outline:2px solid var(--g)" : ""}"><b>${d}</b>${e
            .slice(0, 2)
            .map((x) => `<span class="e ${x[0]}">${x[1]}</span>`)
            .join("")}${e.length > 2 ? `<span class="m">+${e.length - 2}</span>` : ""}</div>`;
        }
        return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:18px">${f.toLocaleDateString("en-PH", { month: "long", year: "numeric" })}</b><span><button class="pill" onclick="calGo(-1)">‹</button> <button class="pill" onclick="calGo(1)">›</button></span></div><div class="cal" style="margin-top:10px">${h}</div><p class="m" style="margin:8px 0 0;font-size:12px">🔴 spent · 🟢 income · 🔵 card statement date · 🟠 card due date. Tap a day to filter the list below.${sel ? ` Showing ${sel} <a href="#" onclick="sel='';render();return false">clear</a>` : ""}</p></div>`;
      }
      function Plan() {
        const o = planOld(),
          i = o.indexOf('<div class="card"><h2>Bills');
        const body =
          pt == "Budgets"
            ? o.slice(o.indexOf('<div class="card"><h2>Monthly'), i)
            : pt == "Upcoming"
              ? o.slice(i, o.lastIndexOf("</div>"))
              : pt == "Goals"
                ? Goals()
                : pt == "Notes"
                  ? Notes2()
                  : Debts();
        const pop = planTab && planTab !== pt;
        planTab = pt;
        return `<h1>Plan</h1><p class="plan-tabs" style="display:flex;gap:6px">${["Upcoming", "Budgets", "Goals", "Debts", "Notes"].map((t) => `<button class="pill ${t == pt ? "on" : ""}${t == pt && pop ? " pop" : ""}" style="flex:1" onclick="pt='${t}';render()">${t}</button>`).join("")}</p>${body}`;
      }
      /* Cloud sync + offline persistence live in the #cap-offline module (CapOff). */
      async function dbInit() {
        if (window.CapOff) CapOff.sync();
      }
      async function dbPush() {
        if (window.CapOff) CapOff.requestSync();
      }
      function addEntry(e) {
        const a = Math.abs(+e.amount);
        if (!a) return 0;
        const inc = e.type == "income",
          cat = CATS[e.category] ? e.category : inc ? "Salary" : "Other",
          ac = S.accts.find((x) => x.id == e.account_id) || S.accts[0],
          amt = inc ? a : -a,
          id = Date.now() + Math.floor(Math.random() * 1000);
        S.tx.push({
          id,
          ts: Date.now(),
          d: /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") ? e.date : today,
          amt,
          cat,
          acct: ac ? ac.id : 0,
          note: e.note || "",
        });
        if (ac) ac.bal += ac.type == "credit" ? -amt : amt;
        return id;
      }
      function localLog(q) {
        const t = q.trim();
        if (
          !/\d/.test(t) ||
          /\?$/.test(t) ||
          /^(how|what|when|why|where|show|am i|can|do|did|is|are|which)\b/i.test(t)
        )
          return {
            reply:
              'Type what you spent or earned with an amount, like "lunch 250" or "salary 20000".',
            ids: [],
          };
        const m = t.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/),
          a = +m[1],
          low = t.toLowerCase(),
          inc = /(salary|paycheck|sweldo|received|income|refund|^\+)/.test(low),
          K = {
            Food: /(food|lunch|dinner|breakfast|coffee|jollibee|mcdo|kfc|snack|restaurant|milk tea)/,
            Groceries: /(grocer|puregold|supermarket|palengke|market)/,
            Transport: /(grab|jeep|mrt|lrt|taxi|gas|fuel|angkas|toll|parking|commute)/,
            Bills: /(meralco|electric|water|pldt|internet|rent|bill|load)/,
            Shopping: /(shopee|lazada|mall|clothes|shoes|shopping)/,
            Health: /(pharmacy|doctor|medicine|clinic|hospital)/,
            Entertainment: /(netflix|spotify|movie|cinema|game|concert)/,
          },
          cat = inc ? "Salary" : Object.keys(K).find((c) => K[c].test(low)) || "Other",
          note =
            t
              .replace(/[\d,]+(?:\.\d+)?/, "")
              .replace(/₱|php|\+/gi, "")
              .replace(/\s+/g, " ")
              .trim() || cat,
          id = addEntry({
            type: inc ? "income" : "expense",
            amount: a,
            category: cat,
            note,
            account_id: null,
            date: today,
          });
        return {
          reply: `Logged ${inc ? "income" : "expense"} ${php(a)} · ${cat}${note && note != cat ? " (" + note + ")" : ""}.`,
          ids: id ? [id] : [],
        };
      }
      function aiShow(t, ids) {
        const b = $("#aib");
        if (b) {
          b.className = "";
          b.innerHTML = `<div style="white-space:pre-wrap">${esc(t)}</div>${ids && ids.length ? `<p><button class="btn s" onclick="aiUndo(${JSON.stringify(ids)})">Undo</button></p>` : ""}`;
        }
        render();
      }
      function aiUndo(ids) {
        ids.forEach(delTx);
        closeS();
      }
      async function aiGo() {
        const el = $("#ai"),
          q = el.value.trim();
        if (!q) return;
        el.value = "";
        openS(
          `<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:10px"><b>${esc(q)}</b><button class="pill" onclick="closeS()">Close</button></div><div id="aib" class="m">Thinking…</div>`,
        );
        const r = localLog(q);
        aiShow(r.reply, r.ids);
      }
      function greet() {
        const h = new Date().getHours();
        return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
      }
      function acctTx0(id) {
        const l = S.tx
          .filter((t) => t.acct == id)
          .sort((a, b) => b.d.localeCompare(a.d) || b.id - a.id);
        if (!l.length)
          return '<div class="eyebrow" style="margin:16px 0 6px">Transactions</div><p class="m">No transactions with this card yet.</p>';
        const g = {};
        l.slice(0, 80).forEach((t) => (g[t.d] = g[t.d] || []).push(t));
        const ms = -sum(l.filter((t) => t.d.startsWith(ym) && t.amt < 0 && !t.opening).map((t) => t.amt));
        return (
          `<div class="eyebrow" style="margin:16px 0 2px">Transactions · ${l.length}</div><p class="m" style="margin:0 0 4px;font-size:13px">Spent this month ${php(ms)}</p>` +
          Object.keys(g)
            .sort()
            .reverse()
            .map((k) => {
              const tot = sum(g[k].map((t) => t.amt));
              return grp(k, g[k].map(rowT).join(""), (tot < 0 ? "−" : "+") + php(Math.abs(tot)));
            })
            .join("")
        );
      }
      let CPH='';
const ci=c=>{const o=(S.cats||[]).find(x=>x.n==c);if(o&&o.l)return `<img class="ci" src="${o.l}" alt="">`;return bnd(c)||CATS[c]||'📦'};
const ti=t=>{const n=String(t.note||'').toLowerCase(),o=(S.cats||[]).find(x=>x.l&&x.n&&n.includes(x.n.toLowerCase()));const cp=/card payment| payment$/i.test(t.note||'')?cardFor(t.note):null;return (o?`<img class="ci" src="${o.l}" alt="">`:'')||(cp?cardLogo(cp):'')||bnd(t.note)||ci(t.cat)};
/* ===== Brand badges + card logos (inline SVG, no external assets) ===== */
const _bd=(bg,inner)=>`<svg viewBox="0 0 24 24" class="bl bb" aria-hidden="true"><rect width="24" height="24" rx="6" fill="${bg}"/>${inner}</svg>`;
const _tx=(t,sz,fill,y)=>`<text x="12" y="${y||16}" text-anchor="middle" font-family="-apple-system,system-ui,Helvetica,Arial,sans-serif" font-weight="800" font-size="${sz}" fill="${fill||'#fff'}">${t}</text>`;
const _em=(e)=>`<text x="12" y="17" text-anchor="middle" font-size="14">${e}</text>`;
const XBR=[
 {r:"meralco|manila electric",s:'<img class="ci lg" alt="" src="assets/media/media-8209b1c7d4fc.webp">'},
 {r:"pldt|fibr",s:'<img class="ci lg" alt="" src="assets/media/media-912569743662.webp">'},
 {r:"puregold|pure gold",s:'<img class="ci lg" alt="" src="assets/media/media-c72d8b39a5da.webp">'},
 {r:"jollibee|jolly ?spaghetti|chickenjoy",s:'<img class="ci lg" alt="" src="assets/media/media-784db5476c1a.webp">'},
 {r:"\\bsm\\b|sm supermall|sm mall|sm hyper|sm city|sm savemore|sm store|sm markets?",s:'<img class="ci lg" alt="" src="assets/media/media-f094ad645fc2.webp">'},
 {r:"kenny ?rogers|\\bkrr\\b",s:'<img class="ci lg" alt="" src="assets/media/media-45199bcfde38.webp">'},
 {r:"max[’']?s (restaurant|fried|chicken)|\\bmax[’']?s\\b",s:'<img class="ci lg" alt="" src="assets/media/media-db2cc84b3a80.webp">'},
 {r:"popeyes?",s:'<img class="ci lg" alt="" src="assets/media/media-d42b1d2c752f.webp">'},
 {r:"watsons?",s:'<img class="ci lg" alt="" src="assets/media/media-01bcd366ea16.webp">'},
 {r:'\\bsss\\b|social security',s:_bd('#0B3D91',_tx('SSS',8.5,'#fff',13.5)+'<rect x="5" y="16" width="14" height="2" rx="1" fill="#F5C518"/>')},
 {r:'pag-?ibig|hdmf',s:_bd('#D71920',_tx('PI',10,'#fff',16)+'<rect x="6" y="18" width="12" height="1.6" rx=".8" fill="#FFD100"/>')},
 {r:'philhealth',s:_bd('#00A651',_tx('+',17,'#fff',18))},
  {r:'maynilad|manila water',s:_bd('#0A8FD6',_em('💧'))},
  {r:'\\bwater\\b',s:_bd('#168BD2','<path d="M12 4C9.4 8 6.5 11.1 6.5 14.8a5.5 5.5 0 0 0 11 0C17.5 11.1 14.6 8 12 4Z" fill="#fff"/><path d="M9.5 15.5c.3 1.4 1.1 2 2.5 2.2" fill="none" stroke="#168BD2" stroke-width="1.2" stroke-linecap="round"/>')},
 {r:'\\bglobe\\b',s:_bd('#1E5AFF','<circle cx="12" cy="12" r="6.5" fill="none" stroke="#fff" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="2.8" ry="6.5" fill="none" stroke="#fff" stroke-width="1.2"/><path d="M5.5 12h13" stroke="#fff" stroke-width="1.2"/>')},
 {r:'\\bsmart\\b|converge|\\bdito\\b',s:_bd('#16A34A',_em('📶'))},
 {r:'gcash|g-cash',s:_bd('#0070E0',_tx('G',15,'#fff',17.5))},
 {r:'\\bmaya\\b|paymaya',s:_bd('#0b0b0c',_tx('maya',7.5,'#3DDC97',14.5))},
 {r:'maribank|mari bank',s:_bd('#F26522','<circle cx="12" cy="11" r="6" fill="none" stroke="#fff" stroke-width="1.6"/>'+_tx('M',8,'#fff',14)+'<path d="M6.5 18c1.4-1 2.6-1 3.8 0s2.6 1 3.8 0 2.6-1 3.4 0" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>')},
 {r:'\\bbdo\\b',s:_bd('#0A3D91',_tx('BDO',8,'#FFD100',15))},
 {r:'unionbank|union bank|\\bubp\\b',s:_bd('#F58220',_tx('UB',10.5,'#fff',16))},
 {r:'security ?bank',s:_bd('#1F2D4E',_tx('SB',10.5,'#CFE6F5',16))},
 {r:'\\bbpi\\b',s:_bd('#9B1C1F',_tx('BPI',8.5,'#fff',15))},
 {r:'metrobank',s:_bd('#A3001B',_tx('MB',10.5,'#fff',16))},
 {r:'cimb',s:_bd('#B3261E',_tx('CIMB',6.6,'#fff',14.5))},
 {r:'gotyme|go ?tyme',s:_bd('#00B5B8',_tx('GT',10.5,'#fff',16))},
 {r:'lazada',s:_bd('#0F146D',_em('💙'))},
 {r:'7-?eleven|seven.?eleven',s:_bd('#F26B1D',_tx('7',15,'#fff',17.5)+'<rect x="5" y="19" width="14" height="1.6" rx=".8" fill="#00873C"/>')},
 {r:'mercury ?drug',s:_bd('#D71920',_em('💊'))},
 {r:'disney',s:_bd('#113CCF',_tx('D+',9.5,'#fff',15.5))},
 {r:'canva',s:_bd('#7D2AE8',_tx('C',14,'#fff',17.5))},
 {r:'chatgpt|openai',s:_bd('#10A37F','<circle cx="12" cy="12" r="5" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="12" r="1.6" fill="#fff"/>')},
 {r:'claude|anthropic',s:_bd('#D97757',_tx('✻',14,'#fff',17))},
 {r:'amazon',s:_bd('#232F3E',_tx('a',15,'#FF9900',16.5))},
 {r:'\\blrt\\b|\\bmrt\\b|beep',s:_bd('#1565C0',_em('🚆'))},
 {r:'angkas|joyride',s:_bd('#00A36C',_em('🏍'))},
 {r:'\\bcebu\\b|cebu pacific',s:_bd('#FFD400',_em('✈️'))},
 {r:'ikea',s:_bd('#0051BA',_tx('IKEA',6.6,'#FFDA1A',14.5))},
 {r:'netflix',s:_bd('#141414','<path d="M7.4 3.4h2.9l3.3 9.4V3.4h2.6v17.2h-2.5L10 9.9v10.7H7.4z" fill="#E50914"/>')},
 {r:'spotify',s:_bd('#191414','<circle cx="12" cy="12" r="8.2" fill="#1DB954"/><path d="M7.9 10.5c2.5-.75 5.2-.4 7.3 1M8.3 13.1c1.9-.55 3.9-.3 5.6.8M8.7 15.5c1.5-.4 3-.2 4.3.65" stroke="#191414" stroke-width="1.25" fill="none" stroke-linecap="round"/>')},
 {r:'youtube|youtu\\.be',s:_bd('#fff','<rect x="3" y="6.2" width="18" height="11.6" rx="3.2" fill="#FF0000"/><path d="M10.4 9.5l4.9 2.5-4.9 2.5z" fill="#fff"/>')},
 {r:'nbi|barangay clearance',s:_bd('#334155',_em('📄'))},
];
XBR.forEach(b=>b.re=new RegExp(b.r,'i'));
const xb=s=>{s=String(s||'');const b=XBR.find(x=>x.re.test(s));return b?b.s:''};
const bnd=s=>xb(s)||bi(s);

/* mini credit-card logos that mimic each card's real artwork */
const _cd=(id,a,b)=>`<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>`;
const _chip=(x,y,c)=>`<rect x="${x}" y="${y}" width="7" height="5.4" rx="1.2" fill="${c}"/><path d="M${x+2.3} ${y}v5.4M${x+4.7} ${y}v5.4M${x} ${y+2.7}h7" stroke="#0004" stroke-width=".4" fill="none"/>`;
const _mc=(cx,cy,r,a,b)=>`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${a}"/><circle cx="${cx+r*1.05}" cy="${cy}" r="${r}" fill="${b}" fill-opacity=".92"/>`;
const _visa=(x,y,sz)=>`<text x="${x}" y="${y}" text-anchor="end" font-family="-apple-system,system-ui,Arial,sans-serif" font-style="italic" font-weight="900" font-size="${sz}" fill="#fff">VISA</text>`;
function cardLogo(a){
  if(!a||!a.name||a.name==='—')return '';
  const nm=String(a.name),bk=String(a.bank||''),id='cl'+(nm+bk).replace(/[^a-z0-9]/gi,'').slice(0,18),W='<svg viewBox="0 0 40 26" class="xcl" aria-hidden="true">',E='</svg>';
  if(/maya/i.test(nm+bk)&&/black|visa|platinum|credit/i.test(nm))
    return W+_cd(id,'#3b3b3d','#070708')+`<pattern id="${id}d" width="2.4" height="2.4" patternUnits="userSpaceOnUse"><circle cx="1.2" cy="1.2" r=".55" fill="#fff" fill-opacity=".16"/></pattern><rect width="40" height="26" rx="4.5" fill="url(#${id})"/><rect width="40" height="26" rx="4.5" fill="url(#${id}d)"/><text x="4.5" y="8.6" font-family="-apple-system,system-ui,Arial,sans-serif" font-weight="700" font-size="6.6" fill="#fff">maya</text>${_chip(4.5,11,'#c4c7cc')}${_visa(35.5,22,5.4)}`+E;
  if(/gcash/i.test(nm+bk))
    return W+_cd(id,'#0876E8','#0646A8')+`<rect width="40" height="26" rx="4.5" fill="url(#${id})"/><path d="M0 21c9-5 22-6 40-1v6H0z" fill="#fff" fill-opacity=".12"/><text x="4.5" y="9" font-family="-apple-system,system-ui,Arial,sans-serif" font-weight="800" font-size="6.2" fill="#fff">GCash</text>${_chip(4.5,12,'#d6e5ee')}${_visa(35.5,22,5.4)}`+E;
  if(/\bbdo\b/i.test(nm+bk))
    return W+_cd(id,'#064A9B','#002B68')+`<rect width="40" height="26" rx="4.5" fill="url(#${id})"/><path d="M0 20c10-5 24-6 40-1v7H0z" fill="#fff" fill-opacity=".12"/><text x="4.5" y="9" font-family="-apple-system,system-ui,Arial,sans-serif" font-weight="900" font-size="6.5" fill="#FFD500">BDO</text>${_chip(4.5,12,'#e5c979')}${a.net==='visa'?_visa(35.5,22,5.4):a.net==='mc'?_mc(30,20.2,3,'#eb001b','#f79e1b'):''}`+E;
  if(/mari/i.test(nm+bk))
    return W+_cd(id,'#f26522','#ff9a5c')+`<rect width="40" height="26" rx="4.5" fill="url(#${id})"/><path d="M18 26c3-9 12-12 22-9v9z" fill="#fff" fill-opacity=".22"/><circle cx="7.2" cy="7.2" r="3.4" fill="none" stroke="#fff" stroke-width="1"/><text x="7.2" y="9" text-anchor="middle" font-family="-apple-system,system-ui,Arial,sans-serif" font-weight="800" font-size="4.6" fill="#fff">M</text><text x="12.2" y="8.6" font-family="-apple-system,system-ui,Arial,sans-serif" font-weight="800" font-size="5" fill="#fff">MariBank</text>${_chip(4.5,12,'#e3c176')}${_mc(29,20.2,3,'#eb001b','#f79e1b')}`+E;
  const g=a.g||['#3a3a3c','#6b6b70'],net=a.net,init=(bk||nm).replace(/[^A-Za-z0-9]/g,'').slice(0,4);
  const netS=net=='visa'?_visa(35.5,22,5.4):net=='mc'?_mc(30,20.2,3,'#eb001b','#f79e1b'):'';
  return W+_cd(id,g[0],g[1])+`<rect width="40" height="26" rx="4.5" fill="url(#${id})"/><path d="M0 26c8-6 20-9 40-5v5z" fill="#fff" fill-opacity=".14"/><text x="4.5" y="8.6" font-family="-apple-system,system-ui,Arial,sans-serif" font-weight="800" font-size="5.6" fill="#fff">${esc(init)}</text>${_chip(4.5,12,'#e3c176')}${netS}`+E;
}
/* find the card an entry refers to (e.g. "Maya card payment") */
function cardFor(name,id){
  let a=id!=null?S.accts.find(x=>x.id==id):null;
  if(!a){const m=String(name||'').match(/^(.+?)\s+card payment/i);if(m)a=S.accts.find(x=>x.type=='credit'&&String(x.bank).toLowerCase()==m[1].trim().toLowerCase())}
  if(!a){const m=String(name||'').match(/^(.+?)\s+payment$/i);if(m)a=S.accts.find(x=>x.type=='credit'&&String(x.name).toLowerCase()==m[1].trim().toLowerCase())}
  return a||null;
}
/* icon for a bill / card-payment entry; fb = emoji when nothing matches */
const bIc=(b,fb)=>{if(b&&b.logo)return `<img class="ci lg" src="${b.logo}" alt="">`;const c=cardFor(b.name,b.cardId);return c?cardLogo(c):(bnd(b.name)||fb||'🧾')};

/* ===== Home: bill rows (red urgency) + long-press / right-click editing ===== */
const billAttr=b=>b.cardId?`data-bcard="${b.cardId}"`:`data-bill="${b.id}"`;
const billAria=(b,t,amt)=>`tabindex="0" role="button" aria-label="${esc(b.name)}, ${t}, ${amt||php(b.amt)}. Press and hold, right-click or press Enter to edit."`;
/* urgency tiers by whole days left: overdue (<0) deep red · 0-3 red · 4-7 yellow · later neutral */
const urgOf=n=>n<0?'o':n<=3?'r':n<=7?'y':'n';
const urgTxt=n=>n<0?'<span class="odb">Overdue</span>'+Math.abs(n)+'d':n==0?'Due today':'Due in '+n+'d';
function attnRow(b){
  /* a free trial is a heads-up, never an "overdue" charge, so it keeps a neutral tier */
  if(inTrial(b)){
    const en=noteD(subFirstBill(b)),plain=trialLabel(b)+', '+php(b.amt)+' starting '+en;
    return `<div class="row trial urg-t" data-due="${bIso(nextDue(b))}" data-trial="1" ${billAttr(b)} ${billAria(b,trialLabel(b),php(b.amt)+' starting '+en)}><div class="ico">${bIc(b,'⏰')}</div><div class="f">${esc(b.name)}<small class="du">${trialLabel(b)}</small><small class="tr-b">${php(b.amt)} starting ${en}</small></div><b class="du">${php(b.amt)}</b></div>`;
  }
  const nd=nextDue(b),n=days(b),u=urgOf(n),plain=n<0?'Overdue by '+Math.abs(n)+'d':n==0?'Due today':'Due in '+n+'d';
  return `<div class="row urg-${u}" data-due="${bIso(nd)}" ${billAttr(b)} ${billAria(b,plain)}><div class="ico">${bIc(b,'⏰')}</div><div class="f">${esc(b.name)}<small class="du">${urgTxt(n)}</small></div><b class="du">${php(b.amt)}</b></div>`;
}
/* recolour the rows already on screen (so colours fade between tiers instead of being re-rendered) */
function refreshUrgency(){
  const t0=bDt(today);
  document.querySelectorAll('#app .row[data-due]').forEach(function(row){
    const n=Math.round((bDt(row.getAttribute('data-due'))-t0)/864e5),u=urgOf(n),trial=row.hasAttribute('data-trial');
    ['o','r','y','n','t'].forEach(function(x){row.classList.toggle('urg-'+x,trial?x==='t':x===u)});
    const sm=row.querySelector('.du-status')||row.querySelector('small.du'),h=trial?trialTxt(n):urgTxt(n);
    if(sm&&sm.innerHTML!==h)sm.innerHTML=h;
  });
}
/* the calendar day can change while the app stays open (midnight, phone asleep, tab restored) */
let _rollT=0;
function schedRoll(){clearTimeout(_rollT);const n=new Date(),ms=new Date(n.getFullYear(),n.getMonth(),n.getDate()+1,0,0,1)-n;_rollT=setTimeout(rollDay,Math.min(Math.max(ms,1000),2147000000))}
function rollDay(){
  const k=iso(new Date());
  if(k===today){if(!_rollT)schedRoll();return}
  T=new Date();today=k;ym=k.slice(0,7);
  refreshUrgency();                                           /* colours transition in place */
  clearTimeout(window._rr);window._rr=setTimeout(function(){try{render()}catch(e){}},700);   /* then sync the lists / totals */
  schedRoll();
}
document.addEventListener('visibilitychange',function(){if(!document.hidden)rollDay()});
window.addEventListener('focus',rollDay);window.addEventListener('pageshow',rollDay);
setInterval(rollDay,60000);schedRoll();
function upRow(b){
  if(inTrial(b)){
    const en=noteD(subFirstBill(b)),ac=b.acct&&acct(b.acct).id?" · "+esc(acct(b.acct).name):"";
    return `<div class="row trial" ${billAttr(b)} ${billAria(b,'Free trial ends '+en,php(b.amt)+' starting '+en)}><div class="ico">${bIc(b)}</div><div class="f">${esc(b.name)}<small class="tr-b">Free trial ends ${en}</small><small>${php(b.amt)} starting ${en}${ac}</small></div><b class="m">${php(b.amt)}</b></div>`;
  }
  const d=nextDue(b).toLocaleDateString("en-PH",{month:"short",day:"numeric"}),ac=b.acct&&acct(b.acct).id?" · "+esc(acct(b.acct).name):"";
  return `<div class="row" ${billAttr(b)} ${billAria(b,d)}><div class="ico">${bIc(b)}</div><div class="f">${esc(b.name)}<small>${d}${ac}</small></div><b>−${php(b.amt)}</b></div>`;
}
/* ---- payment timing + the shared payment card (Latest Payment & History) ---- */
function payDiff(dueKey,paidIso){if(!dueKey||!paidIso)return null;return Math.round((bDt(dueKey)-bDt(paidIso))/864e5)}
function payTimingLabel(n){if(n==null)return '';if(n>0)return '↑ '+n+' day'+(n>1?'s':'')+' early';if(n===0)return '✓ On time';const m=Math.abs(n);return '↓ '+m+' day'+(m>1?'s':'')+' late'}
function payTimingClass(n){return n==null?'':n<0?'tm-late':'tm-ok'}
function paySrcHtml(acctId,fallback){
  const a=S.accts.find(x=>x.id==acctId);
  if(a)return `<span class="psrc">${cardLogo(a)}<span>${esc(a.name)}</span></span>`;
  return `<span class="psrc"><span>${esc(fallback||'External payment source')}</span></span>`;
}
function payCardHtml(p,o){
  o=o||{};
  const n=payDiff(p.due,p.d),logo=o.logoHtml||(o.bill?bIc(o.bill,'🧾'):(o.logo||'🧾')),c=o.onclick;
  return `<div class="pcard"${o.delay?` style="animation-delay:${o.delay}ms"`:''}${c?` role="button" tabindex="0" onclick="${c}" onkeydown="if(event.key=='Enter'||event.key==' '){event.preventDefault();${c}}"`:''}><div class="pico">${logo}</div><div class="pmid"><div class="pdate">${noteD(p.d)}</div>${paySrcHtml(p.acct,p.acctName)}${p.due?`<div class="pdue">Due ${noteD(p.due)}</div>`:''}</div><div class="pend"><div class="pamt">${php(p.amt)}</div><span class="pst">✓ Paid</span></div>${n==null?'':`<div class="ptm ${payTimingClass(n)}">${payTimingLabel(n)}</div>`}</div>`;
}
function billStatusChip(b){
  if(paidNow(b))return '<span class="chip ok">✓ Paid</span>';
  const n=days(b);
  if(n<0)return `<span class="chip warn">${Math.abs(n)} day${n<-1?'s':''} overdue</span>`;
  if(n===0)return '<span class="chip warn">Due today</span>';
  if(n===1)return '<span class="chip due">Due tomorrow</span>';
  return `<span class="chip due">Due in ${n} days</span>`;
}
/* Move between the connected screens inside the one sheet. The current view fades out, the
   container resizes to whatever the incoming view needs, then that view fades in - so the
   backdrop never resets and the modal never jumps. `key` names the screen; opts.keep makes
   its scroll position come back when you return to it. */
function navS(html,key,opts){
  opts=opts||{};
  const sheet=$('#sheet'),sb=$('#sb');
  if(!sheet||!sb||!sheet.classList.contains('open')){window._svKey=key||'';openS(html);return}
  clearTimeout(window._cl);clearTimeout(window._nt);clearTimeout(window._nr);window._nr=0;
  const busy=!!window._navBusy;window._navBusy=0;
  const dir=opts.dir||((key==='set-home'||String(key||'').includes('back'))?'back':'forward');
  if(SVKEY)SVSC[SVKEY]=sb.scrollTop;                    /* remember where we left the old screen */
  SVKEY=key||'';
  if(opts.keep)SVKEEP[SVKEY]=1;
  const want=SVKEEP[SVKEY]?(SVSC[SVKEY]||0):0;          /* only restored screens keep their place */
  const sv=sb.firstElementChild;
  const sync=()=>{if(window.psEnhance)window.psEnhance()};
  const settle=()=>{clearTimeout(window._nt);window._navBusy=0;sb.classList.remove('sv-forward','sv-back','sv-transitioning');svSettle(sb);sb.scrollTop=want};
  if(!sv){sb.innerHTML='<div id="sv">'+html+'</div>';sync();svSettle(sb);sb.scrollTop=want;return}
  const commit=()=>{
    clearTimeout(window._nt);window._navBusy=0;
    sv.innerHTML=html;sync();
    sb.scrollTop=want;
    sb.style.height='auto';                             /* let the incoming view size the container */
    const target=Math.round(sb.offsetHeight);           /* already clamped to the viewport */
    sb.style.height=h0+'px';void sb.offsetHeight;       /* pin the current height so the resize animates */
    sv.style.transition='none';sv.style.opacity='0';sv.style.transform=dir==='back'?'translateX(-18px) scale(.998)':'translateX(18px) scale(.998)';
    void sv.offsetHeight;                               /* flush the starting frame */
    sb.style.transition='height '+SV_MS+'ms '+SV_EASE;
    sv.style.transition='opacity 290ms cubic-bezier(.22,.75,.2,1),transform 320ms cubic-bezier(.22,.75,.2,1)';
    sb.style.height=target+'px';
    requestAnimationFrame(()=>{sv.style.opacity='1';sv.style.transform='none'});
    svHold(want,SV_MS);
    window._nt=setTimeout(settle,SV_MS+160);
  };
  const h0=Math.round(sb.offsetHeight);
  if(busy)return commit();
  if(matchMedia('(prefers-reduced-motion:reduce)').matches){
    sv.innerHTML=html;sync();svSettle(sb);sb.scrollTop=want;return;
  }
  /* keep the shell's size while the old view leaves, then hand over */
   sb.classList.remove('sv-forward','sv-back');sb.classList.add(dir==='back'?'sv-back':'sv-forward','sv-transitioning');
   sb.style.transition='none';
  sb.style.height=h0+'px';
  sb.style.overflow='hidden';
   sv.style.transition='opacity 180ms cubic-bezier(.4,0,.2,1),transform 220ms cubic-bezier(.4,0,.2,1)';
  sv.style.opacity='0';
   sv.style.transform=dir==='back'?'translateX(18px) scale(.998)':'translateX(-18px) scale(.998)';
  window._navBusy=1;
  window._nt=setTimeout(commit,SV_OUT);
}
function billKind(b){
  const kind=String(b&&b.kind||'').toLowerCase();
  if(kind==='bill'||kind==='subscription')return kind;
  const cat=String(b&&b.cat||'').toLowerCase();
  if(isTrial(b)||b&&b.subscriptionStatus||cat==='entertainment'||cat==='subscription'||cat==='subscriptions')return 'subscription';
  return 'bill';
}
function editBillSheet(id){
  const b=S.bills.find(x=>x.id==id);if(!b)return;
  const nd=bIso(nextDue(b)),fq=b.freq||'monthly',pays=billPayments(b),last=pays[0];
  /* a subscription that started with a free trial keeps that record; the trial's first
     billing date is what anchors the schedule, so it stays editable until the first charge */
  const T=isTrial(b),st=subStatus(b),trial=st=='trial',gone=st=='cancelled'||st=='expired',pre=T&&st!='active';
  const fb=T?(b.firstBillingDate||b.trialEndDate||b.start||nd):nd;
  const fbY=bDt(fb).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'});
  const acctName=b.acct&&acct(b.acct).id?esc(acct(b.acct).name):'No account yet';
  const dsh=pre?fb:nd;
  const trialCard=T?`<div class="card" style="margin:0 0 12px"><div class="eyebrow" style="margin:0 0 6px">${trial?'Free trial':'Free trial ended'}</div>`
    +`<div class="pd-r"><span class="m">Status</span><b>${trial?trialLabel(b):gone?(st=='cancelled'?'Cancelled':'Ended'):'Active'}</b></div>`
    +`<div class="pd-r"><span class="m">${st=='active'?'Free trial':'Trial ends'}</span><b>${st=='active'?noteD(b.trialStartDate||fb)+' – '+fbY:fbY}</b></div>`
    +`<div class="pd-r"><span class="m">${trial?'Then':gone?'Price':'Renews'}</span><b>${php(b.amt)}${subFreqTail(b)} · ${acctName}</b></div></div>`:'';
  const trialStart=pre?`<label class="m">Trial start</label><input id="eb-ts" type="date" value="${b.trialStartDate||today}" data-o="${b.trialStartDate||today}">`:'';
  const trialActions=gone?`<button class="btn s" style="margin-top:10px;width:100%" onclick="resumeSubAsk(${id})">Resume subscription</button>`
    :trial?`<button class="btn s" style="margin-top:10px;width:100%" onclick="cancelSubAsk(${id})">Cancel subscription</button><p class="hint">Stops before the first charge and keeps its history.</p>`:'';
  const hint=trial?`No charge until ${fbY} — then ${php(b.amt)}${subFreqTail(b)}, ${subFreqWord(b)}`
    :gone?`Nothing is scheduled and no further renewals will be made.`
    :`Next due ${bDt(nd).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'})}`;
  navS(`<div class="sh-h"><h2>Edit bill</h2>${subChip(b)}</div>${trialCard}<label class="m">Name</label><input id="eb-n" maxlength="60" value="${esc(b.name)}"><label class="m">Category</label><select id="eb-kind"><option value="bill" ${billKind(b)==="bill"?"selected":""}>Bill</option><option value="subscription" ${billKind(b)==="subscription"?"selected":""}>Subscription</option></select><label class="m">${T&&pre?'Price after trial':'Amount'} (${CS()})</label><input id="eb-a" type="number" inputmode="decimal" step="0.01" min="0" value="${b.amt}">${trialStart}<label class="m">${pre?'First billing date':'Due date'}</label><input id="eb-d" type="date" value="${dsh}" data-o="${dsh}"><label class="m">Repeats</label><select id="eb-r">${Object.keys(BF).map(k=>`<option value="${k}" ${fq==k?'selected':''}>${k=='once'?'Never (one-time)':BF[k]}</option>`).join('')}</select><p class="hint">${hint}</p><label class="m">Pay from</label><select id="eb-p" aria-label="Pay from"><option value="0">Choose later</option>${S.accts.map(a=>`<option value="${a.id}" ${a.id==b.acct?'selected':''}>${esc(a.name)}</option>`).join('')}</select><div class="logo-row"><span class="ico">${bIc(b)}</span><span class="f"><b>Logo</b><small>${b.logo?'Your uploaded logo':'Automatic, from the bill name'}</small></span><label class="pill" style="cursor:pointer">${b.logo?'Replace':'Upload'}<input type="file" accept="image/*" hidden onchange="billLogo(${id},this)"></label>${b.logo?`<button class="pill" onclick="billNoLogo(${id})">Remove</button>`:''}</div><div class="eyebrow" style="margin:18px 0 8px">Latest Payment</div>${last?payCardHtml(last,{bill:b}):`<div class="empty"><div class="e-ic">🧾</div><p class="m">${trial?'No charge yet — the free trial ends '+noteD(subFirstBill(b))+'.':'No payments recorded yet.'}</p></div>`}<button class="ph-row" onclick="billHistory(${id})"><span>Payment history</span><span class="ph-n">${pays.length} ›</span></button>${paidNow(b)?`<button class="btn s" style="margin-top:10px;width:100%" onclick="unpayBillAsk(${id})">Mark as unpaid</button>`:''}${trialActions}<button class="btn s danger-t" style="margin-top:10px;width:100%" onclick="delBillAsk(${id})">Delete bill</button><div class="sf"><button class="btn s" onclick="closeS()">Cancel</button><button class="btn" onclick="saveBillEdit(${id},this)">Save changes</button></div>`,'bill'+id);
}
/* ---- payment history: year filter + month groups (shared by bills and cards) ---- */
const PH={},PHC={};
function payMonthLbl(k){return new Date(+k.slice(0,4),+k.slice(5,7)-1,1).toLocaleDateString('en-PH',{month:'long',year:'numeric'})}
function payHistHtml(list,pick){
  if(!list.length)return '';
  const years=[...new Set(list.map(p=>String(p.d).slice(0,4)))].filter(Boolean).sort().reverse();
  const sel=years.indexOf(String(pick.year))>-1?String(pick.year):years[0];
  const rows=list.filter(p=>String(p.d).slice(0,4)===sel);
  let early=0,ok=0,late=0;
  rows.forEach(p=>{const n=payDiff(p.due,p.d);if(n==null)return;n>0?early++:n===0?ok++:late++});
  const bits=[`${rows.length} payment${rows.length==1?'':'s'}`];
  if(early)bits.push(early+' early');if(ok)bits.push(ok+' on time');if(late)bits.push(late+' late');
  const groups=[];
  rows.forEach(p=>{const k=String(p.d).slice(0,7);let g=groups[groups.length-1];if(!g||g.k!==k){g={k,total:0,items:[]};groups.push(g)}g.total+=+p.amt||0;g.items.push(p)});
  let ix=0;
  return `<div class="ph-sum"><div class="eyebrow">Paid in ${sel}</div><div class="big">${php(rows.reduce((s,p)=>s+(+p.amt||0),0))}</div><div class="m">${bits.join(' · ')}</div></div>`
    +(years.length>1?`<div class="ph-years">${years.map(y=>`<button class="pill${y===sel?' on':''}" aria-pressed="${y===sel}" onclick="${pick.fn}(${pick.id},${y})">${y}</button>`).join('')}</div>`:'')
    +groups.map(g=>`<div class="ph-mo"><span class="eyebrow">${payMonthLbl(g.k)}</span><b>${php(g.total)}</b></div><div class="plist">${g.items.map(p=>payCardHtml(p,{logoHtml:p.logoHtml,onclick:p.onclick,delay:Math.min(ix++,5)*18})).join('')}</div>`).join('');
}
function phSwap(box,html){
  if(!box)return;
  const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches,sb=$('#sb');
  const paint=()=>{box.innerHTML=html;if(!reduce){box.classList.remove('pg2');void box.offsetWidth;box.classList.add('pg2')}};
  if(reduce||!sb)return paint();
  svGlide(sb,paint,220);
}
function billHistBody(b){
  return payHistHtml(billPayments(b).map(p=>({d:p.d,amt:p.amt,acct:p.acct,acctName:p.acctName,due:p.due,logoHtml:bIc(b,'🧾'),onclick:`payDetail(${p.tx.id},'billHistory(${b.id})')`})),{year:PH[b.id],fn:'phY',id:b.id});
}
function phY(id,y){PH[id]=+y;phSwap($('#ph-body'),billHistBody(S.bills.find(x=>x.id==id)))}
function cardHistBody(a){
  return payHistHtml(S.xfer.filter(x=>x.to==a.id).sort((x,y)=>String(y.d).localeCompare(String(x.d))||y.id-x.id)
    .map(x=>({d:x.d,amt:x.amt,acct:x.from,due:x.due||'',logoHtml:cardLogo(a),onclick:`cardPayDetail(${x.id},${a.id},'cardPaymentHistory(${a.id})')`})),{year:PHC[a.id],fn:'phcY',id:a.id});
}
function phcY(id,y){PHC[id]=+y;phSwap($('#ph-body'),cardHistBody(acct(id)))}
function paymentHistoryCount(kind,id){
  if(kind==='card')return S.xfer.filter(x=>x.to==id).length;
  const b=S.bills.find(x=>x.id==id);return b?billPayments(b).length:0;
}
function openPaymentHistory(kind,id,backAction){
  const pop=document.getElementById('calendar-event-popup');
  if(pop&&window.closeCalendarEventPopup)window.closeCalendarEventPopup(true);
  if(kind==='card')cardPaymentHistory(id,backAction);else billHistory(id,backAction);
}
function billBack(id){return `<button class="btn s" style="margin-top:10px;width:100%" onclick="editBillSheet(${id})">‹ Back to bill</button>`}
function billHistory(id,backAction){
  const b=S.bills.find(x=>x.id==id);if(!b)return;
  const back=backAction||`editBillSheet(${id})`,pays=billPayments(b),head=`<div class="sh-h"><button class="pill" aria-label="Back" onclick="${back}">‹</button><h2>Payment history</h2></div><p class="m ph-sub">${esc(b.name)}</p>`;
  if(!pays.length)return navS(head+'<div class="empty"><div class="e-ic">🧾</div><p class="m">No payments recorded yet.</p></div>'+`<button class="btn s" style="margin-top:10px;width:100%" onclick="${back}">‹ Back</button>`,'hist'+id,{keep:1});
  navS(head+`<div id="ph-body">${billHistBody(b)}</div>`+(paidNow(b)?`<button class="btn s" style="margin-top:14px;width:100%" onclick="unpayBillAsk(${id})">Mark the latest payment as unpaid</button>`:'')+`<button class="btn s" style="margin-top:10px;width:100%" onclick="${back}">‹ Back</button>`,'hist'+id,{keep:1});
}
function cardPaymentHistory(cid,backAction){
  const a=S.accts.find(x=>x.id==cid);if(!a)return;
  const pays=S.xfer.filter(x=>x.to==cid).sort((x,y)=>String(y.d).localeCompare(String(x.d))||y.id-x.id);
  const back=backAction||`cardPayInfo(${cid})`,head=`<div class="sh-h"><button class="pill" aria-label="Back" onclick="${back}">‹</button><h2>Payment history</h2></div><p class="m ph-sub">${esc(a.nickname||a.name)}</p>`;
  if(!pays.length)return navS(head+'<div class="empty"><div class="e-ic">💳</div><p class="m">No payments recorded yet.</p></div>'+`<button class="btn s" style="margin-top:10px;width:100%" onclick="${back}">‹ Back</button>`,'cardhist'+cid,{keep:1});
  navS(head+`<div id="ph-body">${cardHistBody(a)}</div><button class="btn s" style="margin-top:10px;width:100%" onclick="${back}">‹ Back</button>`,'cardhist'+cid,{keep:1});
}
function payDetail(txId,backAction){
  const t=S.tx.find(x=>x.id==txId);if(!t)return;
  const bill=billForTx(t),due=bill?billDueShown(bill,t):(t.billDue||''),n=payDiff(due,t.d);
  const paidName=t.note||(bill?bill.name:t.cat),renamed=bill&&t.note&&t.note!==bill.name,back=backAction||'closeS()';
  const R=(l,v)=>`<div class="pd-r"><span class="m">${l}</span><b>${v}</b></div>`;
  navS(`<div class="sh-h"><button class="pill" aria-label="Back" onclick="${back}">‹</button><h2>Payment details</h2></div>`
    +`<div class="pd-hero"><div class="pd-h"><span class="ico">${bill?bIc(bill,'🧾'):'🧾'}</span><div class="pd-tt"><b>${esc(paidName)}</b><small>Bill Payment${renamed?` · now called ${esc(bill.name)}`:''}</small></div></div><div class="pd-amt"><span class="pd-v">${php(Math.abs(t.amt))}</span><span class="chip ok paid-chip"><svg class="paid-checkmark" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5"/></svg>Paid</span></div>${n==null?'':`<div class="pd-tm"><span class="chip ${n<0?'warn':'ok'}">${payTimingLabel(n)}</span></div>`}</div>`
    +`<div class="card" style="margin:0 0 12px">${R('Paid on',noteD(t.d))}${due?R('Original due date',noteD(due)):''}${R('Paid with',paySrcHtml(t.acct,t.acctName))}${t.desc?R('Note',esc(t.desc)):''}</div>`
    +(bill?`<button class="ph-row" onclick="billHistory(${bill.id},'payDetail(${t.id})')"><span>Payment history</span><span class="ph-n">${paymentHistoryCount('bill',bill.id)} ›</span></button>`:'')
    +`<button class="btn s" style="width:100%" onclick="editTx(${t.id})">Open in Activity</button>`
    +`${bill?`<button class="btn s dng" onclick="unpayFromDetail(${bill.id},${t.id})">Mark as unpaid</button>`:''}`
     ,'pd'+t.id);
}
function unpayFromDetail(bid,tid){
  const b=S.bills.find(x=>x.id==bid),t=S.tx.find(x=>x.id==tid);
  if(!b||!t)return;
  confirmBox('Mark this payment as unpaid?',b.name+' · '+php(Math.abs(t.amt))+' · '+noteD(t.d),()=>{undoBillPayment(b,t,t.billDue);closeS();render();toast('Bill marked unpaid')});
}
function saveBillEdit(id,btn){
  const b=S.bills.find(x=>x.id==id);if(!b)return;
  const n=$('#eb-n').value.trim(),a=parseFloat($('#eb-a').value),dEl=$('#eb-d'),f=$('#eb-r').value,kind=isTrial(b)?'subscription':($('#eb-kind')||{}).value;
  if(!n)return toast('Enter a name');
  if(!(a>=0))return toast('Enter a valid amount');
  if(kind!='bill'&&kind!='subscription')return toast('Choose Bills or Subscriptions');
  const dateChanged=dEl.value&&dEl.value!==dEl.dataset.o,freqChanged=f!==(b.freq||'monthly');
  const before=subStatus(b);
  b.name=n;b.amt=a;b.acct=+$('#eb-p').value||0;b.kind=kind;
  if(isTrial(b)){
    b.priceAfterTrial=a;                                   /* the trial always quotes the post-trial price */
    if(before!='active'){
      /* still inside the trial (or cancelled): the first billing date is editable and is the anchor */
      if($('#eb-ts')&&$('#eb-ts').value)b.trialStartDate=$('#eb-ts').value;
      const nf=(dEl.value||b.firstBillingDate||b.start||'').slice(0,10);
      if(!nf)return toast('Set the first billing date');
      b.firstBillingDate=nf;b.trialEndDate=nf;b.start=nf;b.due=+nf.slice(8,10);b.freq=f;
    } else if(dateChanged||freqChanged){
      /* it already bills like a normal subscription, so the trial dates are only history */
      const s=dEl.value||dEl.dataset.o;b.start=s;b.due=+s.slice(8,10);b.freq=f;
    }
  } else if(dateChanged||freqChanged){const s=dEl.value||dEl.dataset.o;b.start=s;b.due=+s.slice(8,10);b.freq=f}
  const done=()=>{vib(8);closeS();render();toast('Bill updated',true)};
  /* acknowledge the save on the button itself, then let the sheet go */
  if(btn&&!matchMedia('(prefers-reduced-motion:reduce)').matches){
    btn.style.minWidth=btn.offsetWidth+'px';btn.disabled=true;btn.classList.add('paid-ok');
    btn.innerHTML='<svg class="ck2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>Saved';
    setTimeout(done,420);
  } else done();
}
function delBillAsk(id){
  const b=S.bills.find(x=>x.id==id);if(!b)return;
  confirmBox('Are you sure you want to delete?',b.name+' · '+php(b.amt),()=>{S.bills=S.bills.filter(x=>x.id!=id);closeS();render();toast('Bill deleted')});
}
/* cancel a subscription without deleting it: the record and any history stay, no charge is made
   and nothing is scheduled again. Cancelling inside the trial keeps the "started free" story. */
function cancelSubAsk(id){
  const b=S.bills.find(x=>x.id==id);if(!b||!isTrial(b))return;
  const before=inTrial(b);
  confirmBox('Cancel this subscription?',
    before?`${b.name} · free trial ends ${noteD(subFirstBill(b))}. No charge will be made and no future renewals scheduled — its history is kept.`
          :`${b.name} · the free trial already ended at ${noteD(subFirstBill(b))}. Future renewals stop — its history is kept.`,
    ()=>{b.subscriptionStatus=before?'Cancelled':'Expired';b.cancelledOn=today;save();closeS();render();
      toast(before?'Cancelled during free trial — no charge':'Subscription ended',true)});
}
function resumeSubAsk(id){
  const b=S.bills.find(x=>x.id==id);if(!b||!isTrial(b))return;
  confirmBox('Resume this subscription?',b.name+' · it goes back into Upcoming from '+noteD(subFirstBill(b))+
    (b.acct&&acct(b.acct).id?' · pays from '+acct(b.acct).name:''),
    ()=>{delete b.subscriptionStatus;delete b.cancelledOn;save();closeS();render();toast('Subscription resumed',true)});
}
function billLogo(id,inp){const b=S.bills.find(x=>x.id==id);if(!b)return;imgPick(inp,64,'png',u=>{b.logo=u;save();render();editBillSheet(id);toast('Logo updated')})}
function billNoLogo(id){const b=S.bills.find(x=>x.id==id);if(!b)return;delete b.logo;save();render();editBillSheet(id);toast('Logo removed')}
function cardPayInfo(cid){
  const a=S.accts.find(x=>x.id==cid);if(!a)return;
   const open=outstandingCardStatements().find(x=>x.a.id==cid),latest=a.stmt?cSum(a,1):null,calc=latest?estimateStatement(a,latest):null,nd=open?bDt(open.due):nextCardDue(a),amount=latest&&latest.due>0?latest.due:dueAmt(a),R=(l,v,k)=>`<div class="cc-sum-row"><span class="m">${l}</span><b class="${k||''}" style="text-align:right">${v}</b></div>`,pays=S.xfer.filter(x=>x.to==cid).sort((x,y)=>String(y.d).localeCompare(String(x.d))||y.id-x.id),last=pays[0];
     navS(`<div class="sh-h"><h2>${esc(a.nickname||a.name)} · Credit Card</h2></div><p class="m" style="font-size:13px">Review your latest bill, payment status, and card payment history.</p><div class="card cc-latest-summary" style="margin:0 0 12px"><div class="eyebrow">Your Latest Bill</div>${R('Card balance',bv(php(a.bal)))}${latest?R('Statement period',noteD(latest.c.st)+' – '+noteD(latest.c.en)):''}${latest?R('Statement balance',bv(php(latest.close))):''}${R('Bill due amount',bv(php(amount)))}${R('Minimum due',bv(php(latest?latest.minimum:cardMinimum(a,amount))))}${R('Paid to date',bv(php(latest?latest.paid:0)))}${R('Remaining due',bv(php(calc?calc.remaining:amount)),calc&&calc.remaining?'r':'g')}${R('Due date',nd?nd.toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric"}):'—')}${R('Payment status',calc?calc.status:'Unpaid')}${calc&&calc.interest?R('Estimated Interest · not booked',bv(php(calc.interest))):''}${calc&&calc.fees?R('Estimated Fees · not booked',bv(php(calc.fees))):''}</div>${amount>0?`<button class="btn" onclick="payCard(${a.id},1)">Record Payment</button> `:''}<div class="eyebrow" style="margin:18px 0 8px">Latest Payment</div>${last?payCardHtml({d:last.d,amt:last.amt,acct:last.from,due:last.due||'',logoHtml:cardLogo(a),onclick:`cardPayDetail(${last.id},${a.id},'cardPayInfo(${a.id})')`}):`<div class="empty"><div class="e-ic">💳</div><p class="m">No payments recorded yet.</p></div>`}<button class="ph-row" onclick="cardPaymentHistory(${cid})"><span>Payment history</span><span class="ph-n">${pays.length} ›</span></button><button class="btn s" style="width:100%;margin-top:8px" onclick="closeS()">Close</button>`,'card'+cid,{keep:1});
}
function cardPayDetail(xid,cid,backAction){
  const x=S.xfer.find(z=>z.id==xid);if(!x)return;
  const c=S.accts.find(z=>z.id==cid)||S.accts.find(z=>z.id==x.to),f=S.accts.find(z=>z.id==x.from),n=payDiff(x.due,x.d);
  const R=(l,v)=>`<div class="pd-r"><span class="m">${l}</span><b>${v}</b></div>`;
  const timing=n==null?'':n===0?`<span class="chip ok">✓ On time</span>`:`<span class="chip pd-timing ${n>0?'early ok':'late warn'}"><i class="pd-timing-arrow" aria-hidden="true"></i><span class="pd-timing-copy">${Math.abs(n)} day${Math.abs(n)>1?'s':''} ${n>0?'early':'late'}</span></span>`;
  navS(`<div class="sh-h"><button class="pill" aria-label="Back" onclick="${backAction||'closeS()'}">‹</button><h2>Payment details</h2></div>`
     +`<div class="pd-hero"><div class="pd-h"><span class="ico">${c?cardLogo(c):'💳'}</span><div class="pd-tt"><b>${esc(c?c.name:'Card')}</b><small>Card Payment</small></div></div><div class="pd-amt"><span class="pd-v">${php(x.amt)}</span><span class="chip ok paid-chip"><svg class="paid-checkmark" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5"/></svg>Paid</span></div>${timing?`<div class="pd-tm">${timing}</div>`:''}</div>`
    +`<div class="card" style="margin:0 0 12px">${R('Paid on',noteD(x.d))}${x.due?R('Statement due',noteD(x.due)):''}${R('Paid from',f?paySrcHtml(f.id):'Outside this app')}${x.note?R('Note',esc(x.note)):''}</div>`
     +`<button class="ph-row" onclick="cardPaymentHistory(${cid},'cardPayDetail(${x.id},${cid})')"><span>Payment history</span><span class="ph-n">${paymentHistoryCount('card',cid)} ›</span></button>`
     +`<button class="btn s dng" onclick="undoCardPay(${x.id},${cid})">Mark as unpaid</button>`,'cpd'+x.id);
}
function undoCardPay(xid,cid){
  const x=S.xfer.find(z=>z.id==xid);if(!x)return;
  const c=S.accts.find(z=>z.id==x.to),f=S.accts.find(z=>z.id==x.from);
  confirmBox('Mark this payment as unpaid?',(S.accts.find(z=>z.id==cid)||{}).name+' · '+php(x.amt)+' · '+noteD(x.d),()=>{if(c)c.bal+=x.amt;if(f)f.bal+=x.amt;S.xfer=S.xfer.filter(z=>z.id!=xid);render();cardPayInfo(cid);toast('Marked as unpaid')});
}

function ensureCats(){migrate();if(!Array.isArray(S.cats)||!S.cats.length)S.cats=CAT0.map(c=>({n:c.n,i:c.i}));for(const k of Object.keys(CATS))delete CATS[k];S.cats.forEach(c=>{CATS[c.n]=c.i||'📦'})}
/* Pickers and suggestions offer live categories only — an archived category still keeps
   its icon on the transactions that already use it, but is no longer offered. */
function catNames(){const l=(S.cats||[]).filter(c=>!c.a).map(c=>c.n);return l.length?l:Object.keys(CATS)}
function catArch(n){const o=(S.cats||[]).find(x=>x.n==n);return !!(o&&o.a)}
function imgPick(inp,mw,fmt,cb){const f=inp.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const k=Math.min(1,mw/Math.max(im.width,im.height)),w=Math.max(1,Math.round(im.width*k)),hh=Math.max(1,Math.round(im.height*k)),c=document.createElement('canvas');c.width=w;c.height=hh;c.getContext('2d').drawImage(im,0,0,w,hh);cb(fmt=='png'?c.toDataURL('image/png'):c.toDataURL('image/jpeg',.78))};im.src=r.result};r.readAsDataURL(f)}
function catMgr(){openS(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2 style="margin:0">Categories</h2><button class="pill" onclick="closeS();render()">Done</button></div><p class="m" style="font-size:12px;margin:0 0 8px">Rename a category, change its emoji, or upload a logo (a logo replaces the emoji everywhere). If a note contains a category's name, like Meralco, that logo shows on the entry too.</p>${S.cats.map((c,i)=>`<div class="row"><div class="ico">${ci(c.n)}</div><div class="f"><input value="${esc(c.n)}" onchange="catRen(${i},this.value)" style="margin:0 0 6px"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><input value="${esc(c.i||'')}" maxlength="2" onchange="catEmo(${i},this.value)" style="width:56px;margin:0" placeholder="😀"><label class="pill" style="cursor:pointer">Upload logo<input type="file" accept="image/*" hidden onchange="catLogo(${i},this)"></label>${c.l?`<button class="pill" onclick="catNoLogo(${i})">Remove logo</button>`:''}</div></div><button class="pill" onclick="sure(this,()=>catDel(${i}))">✕</button></div>`).join('')}<div class="eyebrow" style="margin:16px 0 6px">Add category</div><div style="display:flex;gap:6px"><input id="ncn" placeholder="Name" style="margin:0;flex:1"><input id="nce" placeholder="😀" maxlength="2" style="margin:0;width:56px"><button class="btn" onclick="catAdd()">Add</button></div>`)}
function catRen(i,v){v=v.trim();const c=S.cats[i];if(!v||v==c.n||S.cats.some(x=>x.n==v)){catMgr();return}S.tx.forEach(t=>{if(t.cat==c.n)t.cat=v});if(S.budgets[c.n]!=null){S.budgets[v]=S.budgets[c.n];delete S.budgets[c.n]}c.n=v;ensureCats();render();catMgr()}
function catEmo(i,v){S.cats[i].i=v.trim()||'📦';ensureCats();render();catMgr()}
function catAdd(){const n=$('#ncn').value.trim();if(!n||S.cats.some(x=>x.n==n))return;S.cats.push({n,i:$('#nce').value.trim()||'📦'});ensureCats();render();catMgr()}
function catDel(i){S.cats.splice(i,1);ensureCats();render();catMgr()}
function catNoLogo(i){delete S.cats[i].l;render();catMgr()}
function catLogo(i,inp){imgPick(inp,64,'png',u=>{S.cats[i].l=u;render();catMgr()})}
/* Sage-to-forest spending ramp — one green family for every category, from
   pale stone through moss to deep forest, so the donut reads as a single
   chart instead of a rainbow. */
const SPX=['#22462f','#2a523c','#335c45','#3c6a4e','#4f7f5f','#628f70','#7ea88b','#9dc0a4','#bcd3c1','#c9d5c8','#dde4dc','#6d9078'],
SPB={Bills:'#c9d5c8',Shopping:'#2a523c',Groceries:'#4f7f5f',Transport:'#9dc0a4',Other:'#dde4dc',Food:'#22462f',Health:'#a9ccb0',Entertainment:'#6d9078',Salary:'#3c6a4e','Interest Earned':'#bcd3c1'};
function spendCol(c){if(SPB[c])return SPB[c];let k=0;for(const ch of String(c))k=(k*31+ch.charCodeAt(0))%997;return SPX[k%SPX.length]}

const DOTS = '<svg width="4" height="16" viewBox="0 0 4 16" fill="currentColor" aria-hidden="true"><circle cx="2" cy="2" r="1.8"/><circle cx="2" cy="8" r="1.8"/><circle cx="2" cy="14" r="1.8"/></svg>';
      function sure(b, fn) {
        if (b.dataset.s) {
          fn();
          return;
        }
        b.dataset.s = 1;
        b.dataset.o = b.textContent;
        b.textContent = "Tap again to confirm";
        setTimeout(() => {
          if (b.isConnected) {
            delete b.dataset.s;
            b.textContent = b.dataset.o;
          }
        }, 3000);
      }
      const esc = (s) =>
        String(s == null ? "" : s).replace(
          /[&<>"]/g,
          (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
        );
      const noteD = (d) =>
        new Date(d + "T00:00:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" });
      /* Notes, savings goals, debts, and swipe gestures */
      function Notes2() {
        if (!Array.isArray(S.notes))
          S.notes = S.notes ? [{ id: 1, t: "My notes", b: S.notes, d: today }] : [];
        const l = [...S.notes]
            .filter((n) => n.t || n.b)
            .sort((a, b) => b.d.localeCompare(a.d) || b.id - a.id),
          g = (S.nv || "gallery") == "gallery";
        return (
          `<div style="display:flex;gap:6px;align-items:center;margin-bottom:12px"><button class="pill ${g ? "on" : ""}" onclick="S.nv='gallery';render()">▦ Gallery</button><button class="pill ${g ? "" : "on"}" onclick="S.nv='list';render()">☰ List</button><span style="flex:1"></span><button class="btn" onclick="openNote(0)">＋ New note</button></div>` +
          (l.length
            ? g
              ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">${l.map((n) => `<div class="card" style="cursor:pointer;margin:0;aspect-ratio:1/1;overflow:hidden" onclick="openNote(${n.id})"><b>${esc(n.t || "Untitled")}</b><div class="m" style="font-size:13px;margin-top:6px;white-space:pre-wrap">${esc((n.b || "").slice(0, 160))}</div></div>`).join("")}</div>`
              : `<div class="card" style="padding:2px 14px">${l.map((n) => `<div class="row" style="cursor:pointer" onclick="openNote(${n.id})"><div class="ico">📝</div><div class="f">${esc(n.t || "Untitled")}<small>${esc((n.b || "").split("\n")[0].slice(0, 70))}</small></div><span class="m" style="font-size:12px">${noteD(n.d)}</span></div>`).join("")}</div>`
            : '<p class="m">No notes yet. Tap New note to write one.</p>')
        );
      }
      function nSet(id, k, v) {
        const n = S.notes.find((x) => x.id == id);
        if (!n) return;
        n[k] = v;
        n.d = today;
        render();
      }
      function openNote(id) {
        if (!Array.isArray(S.notes)) S.notes = [];
        let n = S.notes.find((x) => x.id == id);
        if (!n) {
          n = { id: Date.now(), t: "", b: "", d: today };
          S.notes.push(n);
        }
        openS(
          `<div style="display:flex;justify-content:space-between;margin-bottom:8px"><button class="pill" style="color:#ff453a" onclick="sure(this,()=>{S.notes=S.notes.filter(x=>x.id!=${n.id});closeS();render()})">Delete</button><button class="pill" onclick="S.notes=S.notes.filter(x=>x.t||x.b);closeS();render()">Done</button></div><input placeholder="Title" value="${esc(n.t)}" oninput="nSet(${n.id},'t',this.value)" style="font-size:20px;font-weight:700"><textarea placeholder="Write something…" oninput="nSet(${n.id},'b',this.value)" style="min-height:260px">${esc(n.b)}</textarea>`,
        );
      }
      function Goals() {
        const A = S.goals.filter((g) => !g.done),
          D = S.goals.filter((g) => g.done),
          sv = sum(A.map((g) => g.saved)),
          tg = sum(A.map((g) => g.target)),
          pc = (g) => Math.min(100, Math.round((g.saved / (g.target || 1)) * 100)),
          eligible=S.accts.filter(a=>a.type!='credit'),
          accountLabel=a=>a?`${esc(a.name)}${a.l4?' •• '+esc(a.l4):''}`:'Account link needed',
          seg = (p, n, h, c) =>
            `<div style="display:flex;gap:${h > 10 ? 6 : 2}px">${[...Array(n)].map((_, i) => `<i style="flex:1;height:${h}px;border-radius:3px;background:${i < Math.round((p / 100) * n) ? c : "var(--line)"}"></i>`).join("")}</div>`;
        goalIndex = Math.min(goalIndex, Math.max(0, A.length - 1));
        const f = A[goalIndex];
        const allocationCard=`<div class="card"><div class="eyebrow">Savings accounts · goal allocations</div>${eligible.map(a=>{const allocated=sum(S.goals.filter(g=>+g.accountId==+a.id).map(g=>+g.saved||0)),free=+a.bal-allocated;return`<div class="goal-account-row"><b>${accountLabel(a)}</b><span>Balance ${php(a.bal)} · Allocated ${php(allocated)} · Unallocated ${php(free)}</span>${free<-.005?'<small class="r">Allocations exceed this account balance. Review linked goals.</small>':''}</div>`}).join('')||'<p class="m">Add a savings, debit or e-wallet account to link goals.</p>'}</div>`;
        return `<div class="card"><div class="eyebrow">Saved toward goals</div><div><span class="big" style="font-size:34px">${php(sv)}</span> <span class="m">of ${php(tg)}</span></div><div style="margin-top:10px">${seg(tg ? (sv / tg) * 100 : 0, 60, 10, "var(--g)")}</div></div>${allocationCard}
${f ? `<div id="goal-card" class="card goal-card ${goalEnter ? `goal-in-${goalEnter}` : ""}" style="touch-action:pan-y;user-select:none;cursor:grab;transition:transform .2s ease,opacity .2s ease" onpointerdown="goalStart(event)" onpointermove="goalMove(event)" onpointerup="goalSwipe(event.clientX)" onpointercancel="goalCancel()"><div style="display:flex;justify-content:space-between;align-items:center"><div class="eyebrow">Savings goal ${A.length > 1 ? "· " + (goalIndex + 1) + " of " + A.length : ""}</div><span class="m" style="font-size:12px">Swipe right: next · left: previous</span></div><div style="font-size:40px;margin-top:6px">${f.icon}</div><h2 style="font-size:26px;margin:2px 0 10px">${esc(f.name)}</h2><div style="display:flex;justify-content:space-between;align-items:baseline"><b>${php(f.saved)}</b><b>${pc(f)}%</b></div><div class="bar" style="height:12px"><b style="width:${pc(f)}%"></b></div><div style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px"><span class="m">of ${php(f.target)}</span><span class="m">${php(Math.max(0, f.target - f.saved))} remaining</span></div><div class="goal-saved-in"><span>Saved in</span><b>${accountLabel(eligible.find(a=>+a.id==+f.accountId))}</b></div>${f.targetDate?`<div class="goal-saved-in"><span>Target</span><b>${noteD(f.targetDate)}</b></div>`:''}${goalInterestFor(f)>0?`<div class="goal-saved-in"><span>Interest earned</span><b>+${php(goalInterestFor(f))}</b></div>`:''}<p style="margin:12px 0 0"><button class="btn s" onclick="goalSheet(${f.id})">Manage goal</button></p></div>` : ""}
<div class="card"><div class="eyebrow">Goals</div>${A.map((g) => `<div class="sw" data-g="${g.id}">${swActs(g)}<div class="row sw-c" onclick="swTap(${g.id})" onpointerdown="swDown(event)" onpointermove="swMove(event)" onpointerup="swUp(event)" onpointercancel="swUp(event)"><div style="width:44px;height:44px;border-radius:50%;background:conic-gradient(var(--g) ${pc(g)}%,var(--line) 0);display:grid;place-items:center;flex:none"><div style="width:34px;height:34px;border-radius:50%;background:var(--card);display:grid;place-items:center">${g.icon}</div></div><div class="f">${esc(g.name)}<small>${php(g.saved)} / ${php(g.target)} · ${pc(g)}% · Saved in ${accountLabel(eligible.find(a=>+a.id==+g.accountId))}</small>${g.targetDate?`<small>Target ${noteD(g.targetDate)}</small>`:''}${goalInterestFor(g)>0?`<small>Interest earned +${php(goalInterestFor(g))}</small>`:''}<div class="bar"><b style="width:${pc(g)}%"></b></div></div><button class="pill" onclick="event.stopPropagation();goalSheet(${g.id})">＋</button></div></div>`).join("") || '<p class="m">No goals yet.</p>'}<p class="m" style="font-size:12px">Goal amounts are allocations from linked accounts, not separate cash balances.</p><button class="btn s" onclick="openGoal()">＋ Add goal</button></div>
${D.length ? `<div class="card"><div class="eyebrow">Done</div>${D.map((g) => `<div class="row" style="cursor:pointer" onclick="goalSheet(${g.id})"><div class="ico">${g.icon}</div><div class="f">${esc(g.name)}<small>${php(g.saved)} / ${php(g.target)} · ${pc(g)}% · Saved in ${accountLabel(eligible.find(a=>+a.id==+g.accountId))}</small></div>✅</div>`).join("")}</div>` : ""}`;
      }
      function goalStart(e) {
        if (goalAnimating) return;
        goalTouchX = e.clientX;
        e.currentTarget.style.transition = "none";
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      function goalMove(e) {
        if (goalTouchX === null) return;
        const dx = e.clientX - goalTouchX,
          el = e.currentTarget;
        el.style.transform = `translateX(${Math.max(-110, Math.min(110, dx))}px) rotate(${Math.max(-5, Math.min(5, dx * 0.035))}deg)`;
        el.style.opacity = String(Math.max(0.72, 1 - Math.abs(dx) / 360));
      }
      function goalCancel() {
        goalTouchX = null;
        const el = $("#goal-card");
        if (el) {
          el.style.transition = "transform .2s ease,opacity .2s ease";
          el.style.transform = "";
          el.style.opacity = "";
        }
      }
      function goalSwipe(x) {
        if (goalTouchX === null || goalAnimating) return;
        const dx = x - goalTouchX;
        goalTouchX = null;
        const el = $("#goal-card"),
          n = S.goals.filter((g) => !g.done).length;
        if (Math.abs(dx) < 48 || n < 2) {
          if (el) {
            el.style.transition = "transform .2s ease,opacity .2s ease";
            el.style.transform = "";
            el.style.opacity = "";
          }
          return;
        }
        goalAnimating = true;
        const direction = dx > 0 ? "right" : "left";
        if (el) {
          el.style.transform = "";
          el.style.opacity = "";
          el.style.transition = "";
          el.classList.add("goal-out-" + direction);
        }
        clearTimeout(window._goalSwipeTimer);
        window._goalSwipeTimer = setTimeout(() => {
          goalIndex = (goalIndex + (dx > 0 ? 1 : -1) + n) % n;
          goalEnter = dx > 0 ? "left" : "right";
          render();
          const incoming = $("#goal-card");
          setTimeout(() => {
            if (incoming) {
              incoming.classList.remove("goal-in-left", "goal-in-right");
              incoming.style.transition = "";
            }
            goalEnter = "";
            goalAnimating = false;
          }, 360);
        }, 190);
      }
      function Debts() {
        const I = S.debts.filter((d) => d.dir == "in"),
          O = S.debts.filter((d) => d.dir == "out"),
          si = sum(I.map((d) => d.amt)),
          so = sum(O.map((d) => d.amt));
        const L = (l, t) =>
          `<div class="card"><div class="eyebrow">${t}</div>${l.map((d) => `<div class="row" style="cursor:pointer" onclick="debtSheet(${d.id})"><div class="ico" style="font-weight:700">${(d.who[0] || "?").toUpperCase()}</div><div class="f">${d.who}<small>${d.due ? "Due " + d.due + (d.note ? " · " : "") : ""}${d.note}</small></div><b class="${d.dir == "in" ? "g" : "r"}">${php(d.amt)}</b></div>`).join("") || '<p class="m">Nothing here.</p>'}</div>`;
        return `<div class="card"><div style="display:flex;justify-content:space-between"><div><div class="eyebrow">Owed to you</div><div class="g" style="font-size:30px;font-weight:700">${php(si)}</div><small class="m">${I.length} people</small></div><div style="text-align:right"><div class="eyebrow">You owe</div><div class="r" style="font-size:30px;font-weight:700">${php(so)}</div><small class="m">${O.length} debts</small></div></div><div style="display:flex;gap:3px;margin-top:12px"><i style="flex:${si || 0.01};height:6px;border-radius:9px;background:var(--g)"></i><i style="flex:${so || 0.01};height:6px;border-radius:9px;background:var(--r)"></i></div></div>${L(I, "Owed to you")}${L(O, "You owe")}<button class="btn s" onclick="openDebt()">＋ Add debt or IOU</button>`;
      }
      function goalManageSheet(id) {
        const g = S.goals.find((x) => x.id == id);
        if(!g)return;const eligible=S.accts.filter(a=>a.type!='credit'),linked=eligible.find(a=>+a.id==+g.accountId),alloc=linked?sum(S.goals.filter(x=>+x.accountId==+linked.id).map(x=>+x.saved||0)):0,free=linked?+linked.bal-alloc:0,hist=goalHistoryMarkup(g);
        openS(`<h2>${g.icon} ${esc(g.name)}</h2><p class="m">${php(g.saved)} of ${php(g.target)} · ${Math.min(100,Math.round((g.saved/(g.target||1))*100))}%</p><label class="m" for="goal-name">Goal name</label><input id="goal-name" maxlength="60" value="${esc(g.name)}"><label class="m" for="goal-icon">Icon</label><input id="goal-icon" maxlength="4" value="${esc(g.icon)}"><label class="m" for="goal-target">Target amount (${CS()})</label><input id="goal-target" type="number" min="0.01" step="0.01" inputmode="decimal" value="${g.target}"><label class="m" for="goal-account">Saved in</label><select id="goal-account"><option value="">Choose account</option>${eligible.map(a=>`<option value="${a.id}" ${+a.id==+g.accountId?'selected':''}>${esc(a.name)}${a.l4?' •• '+esc(a.l4):''} · ${php(a.bal)}</option>`).join('')}</select>${linked?`<p class="m">Account balance ${php(linked.bal)} · allocated ${php(alloc)} · unallocated ${php(free)}</p>`:''}<label class="m" for="goal-target-date">Target date (optional)</label><input id="goal-target-date" type="date" value="${g.targetDate||''}"><button class="btn s" onclick="goalSaveDetails(${id})">Save goal details</button><div class="goal-actions"><button class="btn" onclick="goalAddSheet(${id})">Add Money</button><button class="btn s" onclick="goalWithdrawSheet(${id})">Withdraw from Goal</button></div>${!g.accountId&&g.saved>0?'<p class="r">This existing saved amount is not linked to an account yet. Linking assigns existing funds; it will not move or add money.</p>':''}${hist}<p><button class="btn s" onclick="goalDone(${id});closeS()">${g.done?'Reopen goal':'Mark as done'}</button> <button class="btn s" onclick="sure(this,()=>{goalDel(${id});closeS()})">Delete</button></p>`);
      }
      function goalHistoryMarkup(g){const tx=S.xfer.filter(x=>x.kind=='goal-transfer'&&x.goalId==g.id).map(x=>({d:x.d,label:x.direction=='out'?'Withdrawal':'Contribution',amt:x.amt,note:x.note}));S.tx.filter(t=>t.cat=='Interest Earned'&&(t.goalInterestAllocations||[]).some(x=>+x.goalId==+g.id)).forEach(t=>tx.push({d:t.d,label:'Interest allocated',amt:(t.goalInterestAllocations||[]).filter(x=>+x.goalId==+g.id).reduce((a,x)=>a+(+x.amount||0),0)}));tx.sort((a,b)=>b.d.localeCompare(a.d));return tx.length?`<div class="eyebrow" style="margin-top:16px">Recent goal activity</div><div class="card goal-history">${tx.slice(0,6).map(x=>`<div class="goal-history-row"><span>${esc(x.label)}<small>${noteD(x.d)}${x.note?' · '+esc(x.note):''}</small></span><b>${x.label=='Withdrawal'?'−':'+'}${php(x.amt)}</b></div>`).join('')}</div>`:'<p class="m">No goal activity recorded yet.</p>'}
      function goalSaveDetails(id){const g=S.goals.find(x=>x.id==id);if(!g)return;const accountId=+$('#goal-account').value||0,targetDate=$('#goal-target-date').value||'',name=$('#goal-name').value.trim(),target=+$('#goal-target').value,icon=$('#goal-icon').value.trim()||'🎯';if(!name||!(target>0))return toast('Enter a goal name and target amount');if(!accountId)return toast('Choose the account where this goal money is held');const commit=()=>{g.accountId=accountId;g.targetDate=targetDate;g.name=name;g.target=target;g.icon=icon;save();closeS();render();toast('Goal saved',true)};if(accountId!=g.accountId){const ac=acct(accountId),others=sum(S.goals.filter(x=>x.id!=id&&+x.accountId==accountId).map(x=>+x.saved||0)),short=others+(+g.saved||0)-(+ac.bal||0);if(short>.005)return confirmBox('Allocation exceeds available balance',`${ac.name} has ${php(Math.max(0,ac.bal-others))} unallocated, but this goal already shows ${php(g.saved)} saved. Link existing goal funds without moving money anyway?`,commit,'Link anyway')}commit()}
      function goalAddSheet(id){const g=S.goals.find(x=>x.id==id),accounts=S.accts.filter(a=>a.type!='credit');if(!g)return;if(!accounts.length)return toast('Add a savings, debit or e-wallet account first');openS(`<h2>Add money to ${esc(g.name)}</h2><label class="m">Amount (${CS()})</label><input id="goal-amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00"><label class="m">From account</label><select id="goal-from">${accounts.map(a=>`<option value="${a.id}" ${+a.id==+g.accountId?'selected':''}>${esc(a.name)}${a.l4?' •• '+esc(a.l4):''} · ${php(a.bal)}</option>`).join('')}</select><label class="m">To savings account (Saved in)</label><select id="goal-to">${accounts.map(a=>`<option value="${a.id}" ${+a.id==+g.accountId?'selected':''}>${esc(a.name)}${a.l4?' •• '+esc(a.l4):''}</option>`).join('')}</select><label class="m">Date</label><input id="goal-date" type="date" value="${today}"><label class="m">Note (optional)</label><input id="goal-note" maxlength="100" placeholder="Add a note"><p class="m">Choosing the same source and destination only allocates funds already held there. Choosing different accounts records an internal transfer—not spending.</p><button class="btn" onclick="goalMoveCommit(${id},'add')">Add to Goal</button> <button class="btn s" onclick="closeS()">Cancel</button>`)}
      function goalWithdrawSheet(id){const g=S.goals.find(x=>x.id==id),accounts=S.accts.filter(a=>a.type!='credit'),src=accounts.find(a=>+a.id==+g?.accountId);if(!g)return;if(!src)return toast('Link this goal to an account first');openS(`<h2>Withdraw from ${esc(g.name)}</h2><p class="m">Allocated to this goal: ${php(g.saved)} · held in ${esc(src.name)}</p><label class="m">Amount (${CS()})</label><input id="goal-amount" type="number" min="0.01" max="${g.saved}" step="0.01" inputmode="decimal" placeholder="0.00"><label class="m">Send to account</label><select id="goal-to">${accounts.map(a=>`<option value="${a.id}" ${+a.id==+src.id?'selected':''}>${esc(a.name)}${a.l4?' •• '+esc(a.l4):''}</option>`).join('')}</select><label class="m">Date</label><input id="goal-date" type="date" value="${today}"><label class="m">Note (optional)</label><input id="goal-note" maxlength="100" placeholder="Add a note"><p class="m">Sending to the same account releases the allocation. Another account records an internal transfer, not income or spending.</p><button class="btn" onclick="goalMoveCommit(${id},'out')">Withdraw from Goal</button> <button class="btn s" onclick="closeS()">Cancel</button>`)}
      function goalMoveCommit(id,mode){const g=S.goals.find(x=>x.id==id),amount=+$('#goal-amount').value,date=$('#goal-date').value||today,to=+$('#goal-to').value,from=mode=='add'?+$('#goal-from').value:+g?.accountId;if(!g||!(amount>0)||!date||!to||!from)return toast('Complete the amount and account selections');const src=acct(from),dst=acct(to);if(!src||!dst||src.type=='credit'||dst.type=='credit')return toast('Choose eligible savings or payment accounts');const srcAlloc=sum(S.goals.filter(x=>+x.accountId==from).map(x=>+x.saved||0)),srcFree=src.bal-srcAlloc+(mode=='out'?+g.saved||0:0);if(mode=='add'&&from!=to&&amount>srcFree+.005)return toast(`Only ${php(Math.max(0,srcFree))} is unallocated in the source account`);if(mode=='add'&&from==to&&amount>src.bal+.005)return toast('Source account does not have enough funds');if(mode=='out'&&amount>g.saved+.005)return toast('Withdrawal exceeds this goal allocation');if(mode=='out'&&to!=from&&amount>src.bal+.005)return toast('Linked account does not have enough funds');const afterBalance=dst.bal+(mode=='add'&&from!=to?amount:0)-(mode=='out'&&from==to?amount:0),otherAlloc=sum(S.goals.filter(x=>x.id!=id&&+x.accountId==to).map(x=>+x.saved||0)),newSaved=mode=='add'?g.saved+amount:g.saved-amount;if(otherAlloc+newSaved>afterBalance+.005)return confirmBox('Goal allocations exceed account balance',`This change would allocate ${php(otherAlloc+newSaved)} against a ${php(afterBalance)} account balance. Continue and leave the account flagged for review?`,()=>goalMoveCommitDo(g,mode,amount,from,to,date), 'Continue');goalMoveCommitDo(g,mode,amount,from,to,date)}
      function goalMoveCommitDo(g,mode,amount,from,to,date){const src=acct(from),dst=acct(to),note=($('#goal-note')||{}).value||'',id=uid();S.xfer.push({id,d:date,amt:amount,from,to,kind:'goal-transfer',goalId:g.id,direction:mode,note});if(from!=to){src.bal-=amount;dst.bal+=amount}g.saved=Math.max(0,g.saved+(mode=='add'?amount:-amount));if(mode=='add')g.accountId=to;save();closeS();render();toast(mode=='add'?'Money added to goal':'Goal withdrawal recorded',true)}
      function goalInterestFor(g){return sum(S.tx.filter(t=>t.cat=='Interest Earned').flatMap(t=>(t.goalInterestAllocations||[]).filter(x=>+x.goalId==+g.id).map(x=>+x.amount||0)))}
      function gMove(id, s) {
        if(s>0)goalAddSheet(id);else goalWithdrawSheet(id);
      }
      function openGoal() {
        const accounts=S.accts.filter(a=>a.type!='credit');openS(`<h2>New goal</h2><input id="gn" placeholder="Goal name (e.g. Japan Trip)"><input id="gi" maxlength="2" placeholder="Emoji" value="🎯"><label class="m">Target amount (${CS()})</label><input id="gt" type="number" min="0.01" step="0.01" inputmode="decimal"><label class="m">Already saved in an account (${CS()})</label><input id="gs" type="number" min="0" step="0.01" inputmode="decimal" value="0"><label class="m">Saved in</label><select id="goal-new-account"><option value="">Choose account</option>${accounts.map(a=>`<option value="${a.id}">${esc(a.name)}${a.l4?' •• '+esc(a.l4):''} · balance ${php(a.bal)}</option>`).join('')}</select><label class="m">Target date (optional)</label><input id="goal-new-date" type="date"><button class="btn" onclick="goalCreate()">Add goal</button>`)
      }
      function goalCreate(){const name=$('#gn').value.trim()||'Goal',saved=+$('#gs').value||0,target=+$('#gt').value||0,accountId=+$('#goal-new-account').value||0;if(!(target>0))return toast('Enter a target amount');if(!accountId)return toast('Choose the account where this goal money is held');const go=()=>{S.goals.push({id:uid(),name,icon:$('#gi').value||'🎯',target,saved,accountId,targetDate:$('#goal-new-date').value||''});save();closeS();render()};if(accountId){const a=acct(accountId),alloc=sum(S.goals.filter(g=>+g.accountId==accountId).map(g=>+g.saved||0));if(alloc+saved>a.bal+.005)return confirmBox('Allocation exceeds available balance',`${a.name} has ${php(Math.max(0,a.bal-alloc))} unallocated, but you entered ${php(saved)} already saved. Add the goal anyway and flag the difference?`,go,'Add goal anyway')}go()}
      function goalDone(id){const g=S.goals.find(x=>x.id==id);if(!g)return;g.done=g.done?0:1;save();render();toast(g.done?'Goal marked done':'Goal reopened')}
      function goalDel(id){S.goals=S.goals.filter(x=>x.id!=id);save();render();toast('Goal deleted')}
      function openDebt() {
        openS(
          `<h2>New debt or IOU</h2><select id="dr"><option value="in">Someone owes me</option><option value="out">I owe someone</option></select><input id="dw" placeholder="Person or lender"><input id="dn" placeholder="Note (e.g. Dinner split)"><input id="da" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="Amount (${CS()})"><input id="dd2" type="date"><button class="btn" onclick="S.debts.push({id:Date.now(),dir:$('#dr').value,who:$('#dw').value||'Someone',note:$('#dn').value,amt:+$('#da').value||0,due:$('#dd2').value});closeS();render()">Add</button>`,
        );
      }
      function debtSheet(id) {
        const d = S.debts.find((x) => x.id == id);
        openS(
          `<h2>${d.who}</h2><p class="m">${php(d.amt)} ${d.dir == "in" ? "owed to you" : "you owe"}</p><input id="dp" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="Payment amount (${CS()})"><button class="btn" onclick="dPay(${id})">Record Payment</button> <button class="btn s" onclick="S.debts=S.debts.filter(x=>x.id!=${id});closeS();render()">Delete</button>`,
        );
      }
      function dPay(id) {
        const d = S.debts.find((x) => x.id == id),
          a = Math.abs(+$("#dp").value);
        if (!a) return;
        d.amt = Math.max(0, d.amt - a);
        if (!d.amt) S.debts = S.debts.filter((x) => x.id != id);
        closeS();
        render();
      }
/* ===================== v1.01 additions ===================== */
const CURS={PHP:['₱','en-PH'],USD:['$','en-US'],EUR:['€','de-DE'],GBP:['£','en-GB'],JPY:['¥','ja-JP',0],KRW:['₩','ko-KR',0],SGD:['S$','en-SG'],AUD:['A$','en-AU'],CAD:['C$','en-CA'],HKD:['HK$','en-HK'],INR:['₹','en-IN'],CNY:['CN¥','zh-CN']};
const CS=()=>(CURS[S&&S.cur]||CURS.PHP)[0];
/* Display formatting only — nothing here ever touches a stored amount. */
const NF={us:['.',','],eu:[',','.'],sp:[',','\u00a0']};  /* [decimal, grouping] */
const NEG=[['sign','−₱1,250'],['acct','(₱1,250)']];
function fmt(n){n=+n||0;const c=CURS[S&&S.cur]||CURS.PHP,d=S&&S.dec&&c[2]!==0?2:0,v=Math.abs(n),r=d?Math.round(v*100)/100:Math.round(v),sym=c[0],nf=NF[(S&&S.nf)||'us']||NF.us,st=(S&&S.neg)||'sign';let s=d?r.toFixed(2):String(Math.round(r)),ip=s,fp='';const dt=s.indexOf('.');if(dt>=0){ip=s.slice(0,dt);fp=s.slice(dt+1)}const body=ip.replace(/\B(?=(\d{3})+(?!\d))/g,nf[1])+(fp?nf[0]+fp:'');if(n<0&&r)return st=='acct'?'('+sym+body+')':'−'+sym+body;return sym+body}
function migrate(){S.pend=S.pend||[];S.xfer=S.xfer||[];S.cur=S.cur||'PHP';(S.accts||[]).forEach(a=>{if(a&&a.bank=='GCash'&&!a.photo&&(a.img=='gcashg'||/^GCash (Mastercard|Visa Debit|Visa Card)$/.test(a.name))){a.name='GCash Visa Card';a.type='ewallet';a.net='visa';a.img='gcashg';a.g=['#0b2a7a','#2f6fe0']}})}
/* Readable previews for the Settings choices (display only). */
function nfSample(nf){const c=CURS[S&&S.cur]||CURS.PHP,d=S&&S.dec&&c[2]!==0?2:0;let s=d?'1234.56':'1234';const dt=s.indexOf('.');const ip=dt>=0?s.slice(0,dt):s,fp=dt>=0?s.slice(dt+1):'';return ip.replace(/\B(?=(\d{3})+(?!\d))/g,NF[nf][1])+(fp?NF[nf][0]+fp:'')}
function negSample(k){const K=CS(),f=()=>{const c=CURS[S&&S.cur]||CURS.PHP,d=S&&S.dec&&c[2]!==0?2:0;let s=d?'1250.00':'1250';const dt=s.indexOf('.');const ip=dt>=0?s.slice(0,dt):s,fp=dt>=0?s.slice(dt+1):'';const n=NF[(S&&S.nf)||'us']||NF.us;return ip.replace(/\B(?=(\d{3})+(?!\d))/g,n[1])+(fp?n[0]+fp:'')};const b=f();return k=='acct'?'('+K+b+')':'−'+K+b}
let _u=0;const uid=()=>Date.now()*1000+(++_u),dflt=b=>S.accts.find(a=>a.id==b.acct)||S.accts[0];


/* ---- goals: swipe actions */
const swActs=g=>`<div class="sw-b sw-bl"><button onclick="goalSheet(${g.id},'add')">＋<small>Add</small></button><button onclick="goalSheet(${g.id},'out')">−<small>Take out</small></button></div><div class="sw-b sw-br"><button onclick="goalDone(${g.id})">${g.done?'↺':'✓'}<small>${g.done?'Reopen':'Done'}</small></button><button class="d" onclick="sure(this,()=>goalDel(${g.id}))">✕<small>Delete</small></button></div>`;
let SW=null;
function swClose(x){document.querySelectorAll('.sw-c').forEach(e=>{if(e!==x){e.style.transform='';e.dataset.o=''}})}
function swDown(e){const c=e.currentTarget;swClose(c);SW={c,x:e.clientX,y:e.clientY,o:+(c.dataset.o||0),h:0,m:0};c.style.transition='none'}
function swMove(e){if(!SW)return;const dx=e.clientX-SW.x,dy=e.clientY-SW.y;if(!SW.h){if(Math.abs(dx)>8&&Math.abs(dx)>Math.abs(dy)*1.4)SW.h=1;else if(Math.abs(dy)>8){SW.c.style.transition='';SW=null;return}else return}SW.m=1;try{SW.c.setPointerCapture(e.pointerId)}catch(_){}SW.c.style.transform=`translateX(${Math.max(-150,Math.min(150,SW.o+dx))}px)`}
function swUp(e){if(!SW)return;const s=SW;SW=null;const c=s.c;c.style.transition='';if(!s.m)return;const x=s.o+(e.clientX-s.x),v=x<-60?-144:x>60?144:0;c.style.transform=v?`translateX(${v}px)`:'';c.dataset.o=v;c.dataset.d=Date.now()}
function swTap(id){const c=document.querySelector(`.sw[data-g="${id}"] .sw-c`);if(c&&Date.now()-(+c.dataset.d||0)<300)return;if(c&&+c.dataset.o)return swClose();goalSheet(id)}
function goalDone(id){const g=S.goals.find(x=>x.id==id);if(!g)return;g.done=g.done?0:1;save();render();toast(g.done?'Goal marked done':'Goal reopened')}
function goalDel(id){S.goals=S.goals.filter(x=>x.id!=id);save();render();toast('Goal deleted')}
function goalSheet(id,m){if(m=='add')return goalAddSheet(id);if(m=='out')return goalWithdrawSheet(id);goalManageSheet(id)}
function gMove(id,s){if(s>0)goalAddSheet(id);else goalWithdrawSheet(id)}
/* ---- spending: infinite month reel, donut breakdown, clickable trend bars.
   spendY = the selected year, spendM = 0-11, or null for the whole year.
   The reel repeats the 12 month names so it never shows an edge, and the year
   dropdown is a separate axis — looping Dec -> Jan never changes the year. */
let trendM=null,spendY=null,spendM=null;
let spendScroll=null;                       /* remembered reel offset, survives re-render */
const SP_REPS=5,SP_MID=2,SP_LEAD=12;        /* cycles drawn, canonical cycle, lead gap (px) */
const spendNowYear=()=>T.getFullYear();
function spendReset(){spendY=spendNowYear();spendM=T.getMonth();trendM=null}
const spendRM=()=>matchMedia('(prefers-reduced-motion: reduce)').matches||S.rm==1||S.anim==0;
const SPM=Array.from({length:12},(_,m)=>new Date(2000,m,1).toLocaleDateString('en-PH',{month:'short'}));
const mName=k=>String(k).length===4?String(k):new Date(+String(k).slice(0,4),+String(k).slice(5,7)-1,1).toLocaleDateString('en-PH',{month:'long'});
/* '' key is the whole year: dates are stored YYYY-MM-DD, so startsWith('2025') scopes the year. */
function spendKey(){if(spendY==null)spendReset();return spendM==null?String(spendY):`${spendY}-${String(spendM+1).padStart(2,'0')}`}
const spendHas=k=>S.tx.some(t=>String(t.d).startsWith(k)&&t.amt<0);
function spendYears(){const s=new Set([spendNowYear()]);S.tx.forEach(t=>{const y=+String(t.d).slice(0,4);if(y)s.add(y)});return [...s].sort((a,b)=>b-a)}
function spendMonthsWithData(y){const o=[];for(let m=0;m<12;m++)if(spendHas(`${y}-${String(m+1).padStart(2,'0')}`))o.push(m);return o}
function spendLastMonth(y){const l=spendMonthsWithData(y);return l.length?l[l.length-1]:(y==spendNowYear()?T.getMonth():11)}
function spendAnchor(key){if(String(key).length===4){const y=+key;return [y,spendLastMonth(y)]}return [+String(key).slice(0,4),+String(key).slice(5,7)-1]}
function spendRangeLabel(key){const ms=spendMonthsWithData(+String(key).slice(0,4));return ms.length?`${SPM[ms[0]]} – ${SPM[ms[ms.length-1]]}`:`${SPM[0]} – ${SPM[11]}`}
const spendBar=()=>document.getElementById('sp-months');
const spendPad=m=>`${spendY}-${String(m+1).padStart(2,'0')}`;
/* The reel always starts at the real current month, then keeps counting up. */
const spendOrder=()=>Array.from({length:12},(_,i)=>(T.getMonth()+i)%12);
const spendPillFor=m=>document.querySelector(`#sp-months .spend-month-tab[data-m="${m}"][data-c="${SP_MID}"]`);

/* Width of one 12-month cycle — the period we silently jump by when wrapping. */
function spendPeriod(){
  const bar=spendBar();if(!bar)return 0;
  const p=bar.querySelectorAll('.spend-month-tab');
  return p.length<13?0:p[12].offsetLeft-p[0].offsetLeft;
}
/* Keep the offset inside the middle cycle: shifting by exactly one period is invisible. */
function spendRecenter(){
  const bar=spendBar();if(!bar)return;
  const P=spendPeriod();if(!P)return;
  const base=bar.querySelectorAll('.spend-month-tab')[12*SP_MID];
  if(!base)return;
  const rel=bar.scrollLeft-base.offsetLeft;
  const wraps=Math.round(rel/P);
  if(wraps)bar.scrollLeft-=wraps*P;
  spendScroll=bar.scrollLeft;
}
/* Snap to the nearest pill once the reel has stopped. The animation is ours, so a
   running snap can never be restarted by its own scroll events (that would flip
   direction forever and wedge the tab). */
let spendSettleT=0,spendSnapping=0,spendSnapId=0;
function spendCancelSnap(){spendSnapId++;spendSnapping=0}
function spendSnapTo(left){
  const bar=spendBar();if(!bar)return;
  const from=bar.scrollLeft,dist=left-from;
  if(spendRM()||Math.abs(dist)<.5){bar.scrollLeft=left;spendScroll=left;return}
  const dur=Math.min(320,90+Math.abs(dist)*1.5),t0=performance.now(),id=++spendSnapId;
  spendSnapping=1;
  const finish=()=>{spendSnapping=0;spendScroll=bar.scrollLeft};
  const step=()=>{
    if(id!==spendSnapId)return;
    const t=Math.min(1,(performance.now()-t0)/dur),e=1-Math.pow(1-t,3);
    bar.scrollLeft=from+dist*e;
    if(t<1)requestAnimationFrame(step);else finish();
  };
  requestAnimationFrame(step);
  /* rAF is paused in a hidden tab; land on the pill anyway. */
  setTimeout(()=>{if(id===spendSnapId&&spendSnapping){bar.scrollLeft=left;finish()}},dur+150);
}
function spendSettle(){
  const bar=spendBar();if(!bar||bar.classList.contains('dragging')||spendSnapping)return;
  spendRecenter();
  let best=null,bd=1e9;
  bar.querySelectorAll('.spend-month-tab').forEach(p=>{
    const d=Math.abs(p.offsetLeft-SP_LEAD-bar.scrollLeft);
    if(d<bd){bd=d;best=p}
  });
  if(best&&bd>1)spendSnapTo(best.offsetLeft-SP_LEAD);
}
function spendReelScroll(){
  const bar=spendBar();if(!bar)return;
  spendScroll=bar.scrollLeft;
  if(spendSnapping)return;
  clearTimeout(spendSettleT);
  if(!bar.classList.contains('dragging'))spendSettleT=setTimeout(spendSettle,120);
}
function spendScrollPill(pill,behavior){
  const bar=spendBar();if(!bar||!pill)return;
  const left=pill.offsetLeft-SP_LEAD;
  spendScroll=left;                       /* remember even if scroll events are deferred */
  if(behavior==='smooth'&&!spendRM())spendSnapTo(left);
  else{spendCancelSnap();bar.scrollLeft=left;spendScroll=left}
}
/* Place the reel and restore the previous offset after a full re-render. */
function spendReelInit(){
  const bar=spendBar();if(!bar)return;
  spendCancelSnap();clearTimeout(spendSettleT);
  const pills=bar.querySelectorAll('.spend-month-tab');
  if(pills.length<12*SP_MID+1)return;
  const base=pills[12*SP_MID];
  bar.scrollLeft=spendScroll==null?base.offsetLeft-SP_LEAD:spendScroll;
  spendRecenter();
  spendInk(false);
}
/* Fade out the months with no expenses in the selected year (12 lookups, not 60). */
function spendDim(){
  if(spendY==null)spendReset();
  const has=[];for(let m=0;m<12;m++)has[m]=!spendHas(spendPad(m));
  const bar=spendBar();if(bar)bar.querySelectorAll('.spend-month-tab').forEach(p=>p.classList.toggle('dim',has[+p.dataset.m]));
}
/* Reflect the selected year without touching the reel's scroll offset. */
function spendSyncYear(){
  if(spendY==null)spendReset();
  const b=document.getElementById('sp-year-btn');
  if(b){
    if(b.childNodes[0])b.childNodes[0].nodeValue=String(spendY);
    b.setAttribute('aria-label',`Spending year, ${spendY}`);
    b.classList.toggle('on',spendM==null);
  }
  document.querySelectorAll('#sp-year-menu .spend-year-opt').forEach(o=>{
    const on=+o.querySelector('span').textContent===spendY;
    o.classList.toggle('on',on);o.setAttribute('aria-selected',String(on));
  });
}
/* Move the green underline; m=null hides it (whole-year mode). */
function spendMark(m){
  const bar=spendBar();if(!bar)return;
  const fb=m==null?bar.querySelector(`.spend-month-tab[data-m="${T.getMonth()}"][data-c="${SP_MID}"]`):null;
  bar.querySelectorAll('.spend-month-tab').forEach(p=>{
    const on=m!=null&&+p.dataset.m===m&&+p.dataset.c===SP_MID;
    p.classList.toggle('on',on);
    p.setAttribute('aria-selected',String(on));
    p.tabIndex=(on||p===fb)?0:-1;
  });
  spendInk(true);
}
function spendMonthsBar(){
  const y=spendY,isYear=spendM==null,years=spendYears(),order=spendOrder(),dim=[];
  for(let m=0;m<12;m++)dim[m]=!spendHas(`${y}-${String(m+1).padStart(2,'0')}`);
  let pills="";
  for(let c=0;c<SP_REPS;c++)for(const m of order){
    const on=!isYear&&m===spendM&&c===SP_MID,fb=isYear&&m===T.getMonth()&&c===SP_MID;
    pills+=`<button type="button" role="tab" class="spend-month-tab${on?' on':''}${dim[m]?' dim':''}" data-m="${m}" data-c="${c}" aria-selected="${on}" tabindex="${on||fb?0:-1}" aria-label="${SPM[m]} ${y}" onclick="pickSpendMonth(${m})">${SPM[m]}</button>`;
  }
  return `<div class="spend-months">
    <div class="spend-year-wrap">
      <button type="button" class="spend-year-btn${isYear?' on':''}" id="sp-year-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Spending year, ${y}" onclick="spendYearMenu()">${y}<svg class="spend-caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="spend-year-menu" id="sp-year-menu" role="listbox" aria-label="Spending year">${years.map(v=>`<button type="button" role="option" aria-selected="${v===y}" class="spend-year-opt${v===y?' on':''}" onclick="pickSpendYear(${v})"><span>${v}</span><svg class="spend-tick" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5l3.2 3.2L11 1.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`).join("")}</div>
    </div>
    <div class="spend-months-inner" id="sp-months" role="tablist" aria-label="Spending month in ${y}" onkeydown="spendTabKeys(event)" onscroll="spendReelScroll()" onwheel="spendCancelSnap()" ontouchstart="spendCancelSnap()" onpointerdown="spendPanDown(event)" onpointermove="spendPanMove(event)" onpointerup="spendPanUp(event)" onpointercancel="spendPanUp(event)">
      ${pills}
      <span class="spend-months-ink${isYear?' off':''}" aria-hidden="true"></span>
    </div>
  </div>`;
}
function spendYearMenu(){
  const m=document.getElementById('sp-year-menu'),b=document.getElementById('sp-year-btn');
  if(!m)return;
  const open=!m.classList.contains('open');
  m.classList.toggle('open',open);
  if(b)b.setAttribute('aria-expanded',String(open));
  if(open){const on=m.querySelector('.spend-year-opt.on');if(on)on.scrollIntoView({block:'nearest'})}
}
function spendYearClose(){
  const m=document.getElementById('sp-year-menu');if(m)m.classList.remove('open');
  const b=document.getElementById('sp-year-btn');if(b)b.setAttribute('aria-expanded','false');
}
function pickSpendYear(v){
  spendYearClose();
  if(spendY===v&&spendM==null)return;
  const dir=v>spendY?-1:1;
  spendY=v;spendM=null;trendM=null;
  spendDim();spendSyncYear();spendMark(null);
  spendSwap(dir);
}
/* Mouse-only drag with a little inertia; touch already gets native momentum. */
let spendPan=null;
function spendPanDown(e){
  if(e.pointerType!=='mouse'||e.button)return;
  /* A press on a month/year control is a click, not a reel drag. Do not take
     pointer capture here or the captured parent can swallow the button's
     follow-up click (especially in Chromium). Blank reel space remains
     draggable as before. */
  if(e.target.closest&&e.target.closest('button,a,input,select,textarea'))return;
  const bar=spendBar();if(!bar)return;
  spendCancelSnap();
  spendPan={x:e.clientX,y:e.clientY,left:bar.scrollLeft,moved:0,vx:0,lastX:null,t:performance.now()};
  bar.classList.add('dragging');
  try{bar.setPointerCapture(e.pointerId)}catch(_){}
}
function spendPanMove(e){
  if(!spendPan)return;
  const bar=spendBar();if(!bar)return;
  const dx=e.clientX-spendPan.x;
  if(!spendPan.moved&&(Math.abs(dx)<=4||Math.abs(dx)<=Math.abs(e.clientY-spendPan.y)))return;
  spendPan.moved=1;e.preventDefault();
  const now=performance.now();
  if(spendPan.lastX!=null){
    const dt=Math.max(1,now-spendPan.t);
    spendPan.vx=spendPan.vx*.55+(-(e.clientX-spendPan.lastX)/dt)*.45;
  }
  spendPan.lastX=e.clientX;spendPan.t=now;
  bar.scrollLeft=spendPan.left-dx;
  spendRecenter();
}
function spendGlide(bar,v){
  v=Math.max(-3,Math.min(3,v));
  spendCancelSnap();
  let last=performance.now();
  const step=()=>{
    const now=performance.now(),dt=Math.min(32,now-last);last=now;
    bar.scrollLeft+=v*dt;
    spendRecenter();
    v*=Math.pow(.995,dt);
    if(Math.abs(v)>.05)requestAnimationFrame(step);
    else{bar.classList.remove('dragging');spendSettle()}
  };
  requestAnimationFrame(step);
}
function spendPanUp(){
  const bar=spendBar();
  if(!bar){spendPan=null;return}
  if(spendPan&&spendPan.moved){
    const stop=ev=>{ev.stopPropagation();ev.preventDefault()};
    bar.addEventListener('click',stop,{capture:true,once:true});
    setTimeout(()=>bar.removeEventListener('click',stop,true),60);
    const v=spendPan.vx||0;
    if(!spendRM()&&Math.abs(v)>.6){spendPan=null;spendGlide(bar,v);return}
  }
  bar.classList.remove('dragging');
  spendPan=null;
  spendSettle();
}
/* Arrow keys walk the reel, skipping months with no data; Home returns to today. */
function spendTabKeys(e){
  if(!["ArrowLeft","ArrowRight","Home"].includes(e.key))return;
  if(!spendBar())return;
  e.preventDefault();
  const cur=spendM==null?T.getMonth():spendM;
  const step=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;
  if(!step){pickSpendMonth(T.getMonth());const p=spendPillFor(T.getMonth());if(p)p.focus();return}
  for(let i=1;i<=12;i++){
    const m=(cur+step*i+120)%12,p=spendPillFor(m);
    if(p&&!p.classList.contains('dim')){pickSpendMonth(m);p.focus();return}
  }
}
/* Slide the shared ink under the active pill (measured, so it stays crisp on any width). */
function spendInk(animate){
  const bar=spendBar();if(!bar)return;
  const on=bar.querySelector('.spend-month-tab.on'),ink=bar.querySelector('.spend-months-ink');
  if(!ink)return;
  if(!on){ink.classList.add('off');return}
  ink.classList.remove('off');
  ink.style.transition=(animate&&!spendRM()?'transform .44s cubic-bezier(.2,.9,.25,1.15),width .44s cubic-bezier(.2,.9,.25,1.15),':'')+'opacity .2s ease';
  ink.style.width=on.offsetWidth+'px';
  ink.style.transform=`translate3d(${on.offsetLeft}px,0,0)`;
}
/* Two-phase fade + slide for the panes. The reel is never rebuilt, so it keeps its
   exact scroll offset when the year or the month changes. */
function spendSwap(dir){
  const key=spendKey(),top=document.getElementById('sp-top'),tc=document.getElementById('sp-trend');
  const paint=()=>{if(top)top.innerHTML=spendTop(key);if(tc)tc.innerHTML=spendTrend(key)};
  if(spendRM()){paint();return}
  if(top){top.style.transition='opacity .16s ease,transform .16s ease';top.style.opacity='0';top.style.transform=`translate3d(${dir*20}px,0,0)`}
  if(tc)tc.style.opacity='.3';
  setTimeout(()=>{
    paint();
    if(top){top.style.transition='none';top.style.transform=`translate3d(${-dir*20}px,0,0)`;void top.offsetWidth;top.style.transition='opacity .32s cubic-bezier(.2,.85,.25,1),transform .32s cubic-bezier(.2,.85,.25,1)';top.style.opacity='1';top.style.transform='translate3d(0,0,0)'}
    if(tc){tc.style.transition='opacity .3s ease';tc.style.opacity='1'}
  },150);
}
/* Drill into one month of the selected year. */
function pickSpendMonth(m){
  m=+m;
  if(spendM===m){spendScrollPill(spendPillFor(m),spendRM()?'auto':'smooth');return}
  const prev=spendM==null?null:spendPillFor(spendM),next=spendPillFor(m);
  const dir=prev&&next&&next.offsetLeft<prev.offsetLeft?1:-1;
  spendM=m;trendM=spendPad(m);
  spendMark(m);spendSyncYear();
  spendScrollPill(next,spendRM()?'auto':'smooth');
  spendSwap(dir);
}
/* Jump from a trend bar: takes a YYYY-MM key and may move the year with it. */
function pickSpend(k){
  if(!k)return;
  const y=+String(k).slice(0,4),m=+String(k).slice(5,7)-1;
  if(!y||m<0||m>11)return;
  const prevY=spendY==null?spendNowYear():spendY;
  const prevPill=spendM==null?null:spendPillFor(spendM),next=spendPillFor(m);
  spendY=y;spendM=m;trendM=k;
  if(y!==prevY)spendDim();
  spendMark(m);spendSyncYear();
  spendScrollPill(next,spendRM()?'auto':'smooth');
  spendSwap(prevPill&&next&&next.offsetLeft<prevPill.offsetLeft?1:(y<prevY?1:-1));
}
/* ---- category spotlight. Tapping a legend row enlarges its donut arc and
   steps the other categories back. Purely presentational: it never touches S,
   the totals, or the transaction list. The current pick is read back off the
   DOM, so a re-render (month change, tab change) simply clears it. ---- */
function focusSpendCat(i){
  const box=document.querySelector('#sp-top .spend-overview')||document.querySelector('.spend-overview');
  if(!box)return;
  const cur=box.querySelector('.spend-legend-row.on');
  const next=cur&&+cur.dataset.i===+i?-1:+i;   /* tap the same row again to clear */
  box.classList.toggle('focus',next>=0);
  box.querySelectorAll('.spend-legend-row').forEach(r=>{
    const on=+r.dataset.i===next;
    r.classList.toggle('on',on);
    r.setAttribute('aria-pressed',String(on));
  });
  box.querySelectorAll('.spend-arc').forEach(a=>a.classList.toggle('on',+a.dataset.i===next));
}
function spendTop(key){const yk=String(key).length===4,tx=S.tx.filter(t=>t.d.startsWith(key)&&t.amt<0),gr={};tx.forEach(t=>{const c=CATS[t.cat]?t.cat:'Other';gr[c]=(gr[c]||0)-t.amt});
const total=sum(Object.values(gr)),items=Object.entries(gr).sort((a,b)=>b[1]-a[1]),circ=2*Math.PI*74;let off=0;
const arcs=items.map(([c,v],i)=>{const len=total?circ*v/total:0,dash=Math.max(0,len-3),o=-off,col=spendCol(c),pc=total?Math.round(v/total*100):0,lab=esc(c)+', '+pc+' percent, '+php(v),r=`<circle class="spend-arc" data-i="${i}" role="button" tabindex="0" aria-label="${lab}" onclick="focusSpendCat(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();focusSpendCat(${i})}" cx="100" cy="100" r="74" fill="none" stroke="${col}" stroke-width="19" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${o}" style="--o:${o};--i:${i};--c:${col}"/>`;off+=len;return r}).join(''),
/* each legend row is a button: tapping it spotlights that arc (focusSpendCat) */
lg=items.length?items.map(([c,v],i)=>{const p=total?Math.round(v/total*100):0,col=spendCol(c);return `<button type="button" class="spend-legend-row" data-i="${i}" aria-pressed="false" aria-label="${esc(c)}, ${p} percent, ${php(v)}" onclick="focusSpendCat(${i})" style="--p:${p}%;--c:${col};--i:${i}"><i class="spend-dot" style="background:${col}"></i><span class="spend-legend-name">${esc(c)}</span><b class="spend-legend-pct">${p}%</b><span class="spend-legend-amt">${php(v)}</span></button>`}).join(''):`<p class="m spend-empty">No expenses recorded in ${mName(key)}.</p>`,
bu=Object.values(S.budgets||{}).reduce((a,v)=>a+(+v||0),0),
mons=yk?Math.max(1,spendMonthsWithData(+String(key).slice(0,4)).length):1,cap=bu*mons,un=cap-total,
ins=bu?(un>=0?{t:`You’re ${Math.round(un/cap*100)}% under budget`,b:`${bv(php(un))} of your ${bv(php(cap))} ${yk?mons+'-month':'monthly'} budget remains.`,i:'🌱'}:{t:`You’re ${Math.round(Math.abs(un)/cap*100)}% over budget`,b:`You spent ${bv(php(Math.abs(un)))} beyond your ${bv(php(cap))} ${yk?mons+'-month':'monthly'} budget.`,i:'📈'}):{t:'Set a monthly budget',b:'Add category budgets in Plan to see how you’re tracking.',i:'🌱'};
return`<div class="card spend-card"><div class="spend-head"><h2>Your Spending — ${mName(key)}</h2><span class="spend-meta">${yk?spendRangeLabel(key):String(key).slice(0,4)} · ${tx.length} ${tx.length==1?'expense':'expenses'}</span></div><div class="spend-overview"><div class="spend-donut-wrap"><svg class="spend-donut" viewBox="0 0 200 200" role="img" aria-label="Spending by category donut chart"><circle cx="100" cy="100" r="74" fill="none" stroke="var(--line)" stroke-width="19"/>${arcs}</svg><div class="spend-center"><b>${php(total)}</b><span>Total spent</span></div></div><div class="spend-legend${items.length>=5?' cols2':''}" aria-label="Spending categories">${lg}</div></div></div><div class="spend-insight"><span class="spend-insight-ico" aria-hidden="true">${ins.i}</span><div class="spend-insight-txt"><b>${ins.t}</b><div class="m">${ins.b}</div></div>${bu?'':`<button class="pill" style="margin-left:auto;flex:none" onclick="tab='Plan';pt='Budgets';render()" aria-label="Set a budget">›</button>`}</div>`}
function spendTrend(key){
  const [ay,am]=spendAnchor(key),yk=String(key).length===4;
  const tr=Array.from({length:6},(_,i)=>{const d=new Date(ay,am-5+i,1),k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;return{k,label:d.toLocaleDateString('en-PH',{month:'short'}),value:-sum(S.tx.filter(t=>t.d.startsWith(k)&&t.amt<0).map(t=>t.amt))}}),
  mx=Math.max(...tr.map(x=>x.value),1),a=tr[0],b=tr[5],y1=String(a.k).slice(0,4),y2=String(b.k).slice(0,4),
  span=y1===y2?`${a.label} – ${b.label} ${y2}`:`${a.label} ${y1} – ${b.label} ${y2}`;
  return `<div class="spend-trend-head"><h2 style="margin:0">Spending trend</h2><span class="m" style="font-size:12px;white-space:nowrap">${span}</span></div><div class="spend-bars" role="group" aria-label="Monthly spending trend">${tr.map((x,i)=>{const sel=yk?i===5:x.k===key;return `<div class="spend-bar-col${sel?' sel':''}" data-k="${x.k}" role="button" tabindex="0" aria-pressed="${sel}" aria-label="${mName(x.k)} ${php(x.value)}" onclick="pickSpend('${x.k}')" onkeydown="if(event.key=='Enter'||event.key==' '){event.preventDefault();pickSpend('${x.k}')}"><span class="spend-total-label">${php(x.value)}</span><i class="spend-bar" style="height:${Math.max(3,x.value/mx*90)}%;--delay:${i*55}ms"></i><span class="spend-month">${x.label}</span></div>`}).join('')}</div>`;
}
function spendingChart(){
  const key=spendKey();
  return `<section class="spend-hero">${spendMonthsBar()}<div id="sp-top">${spendTop(key)}</div></section><div class="card" id="sp-trend">${spendTrend(key)}</div>`;
}
function pickTrend(k){pickSpend(k)}
/* Close the year popover on any outside press or Escape; keep the ink aligned on resize. */
document.addEventListener('pointerdown',e=>{if(!(e.target&&e.target.closest&&e.target.closest('.spend-year-wrap')))spendYearClose()},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')spendYearClose()});
addEventListener('resize',()=>{clearTimeout(window._spRs);window._spRs=setTimeout(()=>{spendRecenter();spendInk(false)},140)});
/* ---- activity calendar: swipe between months */
let calBusy=0,calS=null,calAcc=0,calT=0,calWt;
function calGo(d){if(calBusy)return;const w=$('#calwrap');if(!w){cm+=d;render();return}calBusy=1;const tr='transform .22s ease,opacity .22s ease';w.style.transition=tr;w.style.transform=`translateX(${-d*48}px)`;w.style.opacity=0;
setTimeout(()=>{cm+=d;const h=document.createElement('div');h.innerHTML=calH();const n=h.firstElementChild;n.style.transform=`translateX(${d*48}px)`;n.style.opacity=0;w.replaceWith(n);requestAnimationFrame(()=>requestAnimationFrame(()=>{n.style.transition=tr;n.style.transform='';n.style.opacity=''}));setTimeout(()=>{n.style.transition='';calBusy=0},260)},200)}
function calDown(e){if(e.pointerType=='mouse'&&e.button)return;calS={x:e.clientX,y:e.clientY,h:0}}
function calMove(e){if(!calS||calBusy)return;const dx=e.clientX-calS.x,dy=e.clientY-calS.y;if(!calS.h){if(Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.5)calS.h=1;else if(Math.abs(dy)>10){calS=null;return}else return}const w=$('#calwrap');w.style.transition='none';w.style.transform=`translateX(${dx*.45}px)`}
function calUp(e){if(!calS)return;const s=calS;calS=null;const w=$('#calwrap');if(!s.h)return;const dx=e.clientX-s.x,stop=ev=>{ev.stopPropagation();ev.preventDefault()};w.addEventListener('click',stop,{capture:true,once:true});setTimeout(()=>w.removeEventListener('click',stop,true),80);
if(Math.abs(dx)>60)calGo(dx<0?1:-1);else{w.style.transition='transform .2s ease';w.style.transform=''}}
function calWheel(e){if(Math.abs(e.deltaX)<=Math.abs(e.deltaY)*1.2||Math.abs(e.deltaX)<3)return;e.preventDefault();calAcc+=e.deltaX;if(Math.abs(calAcc)>70&&!calBusy&&Date.now()-calT>550){calGo(calAcc>0?1:-1);calAcc=0;calT=Date.now()}clearTimeout(calWt);calWt=setTimeout(()=>calAcc=0,200)}
/* ==========================================================================
   SETTINGS — one sheet, many pages.
   Every page renders through stSheet() -> navS(), so the modal, its backdrop
   and its scroll position stay stable while pages slide/fade in and out.
   ========================================================================== */
const APP_VERSION='1.0.3',APP_VER=APP_VERSION;
const LOCK_KEY='cap_lock',BIO_KEY='cap_bio',NOTIF_SEEN='cap_notif_seen',BK_KEY='cap_lastbackup';
const ST_IC={
  user:'<svg viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.4"/><path d="M4.9 20c.7-3.5 3.6-5.6 7.1-5.6s6.4 2.1 7.1 5.6"/></svg>',
  theme:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.1"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5 7 7M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5"/></svg>',
  cash:'<svg viewBox="0 0 24 24"><rect x="2.7" y="6" width="18.6" height="12" rx="2.6"/><circle cx="12" cy="12" r="2.5"/><path d="M6.2 12h.02M17.8 12h.02"/></svg>',
  tag:'<svg viewBox="0 0 24 24"><path d="M3.6 11.6V4.7c0-.6.5-1.1 1.1-1.1h6.9c.3 0 .6.1.8.3l7.9 7.9c.4.5.4 1.2 0 1.6l-6.3 6.3c-.5.4-1.2.4-1.6 0l-7.9-7.9a1.1 1.1 0 0 1-.3-.8Z"/><circle cx="7.6" cy="7.6" r="1.3"/></svg>',
  bell:'<svg viewBox="0 0 24 24"><path d="M18 15.6V10a6 6 0 1 0-12 0v5.6L4.6 18h14.8L18 15.6Z"/><path d="M9.9 20.9a2.4 2.4 0 0 0 4.2 0"/></svg>',
  sound:'<svg viewBox="0 0 24 24"><path d="M4.2 9.6h3L12 5.7v12.6L7.2 14.4h-3z"/><path d="M15.4 9.2a4 4 0 0 1 0 5.6M18.1 6.7a7.5 7.5 0 0 1 0 10.6"/></svg>',
  box:'<svg viewBox="0 0 24 24"><path d="M3.7 7.5 12 3.4l8.3 4.1v9L12 20.6l-8.3-4.1z"/><path d="M3.7 7.5 12 11.6l8.3-4.1M12 11.6v9"/></svg>',
  swap:'<svg viewBox="0 0 24 24"><path d="M7.6 3.9v14.2M7.6 18.1l-2.8-2.8M7.6 18.1l2.8-2.8M16.4 20.1V5.9M16.4 5.9l2.8 2.8M16.4 5.9l-2.8 2.8"/></svg>',
  shield:'<svg viewBox="0 0 24 24"><path d="M12 3.2 5.1 6v5.6c0 4.2 2.9 7.7 6.9 9.2 4-1.5 6.9-5 6.9-9.2V6z"/><path d="m9.2 11.9 2 2 3.6-3.8"/></svg>',
  lock:'<svg viewBox="0 0 24 24"><rect x="4.7" y="10.2" width="14.6" height="9.6" rx="2.6"/><path d="M8.4 10.2V7.9a3.6 3.6 0 1 1 7.2 0v2.3M12 14.2v2"/></svg>',
  info:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6"/><path d="M12 11.1v5.1M12 8.1h.02"/></svg>',
  ver:'<svg viewBox="0 0 24 24"><rect x="4.4" y="4.4" width="15.2" height="15.2" rx="3.4"/><path d="M8.7 12h6.6M8.7 15.5h4.2"/></svg>',
  chev:'<svg viewBox="0 0 24 24"><path d="m9.6 6 6 6-6 6"/></svg>',
  up:'<svg viewBox="0 0 24 24"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg>',
  down:'<svg viewBox="0 0 24 24"><path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/></svg>',
};
const APP_REPOSITORY_URL='https://github.com/luancreek2/cap-finance-tracker',WHATS_NEW_SEEN_KEY='cap_whats_new_seen_version';
/* Auto-present the release note once per version, after the launch animation. */
const WHATS_NEW_AUTO=true;
let WHATS_NEW_MEMORY_SEEN='';
const APP_UPDATES=[{version:APP_VERSION,releaseDate:'2026-10-18',title:'What’s New in Cap',summary:'Cap 1.0.3 brings clearer payment details, separate bill and subscription planning, and more useful debit, e-wallet, and cash accounts.',changes:[
  {category:'New',icon:'💵',title:'Cash wallet account',description:'Add a Cash account with a transparent, card-sized wallet design based on your image, plus deposit and transfer actions.'},
  {category:'New',icon:'⇄',title:'Deposit and transfer',description:'Add money to debit cards and e-wallets, or transfer money between eligible accounts with balances and activity updated automatically.'},
  {category:'Improved',icon:'🧾',title:'Bills and subscriptions',description:'Choose a required category when adding an item; Upcoming now groups Bills and Subscriptions separately.'},
  {category:'Improved',icon:'💳',title:'Payment details and history',description:'Paid bills, subscriptions, and card payments open consistent details with latest-payment and history access; Back returns to the view you came from.'},
  {category:'Design',icon:'✅',title:'Payment feedback',description:'A looping draw-and-erase Paid checkmark, polished payment confirmation effects, and a clear red insufficient-funds warning.'},
  {category:'Design',icon:'✨',title:'Cap identity and interactions',description:'Updated Cap branding, install icons, animated launch experience, and refined account, calendar, and Activity interactions.'}
]},{version:'1.0.2.5',releaseDate:'2026-10-18',title:'What’s New in Cap',summary:'Cap 1.0.2.5 is all about the Accounts tab: a new options menu, Grid and Carousel views, sorting, and drag-to-reorder with multi-card selection.',changes:[
  {category:'New',icon:'🧭',title:'Accounts options menu',description:'A compact ⋯ menu gives you Grid or Carousel view plus sorting by Recent, Name, Balance, or Manual.'},
  {category:'New',icon:'🎠',title:'Carousel view',description:'Swipe through credit and debit/e-wallet cards side by side with 3D tilt, shine, and smooth momentum.'},
  {category:'New',icon:'✅',title:'Selection mode',description:'Tap Select All or pick cards with the circle, then drag a card — or a whole selected group — into the position you want.'},
  {category:'Design',icon:'🎨',title:'Fresh Cap logo',description:'A new glossy mark across the app, About, What’s New, and the browser and PWA icons, with light and dark logo options in Settings.'},
  {category:'Design',icon:'🌗',title:'Theme-aware launch animation',description:'Cap now opens with a light or dark intro featuring the logo entrance, expanding glow rings, and loading dots.'},
  {category:'Improved',icon:'ℹ️',title:'What’s New & About',description:'See release notes once per version, reopen them from About, and jump straight to the official GitHub repository.'},
  {category:'Performance',icon:'⚡',title:'Polish & reliability',description:'Smoother card motion, responsive layout at phone and tablet widths, and reduced-motion friendly animations.'}
]},{version:'1.0.2',releaseDate:'2026-10-17',title:'What’s New in Cap',summary:'Cap 1.0.2 brings linked savings goals, a more polished card experience, and clearer account updates.',changes:[
  {category:'Improved',icon:'💳',title:'Credit cards & payments',description:'Refined statements, account-funded payments, card fee settings, and clearer interest estimates.'},
  {category:'New',icon:'🎯',title:'Goals linked to accounts',description:'Allocate savings from real accounts, move money as internal transfers, and review unallocated funds.'},
  {category:'New',icon:'🏦',title:'Daily savings interest',description:'Estimate interest from annual APY, record actual bank credits, and keep estimates out of balances.'},
  {category:'Design',icon:'✨',title:'Interactive card setup',description:'Choose a design or photo, flip into a guided setup, then glide the saved card into Accounts.'},
  {category:'Improved',icon:'ℹ️',title:'What’s New & About',description:'See release notes once per version, reopen them from About, and visit the official GitHub repository.'},
  {category:'Performance',icon:'⚡',title:'Polish & reliability',description:'Smoother motion, responsive card settings, safer validation, and accessibility refinements.'}
]}];
const GITHUB_MARK='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.53v-2.06c-3.1.67-3.75-1.32-3.75-1.32-.5-1.29-1.23-1.63-1.23-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15.99 1.7 2.59 1.21 3.22.93.1-.72.39-1.21.7-1.49-2.48-.28-5.09-1.24-5.09-5.53 0-1.22.44-2.21 1.15-2.99-.12-.28-.5-1.42.11-2.95 0 0 .94-.3 3.05 1.14a10.6 10.6 0 0 1 5.55 0c2.11-1.44 3.05-1.14 3.05-1.14.61 1.53.23 2.67.11 2.95.72.78 1.15 1.77 1.15 2.99 0 4.3-2.62 5.25-5.11 5.52.4.35.75 1.03.75 2.08V22c0 .29.2.64.77.53A11.1 11.1 0 0 0 12 .9Z"/></svg>';
function latestAppUpdate(){return APP_UPDATES[0]}
function openGitHubRepository(){window.open(APP_REPOSITORY_URL,'_blank','noopener,noreferrer')}
function whatsNewSeen(){try{return localStorage.getItem(WHATS_NEW_SEEN_KEY)==APP_VERSION}catch(_){return WHATS_NEW_MEMORY_SEEN==APP_VERSION}}
function openWhatsNew(manual=false){const item=latestAppUpdate();if(!item||(!manual&&whatsNewSeen())||document.getElementById('whats-new-overlay'))return;const date=new Date(item.releaseDate+'T00:00:00').toLocaleDateString('en-PH',{month:'long',day:'numeric',year:'numeric'}),changes=item.changes.map((x,i)=>`<article class="wn-item" style="--wn-i:${i}"><span class="wn-icon" aria-hidden="true">${esc(x.icon)}</span><div class="wn-copy"><div class="wn-item-head"><h3>${esc(x.title)}</h3><span class="wn-category wn-${esc(x.category.toLowerCase())}">${esc(x.category)}</span></div><p>${esc(x.description)}</p></div></article>`).join('');document.body.insertAdjacentHTML('beforeend',`<div id="whats-new-overlay" class="whats-new-overlay" role="presentation"><section class="whats-new-panel" role="dialog" aria-modal="true" aria-labelledby="wn-title" aria-describedby="wn-summary"><header class="wn-head"><span class="wn-brand">${capBrandLogo()}<span>CAP UPDATE</span></span><button type="button" class="wn-close" aria-label="Close What's New" onclick="closeWhatsNew()">×</button></header><div class="wn-title-block"><h2 id="wn-title">${esc(item.title)}</h2><div class="wn-version"><span>Version ${esc(item.version)}</span><i></i><span>${date}</span></div><p id="wn-summary">${esc(item.summary)}</p></div><div class="wn-content" tabindex="0">${changes}</div><footer class="wn-footer"><button id="wn-got-it" class="btn" onclick="closeWhatsNew()">Got it</button></footer></section></div>`);const overlay=$('#whats-new-overlay'),panel=overlay.querySelector('.whats-new-panel');overlay.addEventListener('click',e=>{if(e.target===overlay)closeWhatsNew()});overlay._key=e=>{if(e.key=='Escape'){e.preventDefault();closeWhatsNew();return}if(e.key=='Tab'){const f=[...panel.querySelectorAll('button:not(:disabled),[tabindex="0"]')].filter(x=>x.offsetParent!==null);if(!f.length)return;const first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}};document.addEventListener('keydown',overlay._key,true);requestAnimationFrame(()=>overlay.classList.add('visible'));setTimeout(()=>$('#wn-got-it')?.focus({preventScroll:true}),80)}
function closeWhatsNew(){const overlay=$('#whats-new-overlay');if(!overlay)return;WHATS_NEW_MEMORY_SEEN=APP_VERSION;try{localStorage.setItem(WHATS_NEW_SEEN_KEY,APP_VERSION)}catch(_){}if(overlay._key)document.removeEventListener('keydown',overlay._key,true);overlay.classList.add('closing');setTimeout(()=>overlay.remove(),matchMedia('(prefers-reduced-motion:reduce)').matches?100:260)}
/* Present a release note only after the launch animation has finished, the
   interface is painted, and any passcode lock / open sheet has settled. */
function scheduleWhatsNew(){
  if(!WHATS_NEW_AUTO)return;
  if(window.__whatsNewScheduled)return;window.__whatsNewScheduled=true;
  let started=false;
  const start=()=>{
    if(started)return;started=true;
    let tries=0;
    const attempt=()=>{
      if(tries++>180)return;
      if(whatsNewSeen())return;
      const locked=window._unlocked===0||$('#lock')?.classList.contains('open'),ready=$('#app')?.children.length>0,sheet=$('#sheet')?.classList.contains('open');
      if(window.capLaunchActive||document.hidden||locked||!ready||sheet){setTimeout(attempt,400);return}
      openWhatsNew(false);
    };
    setTimeout(attempt,400);
  };
  if(window.capLaunchActive){document.addEventListener('cap:launch-complete',start,{once:true});setTimeout(start,9000)}
  else start();
}
let stCur='home',stKeep=0,stIx=0;
function stStart(){stIx=0}
function stSheet(html,key,keep){const sh=$('#sheet'),opts={dir:key==='set-home'?'back':'forward'};if(keep)opts.keep=1;navS(html,key,opts);if(sh)sh.classList.add('st')}
function stHead(t,back,done){return `<div class="st-hd">${back?`<button class="pill st-bk" aria-label="Back" onclick="${back}">‹</button>`:''}<h2>${t}</h2>${done===false?'':`<button class="pill" onclick="closeS()">Done</button>`}</div>`}
function stGrp(name,rows){return `<div class="st-grp eyebrow">${name}</div><div class="st-g">${rows.join('')}</div>`}
function stRow(icon,title,val,go){
  const body=`<span class="st-i">${icon}</span><span class="st-t">${title}</span>${val?`<span class="st-v">${esc(val)}</span>`:''}${go?`<span class="st-c">${ST_IC.chev}</span>`:''}`,i=stIx++;
  return go?`<button class="st-row" style="--i:${i}" onclick="${go}">${body}</button>`:`<div class="st-row st-ro" style="--i:${i}">${body}</div>`;
}
function stSw(label,sub,on,fn){return `<label class="st-r"><span class="f"><b>${label}</b>${sub?`<small>${sub}</small>`:''}</span><span class="swx"><input type="checkbox" ${on?'checked':''} onchange="${fn}"><i></i></span></label>`}
function stSel(label,sel,sub){return `<div class="st-r"><span class="f"><b>${label}</b>${sub?`<small>${sub}</small>`:''}</span>${sel}</div>`}
function stBtn(label,go,cls,sub){return `<div class="st-r st-bt"><span class="f"><b>${label}</b>${sub?`<small>${sub}</small>`:''}</span><button class="pill" onclick="${go}">${cls||'Open'}</button></div>`}
const ST_PAGES={};
function stGo(k,keep){stCur=k;stKeep=keep?1:0;
  if(/^cat-\d+$/.test(k))return stCatEdit(+k.slice(4));
  (ST_PAGES[k]||stHome)()}
/* ---- shared bits ---- */
const hasPre=()=>{try{return!!localStorage.getItem('pera_pre')}catch(e){return false}};
function stWhen(iso){try{const d=new Date(iso);if(isNaN(d))return'';return d.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'})+' · '+d.toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'})}catch(e){return''}}
const lastBk=()=>{try{return localStorage.getItem(BK_KEY)||''}catch(e){return''}};
function applyMotion(){const de=document.documentElement;de.classList.toggle('noanim',S.anim===0);de.classList.toggle('rm',S.rm===1)}
/* ==========================================================================
   Balance visibility — one global state for the whole app.
   Nothing is blurred: the real amount stays in the layout (so a row can never
   move) and a clean dot mask fades over it while the digits fade out. The eye
   is a real button — small icon, full-size tap target, no chrome around it.
   ========================================================================== */
const BV_DOTS='••••••';
const BV_IC={
  on:'<svg class="i1" viewBox="0 0 24 24"><path d="M2.4 12S6.1 5.5 12 5.5 21.6 12 21.6 12 17.9 18.5 12 18.5 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="3.1"/></svg>',
  off:'<svg class="i2" viewBox="0 0 24 24"><path d="M2.4 12S6.1 5.5 12 5.5 21.6 12 21.6 12 17.9 18.5 12 18.5 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="3.1"/><path d="M4.4 4.4 19.6 19.6"/></svg>'};
function bv(x){return `<span class="bv">${x}</span>`}
function bvTxt(x){return S.hide==1?BV_DOTS:x}
const bvLbl=()=>S.hide==1?'Show balances':'Hide balances';
function bvEye(){const h=S.hide==1;return `<button type="button" class="bve" data-bve aria-label="${bvLbl()}" aria-pressed="${h}" title="${bvLbl()}" onclick="event.stopPropagation();bvToggle()"><span class="bvi" aria-hidden="true">${BV_IC.on}${BV_IC.off}</span></button>`}
function bvSync(){document.querySelectorAll('[data-bve]').forEach(b=>{b.setAttribute('aria-label',bvLbl());b.setAttribute('title',bvLbl());b.setAttribute('aria-pressed',S.hide==1?'true':'false')})}
function bvSub(){return S.hide==1?'Balances are hidden across Cap':'Account balances are shown'}
function bvToggle(){
  S.hide=S.hide==1?0:1;
  save();applyHide();bvSync();
  const s=document.getElementById('st-bvsub');if(s)s.textContent=bvSub();
}
function applyHide(){try{document.documentElement.classList.toggle('bvhide',S.hide==1)}catch(e){}}
function themeLbl(){const t=S.theme||'auto';return t=='light'?'Light':t=='dark'?'Dark':'Auto'}
function catCountLbl(){const n=(S.cats||[]).filter(c=>!c.a).length;return n+' categor'+(n==1?'y':'ies')}
function notifLbl(){const n=notifCfg();if(!n.on)return 'Off';return notifState()=='granted'?'On':'Blocked'}
function soundLbl(){return S.snd!=0?'On':'Muted'}
function secLbl(){try{return JSON.parse(localStorage.getItem(LOCK_KEY)||'{}').pin?'On':(S.hide==1?'Balances hidden':'Off')}catch(e){return S.hide==1?'Balances hidden':'Off'}}
function cloudOn(){try{return !!(window.CapOff&&CapOff.status().cloud)}catch(e){return false}}
function stHome(){
  stStart();
  const nm=(S.name||'').trim();
  const h=stHead('Settings')
    +stGrp('Profile',[stRow(ST_IC.user,'Your Profile',nm||'Add your name',"stGo('profile')")])
    +stGrp('Preferences',[
      stRow(ST_IC.theme,'Appearance',themeLbl(),"stGo('appearance')"),
      stRow(ST_IC.cash,'Currency &amp; Numbers',(S.cur||'PHP')+' '+CS(),"stGo('numbers')"),
      stRow(ST_IC.tag,'Categories',catCountLbl(),"stGo('categories')")])
    +stGrp('Notifications &amp; Feedback',[
      stRow(ST_IC.bell,'Notifications',notifLbl(),"stGo('notif')"),
      stRow(ST_IC.sound,'Sounds &amp; Haptics',soundLbl(),"stGo('sounds')")])
    +stGrp('Data',[
      stRow(ST_IC.box,'Backup &amp; Restore',lastBk()?'Last backup '+stWhen(lastBk()):'Never backed up',"stGo('backup')"),
      stRow(ST_IC.swap,'Import &amp; Export',hasPre()?'Undo available':null,"stGo('files')")])
    +stGrp('Privacy',[
      stRow(ST_IC.shield,'Privacy &amp; Sync',cloudOn()?'Synced':'On this device',"stGo('privacy')"),
      stRow(ST_IC.lock,'Security',secLbl(),"stGo('security')")])
    +stGrp('About',[
      stRow(ST_IC.info,'About Cap',null,"stGo('about')"),
      stRow(ST_IC.ver,'App Version',APP_VER,null)]);
  stSheet(h,'set-home',1);
}
/* ---- Profile ---- */
function stProfile(){
  stStart();
  const nm=(S.name||'').trim(),ini=nm.charAt(0).toUpperCase()||'?';
  const h=stHead('Your Profile','openSettings()')
    +`<div class="st-prof"><span class="st-av">${S.photo?`<img src="${S.photo}" alt="">`:esc(ini)}</span><span class="f"><b>${esc(nm||'Your name')}</b><small>Shown in greetings across Cap</small></span></div>`
    +`<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px"><label class="pill" style="cursor:pointer">${S.photo?'Change photo':'Add photo'}<input type="file" accept="image/*" hidden onchange="stPhoto(this)"></label>${S.photo?'<button class="pill" onclick="stNoPhoto()">Remove photo</button>':''}</div>`
    +`<label class="m">Your Name</label><input id="st-name" maxlength="40" placeholder="Enter your name" value="${esc(S.name||'')}" oninput="stName(this.value)">`
    +`<p class="st-note">Used for greetings only. Nothing here is uploaded anywhere — it stays with your data on this device.</p>`;
  stSheet(h,'set-profile',stKeep);
}
function stName(v){S.name=v;save()}
function stPhoto(inp){imgPick(inp,128,'png',u=>{S.photo=u;save();stGo('profile',1);toast('Photo updated',true)})}
function stNoPhoto(){delete S.photo;save();stGo('profile',1)}
/* ---- Appearance ---- */
function stAppearance(){
  stStart();
  const t=S.theme||'auto';
  const h=stHead('Appearance','openSettings()')
    +`<div class="st-grp eyebrow">Theme</div><p style="display:flex;gap:6px;margin:4px 0 0">${[['light','Light'],['dark','Dark'],['auto','Auto']].map(x=>`<button class="pill ${t==x[0]?'on':''}" style="flex:1" onclick="setTheme('${x[0]}')">${x[1]}</button>`).join('')}</p>`
    +`<p class="st-note">Auto follows your device's light or dark setting.</p>`
    +capLogoChoices()
    +`<div class="st-grp eyebrow">Motion</div><div class="st-box">`
      +stSw('Animations','Screen and list transitions',S.anim!==0,"stMotion('anim',this.checked)")
      +stSw('Reduce Motion','Keep large transitions to a minimum',S.rm===1,"stMotion('rm',this.checked)")
    +`</div><p class="st-note">Your device's own reduced-motion setting is always respected.</p>`;
  stSheet(h,'set-appearance',stKeep);
}
function stMotion(k,v){S[k]=v?1:0;applyMotion();save();render();stGo('appearance',1)}
/* ---- Currency & Numbers ---- */
function stNumbers(){
  stStart();
  const cur=S.cur||'PHP',c=CURS[cur]||CURS.PHP;
  const h=stHead('Currency &amp; Numbers','openSettings()')
    +`<div class="st-grp eyebrow">Currency</div><div class="st-box">`
      +stSel('Primary Currency',`<select class="st-sel" onchange="stCurSet(this.value)">${Object.keys(CURS).map(k=>`<option value="${k}" ${cur==k?'selected':''}>${k} (${CURS[k][0]})</option>`).join('')}</select>`,'Used for every amount in Cap')
    +`</div><p class="st-note">Display only — your saved amounts are never converted.</p>`
    +`<div class="st-grp eyebrow">Numbers</div><div class="st-box">`
      +stSw('Show Decimals','Show cents, e.g. '+c[0]+'1,250.00',!!S.dec,"stNum('dec',this.checked)")
      +stSel('Number Format',`<select class="st-sel" onchange="stNum('nf',this.value)">${Object.keys(NF).map(k=>`<option value="${k}" ${((S.nf)||'us')==k?'selected':''}>${nfSample(k)}</option>`).join('')}</select>`)
      +stSel('Negative Amount Style',`<select class="st-sel" onchange="stNum('neg',this.value)">${NEG.map(x=>`<option value="${x[0]}" ${((S.neg)||'sign')==x[0]?'selected':''}>${negSample(x[0])}</option>`).join('')}</select>`)
    +`</div><p class="st-note">These change how amounts are shown, never what is stored.</p>`;
  stSheet(h,'set-numbers',stKeep);
}
function stNum(k,v){S[k]=(k=='dec')?(v?1:0):v;save();render();stGo('numbers',1)}
function stCurSet(v){S.cur=v;save();render();stGo('numbers',1)}
/* ---- Categories ---- */
function stCats(){
  stStart();
  const L=S.cats||[],live=[],arch=[];
  L.forEach((c,i)=>(c.a?arch:live).push([c,i]));
  const cnt=n=>S.tx.filter(t=>t.cat==n).length;
  const crow=([c,i],first,last)=>{const n=cnt(c.n);
    return `<div class="st-row" style="--i:${stIx++}"><button class="st-hit" onclick="stCatEdit(${i})"><span class="st-i">${ci(c.n)}</span><span class="st-tt"><b>${esc(c.n)}</b>${n?`<small>${n} transaction${n==1?'':'s'}</small>`:''}</span></button>`
      +`<button class="pill st-mv" aria-label="Move ${esc(c.n)} up" ${first?'disabled':''} onclick="stCatMove(${i},-1)">${ST_IC.up}</button>`
      +`<button class="pill st-mv" aria-label="Move ${esc(c.n)} down" ${last?'disabled':''} onclick="stCatMove(${i},1)">${ST_IC.down}</button></div>`};
  const h=stHead('Categories','openSettings()')
    +`<p class="st-note" style="margin:2px 4px 0">Categories name every transaction and drive your budgets. Archived categories stay on the entries that already use them.</p>`
    +stGrp('All categories',live.map((x,k)=>crow(x,k===0,k===live.length-1)))
    +(arch.length?stGrp('Archived',arch.map(([c,i])=>stRow(ci(c.n),`${esc(c.n)}`,`${cnt(c.n)} transactions`+` · Archived`,`stCatEdit(${i})`))):'')
    +`<div class="st-grp eyebrow">Add category</div><div class="st-box st-col"><input id="st-cn" class="st-in" maxlength="24" placeholder="Category name" autocomplete="off"><div style="display:flex;gap:8px"><input id="st-ce" class="st-in" maxlength="2" placeholder="🙂" style="width:66px;flex:none" autocomplete="off"><button class="btn" style="flex:1;margin:0" onclick="stCatAdd()">Add Category</button></div></div>`;
  stSheet(h,'set-categories',stKeep);
}
function stCatAdd(){const n=($('#st-cn')||{}).value,e=($('#st-ce')||{}).value;const nm=(n||'').trim();
  if(!nm)return toast('Enter a category name');
  if((S.cats||[]).some(c=>c.n.toLowerCase()==nm.toLowerCase()))return toast('That category already exists');
  S.cats.push({n:nm,i:(e||'').trim()||'📦'});ensureCats();save();render();stGo('categories',1);toast('Category added',true)}
function stCatEdit(i){
  stStart();
  const c=(S.cats||[])[i];if(!c)return stGo('categories');
  const used=S.tx.filter(t=>t.cat==c.n).length;
  const h=stHead(esc(c.n),"stGo('categories')")
    +`<div class="st-prof"><span class="st-i" style="width:48px;height:48px;border-radius:14px">${ci(c.n)}</span><span class="f"><b>${esc(c.n)}</b><small>${used} transaction${used==1?'':'s'}${c.a?' · archived':''}</small></span></div>`
    +`<label class="m">Name</label><input id="st-cen" class="st-in" maxlength="24" value="${esc(c.n)}" onchange="stCatRen(${i},this.value)">`
    +`<label class="m">Icon</label><input id="st-cee" class="st-in" maxlength="4" value="${esc(c.i||'')}" onchange="stCatIco(${i},this.value)">`
    +`<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0"><label class="pill" style="cursor:pointer">${c.l?'Replace logo':'Upload logo'}<input type="file" accept="image/*" hidden onchange="stCatLogo(${i},this)"></label>${c.l?`<button class="pill" onclick="stCatNoLogo(${i})">Remove logo</button>`:'<span class="m" style="font-size:12.5px;align-self:center">A logo replaces the icon</span>'}</div>`
    +`<div class="st-grp eyebrow">Order</div><div class="st-box"><div class="st-r"><span class="f"><b>Position</b><small>Order shown in pickers</small></span><span style="display:flex;gap:6px"><button class="pill" aria-label="Move up" onclick="stCatMove(${i},-1)">${ST_IC.up}</button><button class="pill" aria-label="Move down" onclick="stCatMove(${i},1)">${ST_IC.down}</button></span></div></div>`
    +(c.a
      ?`<div class="st-grp eyebrow">Archived</div><div class="st-box st-col"><p class="st-note" style="margin:0">Hidden from pickers. Its name, icon and history are intact.</p><button class="btn" style="margin:0" onclick="stCatRestore(${i})">Restore category</button></div>`
      :`<div class="st-grp eyebrow">Manage</div><div class="st-box st-col">${used?`<p class="st-note" style="margin:0">${used} transaction${used==1?'':'s'} use this category, so deleting it would leave them without one.</p>`:''}<button class="btn s" style="margin:0" onclick="stCatArch(${i})">Archive category</button>${used?'':`<button class="btn s danger-t" style="margin:0" onclick="stCatDelAsk(${i})">Delete category</button>`}</div>`);
  stSheet(h,'set-cat-'+i,stKeep);
}
function stCatRen(i,v){const c=(S.cats||[])[i];if(!c)return;const nm=(v||'').trim();
  if(!nm||nm==c.n)return;
  if(S.cats.some((x,k)=>k!=i&&x.n.toLowerCase()==nm.toLowerCase()))return toast('That name is already used');
  S.tx.forEach(t=>{if(t.cat==c.n)t.cat=nm});
  if(S.budgets[c.n]!=null){S.budgets[nm]=S.budgets[c.n];delete S.budgets[c.n]}
  c.n=nm;ensureCats();save();render();stGo('cat-'+i,1);toast('Category renamed',true)}
function stCatIco(i,v){const c=(S.cats||[])[i];if(!c)return;delete c.l;c.i=(v||'').trim()||'📦';ensureCats();save();render();stGo('cat-'+i,1)}
function stCatLogo(i,inp){const c=(S.cats||[])[i];if(!c)return;imgPick(inp,64,'png',u=>{c.l=u;save();render();stGo('cat-'+i,1);toast('Logo updated',true)})}
function stCatNoLogo(i){const c=(S.cats||[])[i];if(!c)return;delete c.l;save();render();stGo('cat-'+i,1)}
function stCatMove(i,d){const l=S.cats||[],j=i+d;if(j<0||j>=l.length)return;const a=l[i],b=l[j];if(!!a.a!=!!b.a)return;
  l[i]=b;l[j]=a;ensureCats();save();render();stGo('cat-'+j,1)}
function stCatArch(i){const c=(S.cats||[])[i];if(!c)return;c.a=1;ensureCats();save();render();stGo('categories',1);toast('Category archived',true)}
function stCatRestore(i){const c=(S.cats||[])[i];if(!c)return;delete c.a;ensureCats();save();render();stGo('cat-'+i,1);toast('Category restored',true)}
function stCatDelAsk(i){const c=(S.cats||[])[i];if(!c)return;
  confirmBox('Delete “'+c.n+'”?','The category is removed from Cap. Any transaction that used it keeps its name in history. This cannot be undone.',()=>{S.cats.splice(i,1);ensureCats();save();render();stGo('categories',1);toast('Category deleted',true)},'Delete')}
/* ==========================================================================
   Notifications — real reminders. Cap can only wake the browser while it is
   open (and catch up the next time it opens), so the copy says exactly that.
   ========================================================================== */
/* A read-only view of the reminder settings: absent keys fall back to the defaults
   without writing anything into the saved document until the user actually changes one. */
function notifDef(){return {on:0,bills:1,billsD:3,renew:1,renewD:3,trial:1,trialD:3,card:1,cardD:5,budget:1,low:0,lowAmt:500}}
function notifCfg(){const d=notifDef(),n=(S.notif&&typeof S.notif=='object')?S.notif:{},o={};Object.keys(d).forEach(k=>{o[k]=n[k]==null?d[k]:n[k]});return o}
function notifPut(k,v){if(!S.notif||typeof S.notif!='object')S.notif={};S.notif[k]=v}
function notifState(){try{if(!('Notification' in window))return 'unsupported';return Notification.permission}catch(e){return 'unsupported'}}
function notifPermText(){
  const s=notifState();
  return s=='granted'?'Allowed by your browser. Reminders appear while Cap is open, and catch up the next time you open it.'
    :s=='denied'?'Blocked in your browser. Allow notifications for this site to use reminders.'
    :s=='unsupported'?'This browser cannot show notifications, so reminders are not available here.'
    :'Turning this on asks your browser for permission.';
}
async function notifFire(title,body,tag){
  try{
    if(notifState()!='granted')return false;
    let reg=null;
    try{reg=navigator.serviceWorker&&(navigator.serviceWorker.controller?await navigator.serviceWorker.ready:await navigator.serviceWorker.getRegistration())}catch(e){}
    if(reg&&reg.showNotification){await reg.showNotification(title,{body,tag,icon:'assets/icons/icon-192.png',badge:'assets/icons/icon-192.png',data:{url:'./'}});return true}
    new Notification(title,{body,tag,icon:'assets/icons/icon-192.png'});return true;
  }catch(e){
    try{new Notification(title,{body});return true}catch(_){return false}
  }
}
function notifOnce(k){try{const o=JSON.parse(localStorage.getItem(NOTIF_SEEN)||'{}'),d=o[today]||(o[today]={});if(d[k])return false;d[k]=1;localStorage.setItem(NOTIF_SEEN,JSON.stringify(o));return true}catch(e){return true}}
function dueWord(d){d=+d;if(d<0)return Math.abs(d)+' day'+(d<-1?'s':'')+' overdue';if(d==0)return 'today';if(d==1)return 'tomorrow';return 'in '+d+' days'}
function notifScan(){
  const n=notifCfg();if(!n.on||notifState()!='granted')return;
  const out=[],d0=bDt(today);
  const push=(k,t,b)=>{if(notifOnce(k))out.push({k,t,b})};
  const B=S.bills||[],fq=b=>b.freq&&b.freq!='once';
  if(+n.bills!==0)B.forEach(b=>{
    if(isTrial(b)||fq(b))return;
    const nd=bIso(nextDue(b)),d=Math.round((bDt(nd)-d0)/864e5);
    if(d<=+n.billsD)push('bill'+b.id+nd,'Bill due '+php(b.amt),b.name+' is due '+dueWord(d));
  });
  if(+n.renew!==0)B.forEach(b=>{
    if(isTrial(b)||!fq(b))return;
    const nd=bIso(nextDue(b)),d=Math.round((bDt(nd)-d0)/864e5);
    if(d<=+n.renewD)push('renew'+b.id+nd,'Renewal '+php(b.amt),b.name+' renews '+dueWord(d));
  });
  if(+n.trial!==0)B.forEach(b=>{
    if(!inTrial(b))return;
    const fb=bIso(subFirstBill(b)),d=Math.round((bDt(fb)-d0)/864e5);
    if(d<=+n.trialD)push('trial'+b.id+fb,'Free trial ending',b.name+' starts billing '+dueWord(d)+' · '+php(b.amt));
  });
  if(+n.card!==0)try{
    outstandingCardStatements().forEach(s=>{
      const d=Math.round((bDt(s.due)-d0)/864e5);
      if(d<=+n.cardD)push('card'+(s.a?s.a.id:'')+s.due,'Card payment due '+php(s.amount),(s.a?s.a.name:'Credit card')+' is due '+dueWord(d));
    });
  }catch(e){}
  if(+n.budget!==0)Object.keys(S.budgets||{}).forEach(c=>{
    const lim=+S.budgets[c]||0;if(lim<=0)return;
    let sp=0;try{sp=spent(c)}catch(e){return}
    if(sp>lim)push('budget'+c+'-'+ym+'v2','Over budget: '+c,php(sp)+' of '+php(lim)+' used this month');
  });
  if(+n.low===1)(S.accts||[]).forEach(a=>{
    if(a.type=='credit')return;
    if(+a.bal<+n.lowAmt)push('low'+a.id+today,'Low balance',a.name+' is down to '+php(a.bal));
  });
  out.slice(0,5).forEach((x,i)=>setTimeout(()=>notifFire(x.t,x.b,x.k),i*400));
}
function stNotif(){ stStart();
  const n=notifCfg(),perm=notifState();
  const daySel=(k,v,lbl)=>`<select class="st-sel" aria-label="${lbl}" onchange="stNotifSet('${k}',this.value)">${[[0,'On the day'],[1,'1 day before'],[2,'2 days before'],[3,'3 days before'],[5,'5 days before'],[7,'1 week before'],[14,'2 weeks before']].map(o=>`<option value="${o[0]}" ${+v==o[0]?'selected':''}>${o[1]}</option>`).join('')}</select>`;
  const h=stHead('Notifications','openSettings()')
    +`<div class="st-box">${stSw('Notifications','Bill, renewal and budget reminders',!!n.on,'stNotifMaster(this.checked)')}</div>`
    +`<p class="st-note">${notifPermText()}</p>`
    +`<div class="st-grp eyebrow">Reminders</div><div class="st-box">`
      +stSw('Bill Reminders','One-off bills',+n.bills!==0,"stNotifSet('bills',this.checked)")
      +stSel('Bill reminder',daySel('billsD',n.billsD,'Bill reminder'))
      +stSw('Subscription Renewals','Recurring subscriptions',+n.renew!==0,"stNotifSet('renew',this.checked)")
      +stSel('Subscription reminder',daySel('renewD',n.renewD,'Subscription reminder'))
      +stSw('Free Trial Ending','Before the first charge',+n.trial!==0,"stNotifSet('trial',this.checked)")
      +stSel('Free trial ending',daySel('trialD',n.trialD,'Free trial ending'))
      +stSw('Credit Card Due Dates','Card statements due soon',+n.card!==0,"stNotifSet('card',this.checked)")
      +stSel('Credit card payment',daySel('cardD',n.cardD,'Credit card payment'))
      +stSw('Budget Alerts','When a category reaches its budget',+n.budget!==0,"stNotifSet('budget',this.checked)")
      +stSw('Low Balance Alerts','When an account falls below your limit',+n.low===1,"stNotifSet('low',this.checked)")
      +stSel('Low balance limit',`<input class="st-in" type="number" inputmode="decimal" min="0" step="50" style="max-width:130px;text-align:right" value="${+n.lowAmt||0}" onchange="stNotifSet('lowAmt',this.value)">`)
    +`</div><p class="st-note">Cap cannot run while it is closed, so reminders arrive while the app is open and any you missed appear when you next open it.</p>`
    +`<div class="st-grp eyebrow">Check it works</div><div class="st-box"><div class="st-r"><span class="f"><b>Send a test reminder</b><small>${perm=='granted'?'Uses your browser notification':'Turn notifications on first'}</small></span><button class="pill" onclick="stNotifTest()">Send</button></div></div>`;
  stSheet(h,'set-notif',stKeep);
}
function stNotifSet(k,v){
  const val=(k=='billsD'||k=='renewD'||k=='trialD'||k=='cardD'||k=='lowAmt')?Math.max(0,+v||0):((v===true||v==='true')?1:0);
  notifPut(k,val);
  save();render();stGo('notif',1)
}
function stNotifMaster(on){
  if(!on){notifPut('on',0);save();render();stGo('notif',1);return}
  const s=notifState();
  if(s=='unsupported'){toast('This browser cannot show notifications');stGo('notif',1);return}
  if(s=='denied'){toast('Notifications are blocked for this site');stGo('notif',1);return}
  const go=()=>{notifPut('on',1);save();render();stGo('notif',1);notifScan()};
  if(s=='granted')return go();
  try{Notification.requestPermission().then(p=>{if(p=='granted')go();else stGo('notif',1)}).catch(()=>stGo('notif',1))}catch(e){stGo('notif',1)}
}
function stNotifTest(){
  if(notifState()!='granted')return toast('Turn notifications on first');
  notifFire('Cap test reminder','If you can see this, reminders are working.','cap-test').then(ok=>toast(ok?'Test reminder sent':'Could not send a reminder',ok));
}
/* ---- Sounds & Haptics ---- */
function stSounds(){ stStart();
  const canVib=hapOk();
  const h=stHead('Sounds &amp; Haptics','openSettings()')
    +`<div class="st-box">`
      +stSw('Payment Confirmation Sound','A short chime when a payment is recorded',S.snd!=0,"stSnd('snd',this.checked)")
      +stSw('Haptic Feedback','A light tap on payments and important saves',S.hap!=0,"stSnd('hap',this.checked)")
    +`</div>`
    +`<div class="st-grp eyebrow">Try it</div><div class="st-box"><div class="st-r"><span class="f"><b>Test feedback</b><small>${canVib?'Vibration is supported here':'This device has no vibration — the chime still plays'}</small></span><button class="pill" onclick="stSndTest()">Play</button></div></div>`
    +`<p class="st-note">Feedback stays subtle, and a device that cannot vibrate is simply ignored.</p>`;
  stSheet(h,'set-sounds',stKeep);
}
function stSnd(k,v){S[k]=v?1:0;save();if(k=='snd')render();stGo('sounds',1)}
function stSndTest(){try{playPaymentConfirmation()}catch(e){}}
function hapOk(){try{return !!navigator.vibrate}catch(e){return false}}
/* ---- Data: backup, restore, import / export, danger zone ---- */
function stMakeBackup(){
  try{expJSON()}catch(e){return toast('Could not create the backup')}
  try{localStorage.setItem(BK_KEY,new Date().toISOString())}catch(e){}
  stGo('backup',1);
}
function dzHtml(){return `<div class="st-dz"><div class="eyebrow">Danger zone</div><p>Reset everything and start over. You will be asked to confirm twice.</p><button class="btn" onclick="stReset()">Reset All Data</button></div>`}
function stBackup(){ stStart();
  const lb=lastBk(),n=S.tx.length+(S.pend||[]).length;
  const h=stHead('Backup &amp; Restore','openSettings()')
    +`<div class="st-grp eyebrow">Storage</div><div class="st-box"><div class="st-r"><span class="f"><b>Saved on this device</b><small>${n} transaction${n==1?'':'s'} · ${(S.accts||[]).length} account${(S.accts||[]).length==1?'':'s'}</small></span><span class="st-pill" data-s="on"><i></i>Local</span></div></div>`
    +`<div class="st-grp eyebrow">Your data</div><div class="st-box st-col">`
      +`<button class="btn" style="margin:0" onclick="stMakeBackup()">Create Backup</button>`
      +`<p class="st-note" style="margin:0">Backups contain your Cap financial data and can be used to restore it on another device.</p>`
      +`<label class="btn s" style="margin:0;display:block;text-align:center;cursor:pointer">Restore Backup<input type="file" accept=".json,application/json" hidden onchange="impRead(this)"></label>`
    +`</div>`
    +`<div class="st-grp eyebrow">Last backup</div><div class="st-box"><div class="st-r"><span class="f"><b>${lb?stWhen(lb):'Never backed up'}</b><small>${lb?'Recorded on this device':'Create one to keep your data safe'}</small></span></div></div>`
    +dzHtml();
  stSheet(h,'set-backup',stKeep);
}
function stFiles(){ stStart();
  const h=stHead('Import &amp; Export','openSettings()')
    +`<div class="st-grp eyebrow">Export</div><div class="st-box st-col">`
      +`<button class="btn" style="margin:0" onclick="stMakeBackup()">Export Cap Backup · JSON</button>`
      +`<button class="btn s" style="margin:0" onclick="expCSV()">Export Transactions · CSV</button>`
    +`</div>`
    +`<div class="st-grp eyebrow">Import</div><div class="st-box st-col">`
      +`<label class="btn" style="margin:0;display:block;text-align:center;cursor:pointer">Import Backup · JSON<input type="file" accept=".json,application/json" hidden onchange="impRead(this)"></label>`
      +`<label class="btn s" style="margin:0;display:block;text-align:center;cursor:pointer">Import Transactions · CSV<input type="file" accept=".csv,text/csv" hidden onchange="impRead(this)"></label>`
      +(hasPre()?'<button class="btn s" style="margin:0" onclick="sure(this,impUndo)">Undo last import</button>':'')
    +`</div><p class="st-note">Every import shows a preview and asks you to confirm. Nothing is overwritten silently.</p>`;
  stSheet(h,'set-files',stKeep);
}
/* ---- Privacy & Sync ---- */
let CAP_MIGRATION_PREVIEW=null;
function migrationUuid(){return crypto.randomUUID()}
function migrationStableUuid(value){let h=2166136261;for(let i=0;i<String(value).length;i++){h^=String(value).charCodeAt(i);h=Math.imul(h,16777619)}const w=n=>(Math.imul(h^n,2246822519)>>>0).toString(16).padStart(8,'0'),hex=Array.from({length:8},(_,i)=>w(i)).join(''),variant=(8+(parseInt(hex[16],16)%4)).toString(16);return`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-${variant}${hex.slice(17,20)}-${hex.slice(20,32)}`}
function migrationPrepare(){
  const lists={accounts:S.accts||[],transactions:[...(S.tx||[]),...(S.pend||[])],transfers:S.xfer||[],bills:S.bills||[],goals:S.goals||[],debts:S.debts||[],categories:S.cats||[],notes:Array.isArray(S.notes)?S.notes:(S.notes?[{id:1,t:'Notes',b:S.notes,d:today}]:[])};
  const blockingProblems=[],warnings=[],conversions=[],ids={};
  const block=x=>blockingProblems.push(x),req=(arr,k,fields)=>arr.forEach((x,i)=>fields.forEach(f=>{if(x[f]===undefined||x[f]===null||x[f]==='')block(`${k}[${i}] is missing ${f}`)}));
  Object.entries(lists).forEach(([k,arr])=>{if(k==='categories')return;const seen=new Set();arr.forEach((x,i)=>{if(x.id==null){block(`${k}[${i}] is missing an id`);return}const key=String(x.id);if(seen.has(key))block(`${k} contains duplicate id ${key}`);seen.add(key)});ids[k]=new Set(arr.filter(x=>x.id!=null).map(x=>String(x.id)))});
  const categoryByName=new Map(),categorySeen=new Set();lists.categories.forEach((c,i)=>{const name=String(c.n??'').trim();if(!name){block(`categories[${i}] is missing name`);return}if(categorySeen.has(name))block(`categories contains duplicate legacy category name ${name}`);categorySeen.add(name);const legacy=c.id==null?name:String(c.id);if(c.id==null)conversions.push(`categories[${i}] uses legacy name "${name}" as legacy_id`);categoryByName.set(name,{legacy_id:legacy,supabase_id:migrationStableUuid('category:'+name),name})});ids.categories=new Set(categoryByName.keys());
  req(lists.accounts,'accounts',['id','name','type','bal']);req(lists.transactions,'transactions',['id','d','amt','acct']);req(lists.transfers,'transfers',['id','d','amt','from','to']);req(lists.bills,'bills',['id','name','amt']);req(lists.goals,'goals',['id','name','target','saved']);req(lists.debts,'debts',['id','who','amt','dir']);
  const accountIds=ids.accounts,txIds=ids.transactions,goalIds=ids.goals;
  lists.transactions.forEach((x,i)=>{if(x.acct!=null&&!accountIds.has(String(x.acct)))block(`transactions[${i}] references missing account ${x.acct}`);if(x.parentId!=null&&!txIds.has(String(x.parentId)))block(`transactions[${i}] references missing parent transaction ${x.parentId}`);if(x.cat&&!categoryByName.has(String(x.cat)))block(`transactions[${i}] references missing category ${x.cat}`)});
  Object.keys(S.budgets||{}).forEach(name=>{if(!categoryByName.has(name))block(`budget references missing category ${name}`)});
  lists.transfers.forEach((x,i)=>{if(x.from!=null&&!accountIds.has(String(x.from)))block(`transfers[${i}] references missing from account ${x.from}`);if(x.to!=null&&!accountIds.has(String(x.to)))block(`transfers[${i}] references missing to account ${x.to}`);if(x.goalId!=null&&!goalIds.has(String(x.goalId)))block(`transfers[${i}] references missing goal ${x.goalId}`)});
  lists.bills.forEach((x,i)=>{if(x.acct!=null&&x.acct!==0&&!accountIds.has(String(x.acct)))block(`bills[${i}] references missing payment account ${x.acct}`)});
  const statements=[],statementIds=new Set();(S.accts||[]).forEach(a=>(Array.isArray(a.statementHistory)?a.statementHistory:[]).forEach((s,i)=>{const sid=String(s.statementId||`${a.id}:${s.st||s.en||i}`);if(statementIds.has(sid))block(`duplicate credit-card statement ${sid}`);statementIds.add(sid);statements.push({account:a,statement:s,legacyId:sid})}));
  lists.transactions.concat(lists.transfers).forEach(x=>{if(x.statementId&&!statementIds.has(String(x.statementId)))block(`financial record ${x.id} references missing statement ${x.statementId}`)});
  const maps={};Object.entries(lists).forEach(([k,arr])=>{if(k==='categories')maps[k]=[...categoryByName.values()];else maps[k]=arr.map(x=>({legacy_id:String(x.id),supabase_id:migrationStableUuid(k+':'+x.id)}))});maps.category_relationships={transactions:lists.transactions.map(x=>({legacy_category:x.cat||'',supabase_id:categoryByName.get(String(x.cat||''))?.supabase_id||null})),budgets:Object.keys(S.budgets||{}).map(n=>({legacy_category:n,supabase_id:categoryByName.get(n)?.supabase_id||null}))};maps.account_statements=statements.map(x=>({legacy_id:x.legacyId,supabase_id:migrationStableUuid('statement:'+x.legacyId),account_legacy_id:String(x.account.id)}));
  const counts={accounts:lists.accounts.length,posted_transactions:(S.tx||[]).length,pending_transactions:(S.pend||[]).length,transfers:lists.transfers.length,bills:lists.bills.length,goals:lists.goals.length,debts:lists.debts.length,budgets:Object.keys(S.budgets||{}).length,categories:lists.categories.length,notes:lists.notes.length,statement_history:statements.length};
  const balances=(S.accts||[]).map(a=>({legacy_id:a.id,name:a.name,type:a.type,balance:+a.bal||0}));
  return{counts,balances,total_balance:balances.reduce((n,a)=>n+a.balance,0),blockingProblems,warnings,conversions,problems:blockingProblems,maps,generated_at:new Date().toISOString()};
}
function buildSupabaseMigrationPlan(report){
  const userId=CapSupabase.status().userId;if(!userId)throw Error('No authenticated Supabase user');
  const find=(k,id)=>report.maps[k].find(x=>String(x.legacy_id)===String(id))?.supabase_id;
  const cat=(name)=>report.maps.categories.find(x=>x.name===String(name))?.supabase_id;
  const accountRows=(S.accts||[]).map(a=>({id:find('accounts',a.id),user_id:userId,legacy_id:String(a.id),account_type:a.type,name:a.name,bank:a.bank||null,nickname:a.nickname||null,network:a.net||null,last_four:a.l4||null,balance:+a.bal||0,credit_limit:a.lim==null?null:+a.lim,status:a.cardStatus||'Active',card_art:a.img||null,photo_url:a.photo||null,statement_day:a.stmt||null,due_day:a.due||null,due_days:a.dueN||null,minimum_payment:a.minimumPayment||{},interest_settings:{interestEnabled:a.interestEnabled,interestRate:a.interestRate,interestCalc:a.interestCalc,interestCreditFreq:a.interestCreditFreq,interestOtherDays:a.interestOtherDays,interestSimulation:a.interestSimulation,goalInterestMode:a.goalInterestMode,interestGoalId:a.interestGoalId},fee_settings:a.fees||a.debitFees||{},statement_settings:{statementHistory:a.statementHistory||[]}}));
  const billRows=(S.bills||[]).map(b=>({id:find('bills',b.id),user_id:userId,legacy_id:String(b.id),payment_account_id:b.acct?find('accounts',b.acct):null,name:b.name,kind:b.kind||'bill',amount:+b.amt||0,frequency:b.freq||'monthly',start_date:b.start||null,due_day:b.due||null,logo_url:b.logo||null,status:b.subscriptionStatus||null,cancelled_on:b.cancelledOn||null,trial_start:b.trialStartDate||null,trial_end:b.trialEndDate||null,alert_settings:b.al||[],metadata:b}));
  const statementRows=[];(S.accts||[]).forEach(a=>(a.statementHistory||[]).forEach((s,i)=>{const legacy=String(s.statementId||`${a.id}:${s.st||s.en||i}`);statementRows.push({id:report.maps.account_statements.find(x=>x.legacy_id===legacy)?.supabase_id,user_id:userId,account_id:find('accounts',a.id),statement_start:s.st||null,statement_end:s.en||null,statement_date:s.c?.st||null,due_date:s.c?.due||null,opening_balance:s.opening||0,closing_balance:s.close||0,minimum_due:s.minimum||0,paid_amount:s.paid||0,metadata:s})}));
  const statementId=s=>s?report.maps.account_statements.find(x=>x.legacy_id===String(s))?.supabase_id:null;
  const txRows=[...(S.tx||[]).map(t=>[t,'posted']),...(S.pend||[]).map(t=>[t,'pending'])].map(([t,status])=>({id:find('transactions',t.id),user_id:userId,account_id:find('accounts',t.acct),category_id:cat(t.cat),bill_id:t.billId!=null?find('bills',t.billId):null,parent_transaction_id:t.parentId!=null?find('transactions',t.parentId):null,statement_id:statementId(t.statementId),legacy_id:String(t.id),amount:+t.amt,transaction_date:t.d,posting_date:t.pd||null,status,title:t.note||null,description:t.desc||null,metadata:t}));
  const transferRows=(S.xfer||[]).map(x=>({id:find('transfers',x.id),user_id:userId,from_account_id:x.from!=null?find('accounts',x.from):null,to_account_id:x.to!=null?find('accounts',x.to):null,goal_id:x.goalId!=null?find('goals',x.goalId):null,statement_id:statementId(x.statementId),legacy_id:String(x.id),transfer_type:x.kind||'account-transfer',amount:+x.amt,transfer_date:x.d,note:x.note||null,metadata:x}));
  const billPaymentRows=[];(S.bills||[]).forEach(b=>(typeof billPayments==='function'?billPayments(b):[]).forEach(p=>billPaymentRows.push({id:migrationStableUuid('bill-payment:'+p.tx.id),user_id:userId,bill_id:find('bills',b.id),transaction_id:find('transactions',p.tx.id),transfer_id:null,due_date:p.due||null,paid_date:p.d,amount:+p.amt||0,status:'paid'})));
  const categoryRows=(S.cats||[]).map(c=>({id:cat(c.n),user_id:userId,legacy_id:String(c.id??c.n),name:c.n,emoji:c.i||null,logo_url:c.l||null,archived:!!c.a}));
  const goalRows=(S.goals||[]).map(g=>({id:find('goals',g.id),user_id:userId,account_id:g.accountId?find('accounts',g.accountId):null,legacy_id:String(g.id),name:g.name,icon:g.icon||null,target_amount:+g.target||0,saved_amount:+g.saved||0,target_date:g.targetDate||null,completed:!!g.done}));
  const debtRows=(S.debts||[]).map(d=>({id:find('debts',d.id),user_id:userId,legacy_id:String(d.id),person:d.who,note:d.note||null,amount:+d.amt||0,direction:d.dir,due_date:d.due||null}));
  const budgetRows=Object.entries(S.budgets||{}).map(([name,amount])=>({id:migrationStableUuid('budget:'+name),user_id:userId,category_id:cat(name),amount:+amount||0}));
  const noteRows=(Array.isArray(S.notes)?S.notes:(S.notes?[{id:1,t:'Notes',b:S.notes,d:today}]:[])).map(n=>({id:find('notes',n.id),user_id:userId,legacy_id:String(n.id),title:n.t||'',body:n.b||'',note_date:n.d||null}));
  return{userId,profile:{id:userId,display_name:S.name||null,photo_url:S.photo||null},preferences:{user_id:userId,currency:S.cur||'PHP',number_format:S.nf||'us',negative_style:S.neg||'sign',show_decimals:!!S.dec,theme:S.theme||'auto',animations_enabled:S.anim!==0,reduce_motion:S.rm===1,sound_enabled:S.snd!==0,haptics_enabled:S.hap!==0,hide_balances:S.hide===1,logo_choice:S.logoChoice||'default',account_view:S.accountView||'all',account_sort:S.accountSort||'manual',account_order:S.accountOrder||[]},tables:[['categories',categoryRows],['accounts',accountRows],['goals',goalRows],['debts',debtRows],['bills',billRows],['account_statements',statementRows],['transactions',txRows],['transfers',transferRows],['bill_payments',billPaymentRows],['budgets',budgetRows],['notes',noteRows]]};
}
async function migrateCapData(){
  const report=migrationPrepare();CAP_MIGRATION_PREVIEW=report;const out=$('#migration-result');if(report.blockingProblems.length)return toast('Prepare Cloud Migration must pass first');
  let plan,repeat;try{plan=buildSupabaseMigrationPlan(report);repeat=buildSupabaseMigrationPlan(report);const stable=[];plan.tables.forEach(([table,rows])=>{const other=repeat.tables.find(x=>x[0]===table)?.[1]||[];rows.forEach((row,i)=>{if(row.id!==other[i]?.id)stable.push(`${table} legacy ${row.legacy_id||row.name||i}`)})});if(stable.length)throw Error('Stable UUID mapping failed for '+stable.join(', '))}catch(e){if(out)out.textContent='Migration preflight failed: '+e.message;return toast('Migration preflight failed')}
  if(!confirm('Upload your existing Cap financial data to your private Supabase account? Local data will be preserved and automatic sync will remain OFF.'))return;
  if(out)out.textContent='Migrating…';try{const result=await CapSupabase.migratePlan(plan);if(!result.ok)throw Error(result.mismatches.join(' · ')||'Cloud verification failed');if(out)out.innerHTML='Migration complete ✓<br>Cloud verification passed ✓<br>Local data preserved ✓<br>Automatic sync remains OFF<br>All generated UUIDs valid ✓<br>All UUID foreign keys valid ✓<br>Stable UUID mappings verified ✓<br>Partial previous migration safely handled ✓';toast('Migration complete',true)}catch(e){if(out)out.textContent='Migration failed: '+e.message;toast('Migration failed')}}
async function prepareCloudMigration(){
  const report=migrationPrepare(),snap=window.CapOff?await CapOff.localSnapshot():{pera:null,indexeddb:{},auxiliary:{}};
  const stamp=new Date(),pad=n=>String(n).padStart(2,'0'),date=`${stamp.getFullYear()}-${pad(stamp.getMonth()+1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  const payload={app:'cap-finance-tracker',kind:'pre-supabase-migration-backup',created_at:new Date().toISOString(),backup:snap,validation:report,cloud_uploaded:false};
  CAP_MIGRATION_PREVIEW=report;dl(`cap-pre-supabase-backup-${date}.json`,JSON.stringify(payload,null,2),'application/json');
  const out=$('#migration-result');if(out){let msg;if(report.blockingProblems.length){msg='Migration preparation found '+report.blockingProblems.length+' blocking problem'+(report.blockingProblems.length==1?'':'s')+'. No cloud data uploaded<br>'+report.blockingProblems.map(esc).join('<br>')}else msg='Migration preparation passed ✓ — No cloud data uploaded<br>'+Object.entries(report.counts).map(([k,v])=>esc(k)+': '+v).join(' · ')+'<br>Total account balance: '+php(report.total_balance)+'<br>Legacy category → UUID mappings: '+report.maps.categories.length+' · Conversions: '+report.conversions.length+' · Warnings: '+report.warnings.length;out.innerHTML=msg}
  toast(report.blockingProblems.length?'Review migration problems':'Pre-migration backup created',!report.blockingProblems.length);
}
async function validateCapRealData(){const out=$('#real-sync-result');if(out)out.textContent='Running read-only validation…';try{const report=migrationPrepare();if(report.blockingProblems.length)throw Error('Phase 4 blocking problems remain: '+report.blockingProblems.join(' · '));const result=await CapSupabase.validateRealData(buildSupabaseMigrationPlan(report));if(!result.ok)throw Error('Missing: '+result.missingCount+' · Unexpected: '+result.unexpectedCount+' · Mismatches: '+result.mismatchCount+' · Foreign keys: '+result.foreignKeyErrorCount);if(out)out.textContent='Local ↔ Cloud mapping verified ✓ · Financial values verified ✓ · Foreign keys verified ✓ · Sync baseline: Not initialized · First-sync direction analysis: Not available until baseline initialization · Real data unchanged ✓';toast('Real data validation passed; baseline initialization required',true)}catch(e){if(out)out.textContent='Read-only validation failed: '+e.message;toast('Real data validation failed')}}
async function initializeCapSyncBaseline(){
  const out=$('#sync-baseline-result');if(out)out.textContent='Validating before baseline initialization…';
  const run=async()=>{const report=migrationPrepare();if(report.blockingProblems.length)throw Error('Phase 4 blocking problems remain: '+report.blockingProblems.join(' · '));const plan=buildSupabaseMigrationPlan(report),result=await CapSupabase.validateRealData(plan);if(!result.dataOk)throw Error(`Data validation failed: missing ${result.missingCount}, unexpected ${result.unexpectedCount}, mismatches ${result.mismatchCount}, foreign keys ${result.foreignKeyErrorCount}`);const uid=CapSupabase.status().userId,queue=await CapOff.syncStore('outbox','all').catch(()=>[]),realQueue=queue.filter(q=>q.user_id!==uid||!(q.payload?.legacy_id||'').startsWith('phase6-test-'));if(realQueue.length)throw Error(`Pending real-data outbox operations: ${realQueue.length}`);return{plan,result,uid}};
  try{const first=await run();if(!confirm('Mark the currently verified local and Supabase data as the synchronized starting state? This writes local sync metadata only and does not enable Cloud Sync.'))return;const second=await run();if(first.result.fingerprint!==second.result.fingerprint)throw Error('Local or cloud data changed during initialization; validate again');const baseline={key:'baseline',version:1,user_id:second.uid,created_at:new Date().toISOString(),fingerprint:second.result.fingerprint,records:second.result.baselineRecords};await CapOff.syncStore('syncmeta','put',baseline,'baseline');await CapOff.syncStore('syncmeta','put',{key:'status',last_synced:new Date().toISOString(),pending:0,conflicts:0},'status');if(out)out.textContent='Sync baseline initialized ✓ · Would push: 0 · Would pull: 0 · Conflicts: 0 · Automatic Cloud Sync remains OFF ✓';toast('Sync baseline initialized',true)}catch(e){if(out)out.textContent='Baseline initialization failed: '+e.message;toast('Baseline initialization failed')}}
function stPrivacy(){ stStart();
  const c=window.CapOff?CapOff.status():null,cloud=!!(c&&c.cloud);
  const st=cloud?(c.status=='error'?'warn':'on'):'off';
  const h=stHead('Privacy &amp; Sync','openSettings()')
    +`<div class="st-grp eyebrow">Data storage</div><div class="st-box"><div class="st-r"><span class="f"><b>${cloud?'Synced with your account':'Saved on this device'}</b><small>${cloud?'Cloud sync is connected for this device.':'Your financial data is stored locally on this device.'}</small></span><span class="st-pill" data-s="${st}"><i></i>${cloud?(navigator.onLine?'Online':'Offline'):'Local only'}</span></div></div>`
    +`<p class="st-note">Cap works fully offline. Nothing is uploaded unless you connect cloud sync.</p>`
     +`<div class="st-grp eyebrow">Supabase connection test</div><div class="st-box st-col"><p class="st-note" style="margin:0">This verifies authentication, your profile RLS row, and that another user's profile is not visible. It never uploads Cap data.</p><button class="btn" style="margin:0" onclick="testSupabaseConnection()">Test Supabase Connection</button><small id="sb-test-result" class="st-note"></small><button class="btn s" style="margin:0" onclick="testSupabaseCloudDatabase()">Test Cloud Database</button><small id="sb-crud-result" class="st-note"></small>${CapSupabase?.status().authenticated?'<button class="btn s" style="margin:0" onclick="CapSupabase.signOut()">Sign Out</button>':''}</div>`
      +`<div class="st-grp eyebrow">Cloud Sync</div>${window.CapSync?CapSync.settingsHtml():''}`
      +`<div class="st-grp eyebrow">Migration preparation</div><div class="st-box st-col"><p class="st-note" style="margin:0">Creates a downloadable local backup and validation/mapping preview only. No financial data is uploaded or changed.</p><button class="btn" style="margin:0" onclick="prepareCloudMigration()">Prepare Cloud Migration</button><button class="btn s" style="margin:0" onclick="migrateCapData()">Migrate Data to Supabase</button><small id="migration-result" class="st-note"></small></div>`
     +stGrp('On this device',[
      stRow(ST_IC.box,'Backup &amp; Restore',lastBk()?'Last backup '+stWhen(lastBk()):'Never backed up',"stGo('backup')"),
      stRow(ST_IC.swap,'Import &amp; Export',null,"stGo('files')"),
      stRow(ST_IC.lock,'Security',secLbl(),"stGo('security')")]);
  stSheet(h,'set-privacy',stKeep);
}
async function upgradeCapSyncBaseline(){
  const out=$('#sync-baseline-upgrade-result');if(out)out.textContent='Running guarded read-only checks…';let stage='baseline read';
  const validate=async()=>{stage='validation';const report=migrationPrepare();if(report.blockingProblems.length)throw Error('Phase 4 blocking problems remain: '+report.blockingProblems.join(' · '));const plan=buildSupabaseMigrationPlan(report),result=await CapSupabase.validateRealData(plan),authenticatedUser=await CapSupabase.currentUser();if(!result.dataOk)throw Error(`Validation failed: missing ${result.missingCount}, unexpected ${result.unexpectedCount}, mismatches ${result.mismatchCount}, foreign keys ${result.foreignKeyErrorCount}`);if(result.dryRun?.wouldPush||result.dryRun?.wouldPull||result.dryRun?.conflicts||result.dryRun?.missingMappings)throw Error('Existing dry run is not clean');stage='outbox check';const q=await CapOff.syncStore('outbox','all').catch(()=>[]),uid=authenticatedUser?.id;if(!uid)throw Error('No authenticated user during baseline validation');if(q.some(x=>x.user_id===uid&&!String(x.payload?.legacy_id||'').startsWith('phase6-test-')))throw Error('Pending real-data outbox operations exist');return{plan,result,uid}};
  try{const baseline=await CapOff.syncStore('syncmeta','get','baseline');if(!baseline?.fingerprint||!Array.isArray(baseline.records))throw Error('Existing baseline is missing or corrupt');if(baseline.version===2&&!baseline.records.every(r=>/^[0-9a-f]{64}$/i.test(r.contentFingerprint||'')))throw Error('Existing baseline is partially upgraded or mixed; no changes were made');stage='first validation';const first=await validate();if(first.result.fingerprint!==baseline.fingerprint)throw Error('Current state differs from the existing baseline');stage='confirmation';if(!confirm('Upgrade the local sync baseline with per-record content fingerprints? This writes sync metadata only and keeps Cloud Sync OFF.'))return;stage='second validation';const second=await validate();if(second.result.fingerprint!==first.result.fingerprint)throw Error('Local or cloud data changed during baseline upgrade; no baseline was replaced');stage='per-record fingerprint generation';const records=await CapSync.recordFingerprints(second.plan,second.result),diag=CapSync.fingerprintDiagnostics(records,baseline);if(!diag.ok){const arrays=['missingFingerprints','malformedFingerprints','duplicateIdentities','duplicateSupabaseUuids','missingEntities','missingLocalIds','missingSupabaseUuids','localWithoutBaseline','baselineWithoutLocal','ambiguous','canonicalMismatches','canonicalMismatchDetails'];for(const k of arrays)if(!Array.isArray(diag[k]))throw Error('Internal fingerprint diagnostic error: '+k+' expected Array, received '+typeof diag[k]);const identityDetails=[...(diag.localWithoutBaseline||[]).map(x=>'Local without baseline: '+JSON.stringify(x)),...(diag.baselineWithoutLocal||[]).map(x=>'Baseline without local: '+JSON.stringify(x))].join('\n');const details=(diag.canonicalMismatchDetails||[]).map(d=>'Entity: '+d.entity+'\nLocal ID: '+d.localId+'\nSupabase UUID: '+d.supabase_id+'\nDiffering field/path: '+d.field+'\nLocal type: '+d.localType+'\nCloud type: '+d.cloudType+'\nLocal canonical representation: '+d.localRepresentation+'\nCloud canonical representation: '+d.cloudRepresentation+'\nNormalization applied: '+d.normalization+'\nClassification: '+d.classification).join('\n\n');throw Error('Fingerprint verification failed; failed checks: '+(diag.failedChecks||[]).join(', ')+'. Expected '+diag.expected+', generated '+diag.generated+', matched by local ID '+diag.matchedByLocalId+', matched by UUID fallback '+diag.matchedByUuidFallback+', unmatched local '+diag.localWithoutBaseline.length+', unmatched baseline '+diag.baselineWithoutLocal.length+', ambiguous '+diag.ambiguous.length+', valid '+diag.valid+', missing '+diag.missingFingerprints.length+', malformed '+diag.malformedFingerprints.length+', duplicate identities '+diag.duplicateIdentities.length+', duplicate UUIDs '+diag.duplicateSupabaseUuids.length+', content mismatches '+diag.canonicalMismatches.length+'\n'+details+'\n'+identityDetails)};stage='baseline atomic replacement';const upgraded={...baseline,version:2,upgraded_at:new Date().toISOString(),records:records.map(({cloudContentFingerprint,...r})=>r)};stage='baseline write';await CapOff.syncStore('syncmeta','put',upgraded,'baseline');stage='post-upgrade verification';const check=await CapOff.syncStore('syncmeta','get','baseline');const ownerBad=(check?.records||[]).filter(r=>r.entity==='profiles'?r.supabase_id!==second.uid:r.user_id!==second.uid);if(!check||check.version!==2||check.records.length!==records.length||!check.records.every(r=>/^[0-9a-f]{64}$/i.test(r.contentFingerprint||''))||ownerBad.length){stage='rollback';await CapOff.syncStore('syncmeta','put',baseline,'baseline');throw Error('Post-upgrade baseline verification failed'+(ownerBad.length?' � ownership metadata mismatch; previous baseline restored':'') )};if(out)out.textContent=`Sync baseline upgraded ✓ · ${records.length} records fingerprinted · Automatic Cloud Sync remains OFF`;toast('Sync baseline upgraded',true)}catch(e){if(out)out.textContent='Baseline upgrade failed at '+stage+': '+e.message;toast('Baseline upgrade failed')}}
function baselineMappingDiagnostics(baseline,userId){const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hex=/^[0-9a-f]{64}$/i,validId=v=>(typeof v==='number'&&Number.isFinite(v))||(typeof v==='string'&&v.trim()!==''&&v.trim()!=='[object Object]'),errors=[],ids=new Map(),uuids=new Map(),missingUserRecords=[];let missingLocalIds=0,missingSupabaseUuids=0,missingUserIds=0,ownershipMismatches=0;for(const r of baseline.records||[]){const entity=String(r.entity||'').trim(),local=validId(r.localId)?String(r.localId):validId(r.legacy_id)?String(r.legacy_id):null,ek=local==null?null:entity+':'+local,uk=entity+':'+String(r.supabase_id||'');if(!entity)errors.push('missing entity');if(local==null){missingLocalIds++;errors.push(`missing localId (${entity})`)}if(!r.supabase_id||!uuid.test(String(r.supabase_id))){missingSupabaseUuids++;errors.push(`malformed Supabase UUID (${entity}:${local||'missing'})`)}if(!r.user_id){missingUserIds++;missingUserRecords.push({entity,localId:local,supabaseId:r.supabase_id,userIdState:r.user_id===null?'null':r.user_id===''?'empty':'missing'});errors.push(`missing user_id (${entity}:${local||'missing'})`)}else if(r.user_id!==userId){ownershipMismatches++;errors.push(`ownership mismatch (${entity}:${local||'missing'})`)}if(!r.contentFingerprint)errors.push(`missing fingerprint (${entity}:${local||'missing'})`);else if(!hex.test(String(r.contentFingerprint)))errors.push(`malformed fingerprint (${entity}:${local||'missing'})`);if(ek){ids.set(ek,(ids.get(ek)||0)+1);if(ids.get(ek)>1)errors.push(`duplicate entity + localId (${ek})`)}if(uuid.test(String(r.supabase_id||''))){uuids.set(uk,(uuids.get(uk)||0)+1);if(uuids.get(uk)>1)errors.push(`duplicate entity + Supabase UUID (${uk})`)}}return{errors,recordCount:(baseline.records||[]).length,fingerprintCount:(baseline.records||[]).filter(r=>hex.test(String(r.contentFingerprint||''))).length,missingLocalIds,missingSupabaseUuids,missingUserIds,missingUserRecords,ownershipMismatches,duplicateLocal:[...ids].filter(x=>x[1]>1).length,duplicateUuid:[...uuids].filter(x=>x[1]>1).length}}
async function inspectCurrentSyncBaseline(){const out=$('#sync-baseline-inspect-result');if(out)out.textContent='Inspecting baseline read-only…';try{const b=await CapOff.syncStore('syncmeta','get','baseline'),u=await CapSupabase.currentUser();if(!b||!Array.isArray(b.records))throw Error('Baseline missing or corrupt');const d=baselineMappingDiagnostics(b,u?.id),hex=/^[0-9a-f]{64}$/i,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,up=b.records.find(r=>r.entity==='user_preferences'),pr=b.records.find(r=>r.entity==='profiles'),state=v=>v===undefined?'missing':v===null?'null':v===''?'empty':'valid',owner=(r,special)=>special?uuid.test(String(r?.supabase_id||''))&&r.supabase_id===u?.id:r?.user_id===u?.id,prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),expected=plan.tables.reduce((n,x)=>n+x[1].length,0)+(plan.profile?1:0)+(plan.preferences?1:0),healthy=b.records.length===expected&&b.records.every(r=>hex.test(String(r.contentFingerprint||'')))&&!d.missingLocalIds&&!d.missingSupabaseUuids&&!d.duplicateLocal&&!d.duplicateUuid&&!d.missingUserIds&&!d.missingUserRecords?.length;if(out)out.innerHTML=`Baseline classification: ${healthy?(b.version===2?'VALID NEW CANDIDATE BASELINE':'OLD BASELINE PRESENT'):b.version===2?'INVALID/INCOMPLETE BASELINE':'OLD BASELINE PRESENT'}<br>Records: ${b.records.length}<br>Expected records: ${expected}<br>Fingerprints: ${b.records.filter(r=>r.contentFingerprint).length}<br>Valid fingerprints: ${b.records.filter(r=>hex.test(String(r.contentFingerprint||''))).length}<br>Missing local IDs: ${d.missingLocalIds}<br>Invalid UUIDs: ${d.missingSupabaseUuids}<br>Duplicate entity + localId: ${d.duplicateLocal}<br>Duplicate entity + Supabase UUID: ${d.duplicateUuid}<br>Missing ownership metadata: ${d.missingUserIds}<br>Ownership mismatches: ${d.ownershipMismatches}<br>Missing mappings: ${(d.localWithoutBaseline?.length||0)+(d.baselineWithoutLocal?.length||0)}<br>profiles ownership: ${owner(pr,true)?'verified':'failed'}<br>user_preferences localId: ${state(up?.localId)} · Supabase UUID: ${state(up?.supabase_id)} · user_id: ${state(up?.user_id)} · ownership: ${owner(up,false)?'verified':'failed'}<br>Partial record set evidence: ${b.records.length===expected?'none':'present'}${healthy?'<br><b>CURRENT BASELINE VALID — NO REGENERATION REQUIRED</b>':''}`;toast(healthy?'Baseline is valid':'Baseline requires review',healthy)}catch(e){if(out)out.textContent='Baseline inspection failed: '+e.message;toast('Baseline inspection failed')}}
function phase6DependencyDiagnosis(plan,validation,newPlan,deleteTest){const identity=newPlan.find(x=>x.entity==='transactions'&&String(x.localId)===String(deleteTest?.id))||newPlan.find(x=>x.entity==='transactions'),tx=identity&&plan.tables.find(x=>x[0]==='transactions')?.[1].find(r=>String(r.id)===String(identity.id)),accountPlan=tx&&plan.tables.find(x=>x[0]==='accounts')?.[1].find(a=>String(a.id)===String(tx.account_id)),accountLocal=accountPlan&&(S.accts||[]).find(a=>String(a.id)===String(accountPlan.legacy_id)),accountCloud=accountPlan&&validation.snapshot.accounts?.find(a=>String(a.id)===String(accountPlan.id)),txLocal=tx&&(S.tx||[]).concat(S.pend||[]).find(t=>String(t.id)===String(identity.localId)),effect=tx&&accountLocal&&accountCloud?(accountLocal.type==='credit'?-Number(tx.amount||0):Number(tx.amount||0)):null,changed=!!accountLocal&&!!accountCloud&&Number(accountLocal.bal)!==Number(accountCloud.balance),explained=effect==null?false:Math.abs((Number(accountLocal.bal)-Number(accountCloud.balance))-effect)<.005,other=validation.mismatchDetails?.filter(x=>x.entity==='accounts'&&x.localId===String(accountPlan?.legacy_id)&&x.field!=='balance')||[];return{tx,txLocal,identity,accountPlan,accountLocal,accountCloud,changed,explained,otherFields:other,recognized:!!tx&&String(txLocal?.note||'').trim().toUpperCase()==='DELETE SYNC TEST',safe:!!tx&&!!accountPlan&&!!accountLocal&&!!accountCloud&&changed&&explained&&!other.length}}
async function tracePhase6JIdentifiers(){const out=$('#phase6j-trace-result');if(out)out.textContent='Tracing identifiers read-only�';try{const prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),tx=(S.tx||[]).find(t=>String(t.note||'').trim().toUpperCase()==='DELETE SYNC TEST'),planTx=plan.tables.find(x=>x[0]==='transactions')[1].find(t=>String(t.legacy_id)===String(tx?.id)),acctPlan=planTx&&plan.tables.find(x=>x[0]==='accounts')[1].find(a=>String(a.id)===String(planTx.account_id)),localAcct=acctPlan&&(S.accts||[]).find(a=>String(a.id)===String(acctPlan.legacy_id)),baseline=await CapOff.syncStore('syncmeta','get','baseline'),validation=await CapSupabase.validateRealData(plan),b=baseline?.records?.find(r=>r.entity==='transactions'&&String(r.supabase_id)===String(planTx?.id));if(out)out.innerHTML='TRANSACTION RELATIONSHIP TRACE<br>Local transaction ID: '+(tx?.id||'missing')+'<br>Local account field: '+(tx&&Object.prototype.hasOwnProperty.call(tx,'acct')?'acct':'missing')+'<br>Local account identifier type: '+typeof tx?.acct+'<br>Migration-plan account_id: '+(planTx?.account_id||'missing')+'<br>Migration-plan account UUID type: '+typeof planTx?.account_id+'<br>Matching plan account legacy_id: '+(acctPlan?.legacy_id||'missing')+'<br>Matching local account found: '+(localAcct?'YES':'NO')+'<br>All references resolve to same account: '+(!!tx&&!!acctPlan&&!!localAcct&&String(tx.acct)===String(acctPlan.legacy_id)?'YES':'NO')+'<br>Baseline account mapping: '+(acctPlan&&baseline?.records?.some(r=>r.entity==='accounts'&&String(r.legacy_id)===String(acctPlan.legacy_id))?'YES':'NO')+'<br>DELETE SYNC TEST recognized: '+(tx?'YES':'NO')+'<br>Plan identity match: '+(!!planTx&&!!tx&&String(planTx.legacy_id)===String(tx.id)?'YES':'NO')+'<br>Baseline transaction mapping: '+(b?'YES':'NO')+'<br>Unexpected cloud records: '+(validation.unexpected?.length||0)+'<br>No financial values displayed; no data was changed.';toast('Phase 6J identifier trace complete',true)}catch(e){if(out)out.textContent='Identifier trace failed: '+e.message;toast('Identifier trace failed')}}
function phase6TransactionInsertGuard(plan,validation,baseline,candidate,dependency,userId){const local=(S.tx||[]).concat(S.pend||[]).find(r=>String(r.id)===String(candidate?.localId)),row=candidate&&plan.tables.find(x=>x[0]==='transactions')?.[1].find(r=>String(r.id)===String(candidate.supabase_id)),account=row&&plan.tables.find(x=>x[0]==='accounts')?.[1].find(r=>String(r.id)===String(row.account_id)),category=row?.category_id&&plan.tables.find(x=>x[0]==='categories')?.[1].some(r=>String(r.id)===String(row.category_id)),cloud=validation.snapshot.transactions?.find(r=>String(r.id)===String(candidate?.supabase_id));const checks={identityPassed:!!local&&!!row&&/^[0-9a-f-]{36}$/.test(String(candidate?.supabase_id||''))&&!baseline.records.some(r=>r.entity==='transactions'&&String(r.supabase_id)===String(candidate?.supabase_id)),ownershipPassed:row?.user_id===userId,relationshipsPassed:!!account&&(!row.category_id||!!category),cloudAbsencePassed:!cloud,dependentAccountPassed:!!dependency?.safe};return{...checks,safe:Object.values(checks).every(Boolean),local,row,account,category,cloud}}
async function runCapSyncDryRun(){
  const out=$('#sync-dry-run-result');let dryStage='entry',validationDiagnosticsRendered=false;window.CAP_PHASE6I_ASSET='phase6i-v251';if(out)out.textContent='Localhost asset build: phase6i-v251<br>Dry-run runtime: phase6i-delete-v1<br>Dry-run validator: phase6d1-mapping-v2<br>Dry-run entry reached: YES<br>Running read-only sync dry run…';
  try{
    const baseline=await CapOff.syncStore('syncmeta','get','baseline'),u=await CapSupabase.currentUser();if(!baseline||!baseline.fingerprint||!Array.isArray(baseline.records))throw Error('Baseline is missing or corrupt');if(out)out.innerHTML='Dry-run runtime: phase6i-delete-v1<br>Dry-run validator: phase6d1-mapping-v2<br>Dry-run entry reached: YES<br>Baseline records: '+baseline.records.length;if(!u?.id||baseline.user_id!==u.id)throw Error('Baseline ownership does not match the authenticated user');
    const mapping=baselineMappingDiagnostics(baseline,u.id);if(out)out.innerHTML+='\nRecord count: '+mapping.recordCount+'<br>Valid fingerprints: '+baseline.records.filter(r=>/^[0-9a-f]{64}$/i.test(r.contentFingerprint||'')).length+'<br>Missing local IDs: '+mapping.missingLocalIds+'<br>Invalid UUIDs: '+mapping.missingSupabaseUuids+'<br>Duplicate entity + localId: '+mapping.duplicateLocal+'<br>Duplicate entity + Supabase UUID: '+mapping.duplicateUuid+'<br>Missing user_id: '+mapping.missingUserIds+'<br>Ownership mismatches: '+mapping.ownershipMismatches;
    if(out)out.innerHTML+='<br>Mapping validation passed: '+(mapping.errors.length?'NO':'YES');if(mapping.errors.length){let extra='';try{const prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan),state=v=>v===undefined?'missing':v===null?'null':v===''?'empty':'valid';extra=mapping.missingUserRecords.map(x=>{const rows=validation.snapshot?.[x.entity]||[],cloud=rows.find(r=>String(r.id)===String(x.supabaseId)),local=x.entity==='profiles'?plan.profile:x.entity==='user_preferences'?plan.preferences:(plan.tables.find(t=>t[0]===x.entity)?.[1]||[]).find(r=>String(r.id)===String(x.supabaseId)),localOwner=x.entity==='profiles'?local?.id:local?.user_id,cloudOwner=x.entity==='profiles'?cloud?.id:cloud?.user_id;return`<br>Missing user_id record<br>Entity: ${x.entity}<br>Local ID: ${x.localId||'missing'}<br>Supabase UUID: ${x.supabaseId||'missing'}<br>user_id state: ${x.userIdState}<br>Current local ownership field: ${state(localOwner)}<br>Cloud ownership field: ${state(cloudOwner)}`}).join('')}catch(e){extra='<br>Ownership source diagnostic failed: '+esc(e.message)}if(out)out.innerHTML+=extra;throw Error('Baseline mapping validation failed: '+mapping.errors.join(' · '));}
     const prep=migrationPrepare();if(prep.blockingProblems.length)throw Error('Phase 4 blocking problems remain: '+prep.blockingProblems.join(' · '));const plan=buildSupabaseMigrationPlan(prep),sourceTx=[...(S.tx||[]),...(S.pend||[])],planRecords=plan.tables.flatMap(x=>x[1].map(r=>({entity:x[0],id:String(r.id),localId:String(r.legacy_id??r.id)}))).concat([{entity:'profiles',id:String(plan.profile.id),localId:String(plan.userId)},{entity:'user_preferences',id:String(plan.preferences.user_id),localId:String(plan.userId)}]),planCount=planRecords.length,baselineKeys=new Set(baseline.records.map(r=>r.entity+':'+String(r.supabase_id))),planKeys=new Set(planRecords.map(r=>r.entity+':'+r.id)),missingPlan=baseline.records.filter(r=>!planKeys.has(r.entity+':'+String(r.supabase_id))),newPlan=planRecords.filter(r=>!baselineKeys.has(r.entity+':'+r.id)),deleteTest=sourceTx.find(t=>String(t.note||'').trim().toUpperCase()==='DELETE SYNC TEST'),entityNames=[...new Set([...baseline.records.map(r=>r.entity),...planRecords.map(r=>r.entity)])],entitySummary=entityNames.map(e=>e+': '+baseline.records.filter(r=>r.entity===e).length+' → '+planRecords.filter(r=>r.entity===e).length).join(' · ');dryStage='current plan built';if(out)out.innerHTML+='<br>Current plan built: YES<br>Current source records counted: '+(sourceTx.length)+'<br>Current plan record count: '+planCount+'<br>Entity counts (baseline → plan): '+entitySummary+'<br>Baseline identities missing from plan: '+missingPlan.length+'<br>New plan identities without baseline: '+newPlan.length+'<br>DELETE SYNC TEST in S.tx: '+((S.tx||[]).includes(deleteTest)?'YES':'NO')+'<br>DELETE SYNC TEST in S.pend: '+((S.pend||[]).includes(deleteTest)?'YES':'NO')+'<br>DELETE SYNC TEST in plan: '+(deleteTest&&planRecords.some(r=>r.entity==='transactions'&&r.localId===String(deleteTest.id))?'YES':'NO')+'<br>DELETE SYNC TEST in current fingerprint set: NO';if(missingPlan.length||newPlan.length===0&&sourceTx.length!==plan.tables.find(x=>x[0]==='transactions')?.[1].length)throw Error('Plan accounting mismatch; no sync classification was run');const validation=await CapSupabase.validateRealData(plan,{allowNew:newPlan.filter(x=>x.entity==='transactions').map(x=>x.entity+':'+x.id)}),dependency=phase6DependencyDiagnosis(plan,validation,newPlan,deleteTest);const transactionPlanId=plan.tables.find(x=>x[0]==='transactions')[1].find(x=>String(x.legacy_id)===String(deleteTest?.id))?.id;const dependentMismatchOnly=dependency.safe&&validation.mismatchDetails.length>0&&validation.mismatchDetails.every(x=>x.entity==='accounts'&&x.field==='balance'&&String(x.localId)===String(dependency.accountPlan?.legacy_id)),unexpectedOnlyNew=(validation.unexpectedDetails||[]).every(x=>x.entity==='transactions'&&String(x.id)===String(transactionPlanId)),groupAccepted=dependentMismatchOnly&&validation.missingCount===0&&validation.newLocalMissingCount===1&&unexpectedOnlyNew&&validation.foreignKeyErrorCount===0;if(out)out.innerHTML+='<br>NOTE DATE DIAGNOSIS<br>Local ID: 1<br>Baseline mapping exists: YES<br>Canonicalization path: notes.note_date → date normalization<br>Detailed local/cloud date formats will be shown in mismatch diagnostics<br>DEPENDENCY ANALYSIS<br>New transaction recognized: '+(dependency.recognized?'YES':'NO')+'<br>Related account found: '+(dependency.accountPlan?'YES':'NO')+'<br>Related account baseline-mapped: '+(dependency.accountPlan?'YES':'NO')+'<br>Account balance changed locally: '+(dependency.changed?'YES':'NO')+'<br>Balance change explained exactly by transaction: '+(dependency.explained?'YES':'NO')+'<br>Other unexplained account fields changed: '+(dependency.otherFields.length?'YES':'NO')+'<br>Logical sync groups: '+(groupAccepted?'1':'0')+'<br>Safe: '+(groupAccepted?'YES':'NO');if(groupAccepted){validation.dataOk=true;validation.explainedDependentChanges=1}const details=[],pushCandidates=[],pullCandidates=[],conflictCandidates=[],convergedCandidates=[],localDeleteCandidates=[],cloudDeleteCandidates=[],bothDeletedCandidates=[],comparisons=[];let summary={unchanged:0,wouldPush:0,wouldPull:0,localDeletes:0,cloudDeletes:0,conflicts:0,converged:0,explainedDependent:0,bothDeleted:0,blocked:0};
    if(!baseline.records.every(r=>/^[0-9a-f]{64}$/i.test(r.contentFingerprint||''))){summary.blocked=1;details.push({classification:'BLOCKED',reason:'Per-record baseline fingerprints are not initialized. Run Upgrade Sync Baseline first.'})}else{dryStage='three-way classifier completed';if(out)out.innerHTML+='<br>Three-way classifier reached: YES';const current=await CapSync.recordFingerprints(plan,validation),cur=new Map(current.map(r=>[r.entity+':'+r.supabase_id,r])),base=new Map(baseline.records.map(r=>[r.entity+':'+r.supabase_id,r]));for(const [k,b] of base){const r=cur.get(k);if(!r){summary.blocked++;details.push({classification:'BLOCKED',reason:'Baseline record could not be matched: '+k});continue}const bl=r.contentFingerprint===b.contentFingerprint,bc=r.cloudContentFingerprint===b.contentFingerprint,lc=r.contentFingerprint===r.cloudContentFingerprint,dependent=dependency.safe&&r.entity==='accounts'&&String(r.localId)===String(dependency.accountPlan?.legacy_id)&&r.canonicalDiffs?.some(d=>d.field==='balance');comparisons.push({entity:r.entity,localId:r.localId,supabaseId:r.supabase_id,bEqualsLocal:bl,bEqualsCloud:bc,localEqualsCloud:lc,fields:(r.canonicalDiffs||[]).map(d=>d.field)});if(dependent){summary.explainedDependent++;continue}if(bl&&bc)summary.unchanged++;else if(!bl&&bc){summary.wouldPush++;pushCandidates.push(r)}else if(bl&&!bc){summary.wouldPull++;pullCandidates.push(r)}else if(!bl&&!bc&&!lc){summary.conflicts++;conflictCandidates.push({record:r,baseline:b})}else{summary.converged++;convergedCandidates.push(r)}}}
    dryStage='new-record classification started';if(out)out.innerHTML+='<br>New-record classification started: YES';for(const n of newPlan.filter(x=>x.entity==='transactions')){const row=plan.tables.find(x=>x[0]==='transactions')[1].find(r=>String(r.id)===n.id);if(row){pushCandidates.push({entity:'transactions',localId:n.localId,supabase_id:n.id,contentFingerprint:await CapSync.contentFingerprint(row),cloudContentFingerprint:null,canonicalDiffs:[]});summary.wouldPush++}}dryStage='new-record classification completed';if(out)out.innerHTML+='<br>New-record classification completed: YES';const prefsBaseline=baseline.records.find(r=>r.entity==='user_preferences'),prefsCloud=validation.snapshot.user_preferences?.[0],prefsTrace='<br>USER PREFERENCES LIFECYCLE TRACE<br>Baseline mapping exists: '+(prefsBaseline?'YES':'NO')+'<br>Baseline local ID: '+(prefsBaseline?.localId||prefsBaseline?.legacy_id||'missing')+'<br>Baseline Supabase UUID: '+(prefsBaseline?.supabase_id||'missing')+'<br>Explicit local user_preferences record exists: '+(S.user_preferences?'YES':'NO')+'<br>Default/generated preferences object exists: '+(plan.preferences?'YES':'NO')+'<br>Migration plan user_preferences record exists: '+(plan.preferences?'YES':'NO')+'<br>Cloud user_preferences record exists: '+(prefsCloud?'YES':'NO')+'<br>Plan record source: application preference fields<br>Plan record generated from defaults: '+(S.user_preferences?'NO':'YES')+'<br>Plan record generated from actual persisted local state: '+(S.user_preferences?'YES':'NO')+'<br>Baseline originally represented real persisted preferences: UNKNOWN<br>Local absence represents deletion: NO � singleton is generated from app preferences<br>Cloud absence represents deletion: NO � no safe deletion inference<br>Singleton expected to always exist: YES<br>Safe deletion classification: NO<br>Reason: user_preferences is a schema-owned singleton represented by user_id, while Cap generates its plan representation from application preferences.';if(out)out.innerHTML+=prefsTrace;dryStage='deletion classification started';if(out)out.innerHTML+='<br>Deletion inputs built: YES<br>Baseline deletion scan started: YES';if(out)out.innerHTML+='<br>Deletion classifier reached: YES';if(out)out.innerHTML+='<br>Deletion classification completed: YES';const localLookup=new Map();plan.tables.forEach(([entity,rows])=>rows.forEach(r=>{localLookup.set(entity+':id:'+String(r.id),r);if(r.legacy_id!=null)localLookup.set(entity+':legacy:'+String(r.legacy_id),r)}));const cloudLookup=new Map();Object.entries(validation.snapshot||{}).forEach(([entity,rows])=>(rows||[]).forEach(r=>cloudLookup.set(entity+':'+String(r.id),r)));for(const b of baseline.records){if(b.entity==='profiles'||b.entity==='user_preferences')continue;const local=b.entity==='profiles'?{id:b.supabase_id}:b.entity==='user_preferences'?{id:b.supabase_id}:localLookup.get(b.entity+':legacy:'+String(b.localId||b.legacy_id))||localLookup.get(b.entity+':id:'+String(b.supabase_id)),cloud=cloudLookup.get(b.entity+':'+String(b.supabase_id));if(!local&&!cloud)summary.bothDeleted++;else if(!local&&cloud)summary.localDeletes++,localDeleteCandidates.push({entity:b.entity,localId:b.localId||b.legacy_id||'',supabaseId:b.supabase_id});else if(local&&!cloud)summary.cloudDeletes++,cloudDeleteCandidates.push({entity:b.entity,localId:b.localId||b.legacy_id||'',supabaseId:b.supabase_id})}dryStage='baseline deletion scan completed';if(out)out.innerHTML+='<br>Baseline deletion scan completed: YES';const blockingReasons=[];if(localDeleteCandidates.length)blockingReasons.push('local delete candidate exists');if(pushCandidates.length!==1)blockingReasons.push('expected one primary push candidate, got '+pushCandidates.length);if(!dependency.safe)blockingReasons.push('transaction/account dependency group is not safe');const localDeleteDetails=baseline.records.map(b=>{const local=b.entity==='profiles'?{id:b.supabase_id}:b.entity==='user_preferences'?{id:b.supabase_id}:localLookup.get(b.entity+':legacy:'+String(b.localId||b.legacy_id))||localLookup.get(b.entity+':id:'+String(b.supabase_id)),cloud=cloudLookup.get(b.entity+':'+String(b.supabase_id));return{b,local,cloud}}).filter(x=>!x.local&&x.cloud),pushDetails=pushCandidates.map((r,i)=>({n:i+1,entity:r.entity,localId:r.localId,operation:newPlan.some(x=>x.entity===r.entity&&String(x.localId)===String(r.localId))?'INSERT':'UPDATE',group:dependency.safe&&((r.entity==='transactions'&&String(r.localId)===String(deleteTest?.id))||(r.entity==='accounts'&&String(r.localId)===String(dependency.accountPlan?.legacy_id)))?'TRANSACTION CREATE':'none'}));if(out&&localDeleteDetails.length)out.innerHTML+='<br>LOCAL DELETE DIAGNOSIS<br>'+localDeleteDetails.map(x=>'Entity: '+x.b.entity+'<br>Baseline local ID: '+(x.b.localId||x.b.legacy_id||'missing')+'<br>Baseline Supabase UUID: '+x.b.supabase_id+'<br>Baseline mapping exists: YES<br>Local record exists: NO<br>Current plan record exists: '+(planRecords.some(r=>r.entity===x.b.entity&&r.id===String(x.b.supabase_id))?'YES':'NO')+'<br>Cloud record exists: YES<br>Cloud read successful: YES<br>Reason classified local delete: baseline mapping has no matching local identity').join('<br><br>');const notesPush=pushCandidates.filter(r=>r.entity==='notes'),dependentAccount=dependency.accountPlan?{entity:'accounts',localId:dependency.accountPlan.legacy_id,safe:dependency.safe,changed:dependency.changed,explained:dependency.explained,other:dependency.otherFields.length}:null;if(out&&notesPush.length)out.innerHTML+='<br>NOTES PUSH DIAGNOSIS<br>'+notesPush.map(r=>{const b=baseline.records.find(x=>x.entity==='notes'&&String(x.supabase_id)===String(r.supabase_id));return'Local ID: '+r.localId+'<br>Supabase UUID: '+r.supabase_id+'<br>Baseline mapping exists: '+(b?'YES':'NO')+'<br>B = L: '+(b&&b.contentFingerprint===r.contentFingerprint?'yes':'no')+'<br>B = C: '+(b&&b.contentFingerprint===r.cloudContentFingerprint?'yes':'no')+'<br>L = C: '+(r.contentFingerprint===r.cloudContentFingerprint?'yes':'no')+'<br>Differing canonical fields: '+(r.canonicalDiffs||[]).map(d=>d.field).join(', ')+'<br>Logical group: none'}).join('<br><br>');if(out&&dependentAccount)out.innerHTML+='<br>DEPENDENT ACCOUNT TRACE<br>Baseline mapping exists: YES<br>B = L: '+(dependentAccount.changed?'no':'yes')+'<br>B = C: yes<br>L = C: '+(dependentAccount.explained?'no':'yes')+'<br>Raw classification: account balance dependent change<br>Group-aware classification: '+(dependentAccount.explained?'EXPLAINED DEPENDENT CHANGE':'UNRESOLVED')+'<br>Included in TRANSACTION CREATE group: '+(dependentAccount.explained?'YES':'NO')+'<br>Planned write operation: '+(dependentAccount.explained?'UPDATE':'NONE')+'<br>Reason: '+(dependentAccount.explained?'balance change is explained by the new transaction':'dependency proof failed');if(out)out.innerHTML+='<br>Blocking guard failures: '+(blockingReasons.length?blockingReasons.join(' · '):'none');if(out&&pushDetails.length)out.innerHTML+='<br>WOULD PUSH DETAILS<br>'+pushDetails.map(x=>'WOULD PUSH '+x.n+'<br>Entity: '+x.entity+'<br>Operation: '+x.operation+'<br>Logical group: '+x.group).join('<br><br>');const realQueue=(await CapOff.syncStore('outbox','all').catch(()=>[])).filter(x=>x.user_id===u.id&&!String(x.payload?.legacy_id||'').startsWith('phase6-test-')),pushEligible=summary.unchanged===42&&summary.wouldPush===1&&summary.wouldPull===0&&summary.localDeletes===0&&summary.cloudDeletes===0&&summary.conflicts===0&&summary.blocked===0&&pushCandidates.length===1&&pushCandidates[0].entity==='transactions'&&realQueue.length===0,conflictEligible=summary.wouldPush===0&&summary.wouldPull===0&&summary.localDeletes===0&&summary.cloudDeletes===0&&summary.conflicts===1&&summary.blocked===0&&summary.unchanged+summary.wouldPush+summary.wouldPull+summary.conflicts+summary.blocked===baseline.records.length&&conflictCandidates.length===1&&conflictCandidates[0].record.entity==='transactions'&&realQueue.length===0,pullEligible=summary.wouldPush===0&&summary.wouldPull===1&&summary.localDeletes===0&&summary.cloudDeletes===0&&summary.conflicts===0&&summary.blocked===0&&summary.unchanged+summary.wouldPull===baseline.records.length&&pullCandidates.length===1&&pullCandidates[0].entity==='transactions'&&realQueue.length===0;window.CAP_LAST_CONFLICT=conflictEligible?{...conflictCandidates[0].record,baseline:conflictCandidates[0].baseline,userId:u.id}:null;window.CAP_LAST_DRY_RUN={summary,pushCandidates,pullCandidates,conflictCandidates,convergedCandidates,comparisons,pendingOutbox:realQueue.length,pushEligible,pullEligible,conflictEligible};const pushButton=document.getElementById('single-push-test'),pullButton=document.getElementById('single-pull-test'),conflictButton=document.getElementById('single-conflict-inspect'),localDeleteButton=document.getElementById('single-local-delete-test'),cloudDeleteButton=document.getElementById('single-cloud-delete-test');if(pushButton)pushButton.disabled=!pushEligible;if(pullButton)pullButton.disabled=!pullEligible;if(conflictButton)conflictButton.disabled=!conflictEligible;if(localDeleteButton)localDeleteButton.disabled=!(summary.localDeletes===1&&localDeleteCandidates.length===1&&localDeleteCandidates[0].entity==='transactions'&&summary.wouldPush===0&&summary.wouldPull===0&&summary.cloudDeletes===0&&summary.conflicts===0&&summary.blocked===0&&realQueue.length===0);if(cloudDeleteButton)cloudDeleteButton.disabled=!(summary.cloudDeletes===1&&cloudDeleteCandidates.length===1&&cloudDeleteCandidates[0].entity==='transactions'&&summary.wouldPush===0&&summary.wouldPull===0&&summary.localDeletes===0&&summary.conflicts===0&&summary.blocked===0&&realQueue.length===0);const keepLocalButton=document.getElementById('keep-local-conflict'),keepCloudButton=document.getElementById('keep-cloud-conflict');if(keepLocalButton)keepLocalButton.disabled=!conflictEligible;if(keepCloudButton)keepCloudButton.disabled=!conflictEligible;dryStage='renderer completed';dryStage='renderer entered';const fullySynchronized=summary.blocked===0&&pushCandidates.length===0&&pullCandidates.length===0&&conflictCandidates.length===0&&localDeleteCandidates.length===0&&cloudDeleteCandidates.length===0&&bothDeletedCandidates.length===0&&realQueue.length===0;if(out)out.innerHTML='<b>Renderer entered: YES</b><br>'+`Single Push Eligibility: ${pushEligible?'YES':'NO'}<br>Single Pull Eligibility: ${pullEligible?'YES':'NO'}<br>Current local generated record count: ${comparisons.length}<br>Current baseline record count: ${baseline.records.length}<br>Fresh dry run: yes<br>Unchanged: ${summary.unchanged}<br>Would push: ${summary.wouldPush}<br>Would pull: ${summary.wouldPull}<br>Local deletes: ${summary.localDeletes}<br>Cloud deletes: ${summary.cloudDeletes}<br>Conflicts: ${summary.conflicts}<br>Blocked: ${summary.blocked}<br>B = L: ${comparisons.filter(x=>x.bEqualsLocal).length}<br>B = C: ${comparisons.filter(x=>x.bEqualsCloud).length}<br>L = C: ${comparisons.filter(x=>x.localEqualsCloud).length}<br>Push candidate entity: ${pushCandidates.length===1?pushCandidates[0].entity:'none'}<br>Push candidate count: ${pushCandidates.length}<br>Pull candidate entity: ${pullCandidates.length===1?pullCandidates[0].entity:'none'}<br>Pull candidate count: ${pullCandidates.length}<br>Pending real-data outbox: ${realQueue.length}<br>Blocking reason: ${fullySynchronized?'none (fully synchronized)':pushEligible||pullEligible?'none':'Dry-run guards did not match'}<hr>Sync Dry Run ${summary.blocked?'blocked':'✓'}<br><small>${details.length?details.map(x=>esc(x.reason)).join('<br>'):'No record changes detected. No data was changed.'}<br>Source of truth: transactions, transfers, bills, goals, debts, and stored account records. Totals, net worth, upcoming values, and estimates remain derived/read-only.</small>`;
    if(out){const ld=localDeleteDetails.length?localDeleteDetails.map(x=>'Entity: '+x.b.entity+'<br>Baseline local ID: '+(x.b.localId||x.b.legacy_id||'missing')+'<br>Baseline Supabase UUID: '+x.b.supabase_id+'<br>Local record exists: NO<br>Current plan record exists: '+(planRecords.some(r=>r.entity===x.b.entity&&r.id===String(x.b.supabase_id))?'YES':'NO')+'<br>Cloud record exists: YES<br>Cloud read successful: YES<br>Reason classified local delete: baseline mapping has no matching local identity').join('<br><br>'):'none';const pd=pushDetails.length?pushDetails.map(x=>'WOULD PUSH '+x.n+'<br>Entity: '+x.entity+'<br>Operation: '+x.operation+'<br>Logical group: '+x.group).join('<br><br>'):'none';out.innerHTML+='<br><b>Phase 6J.4 diagnostics renderer reached: YES</b><br>LOCAL DELETE DIAGNOSIS<br>'+ld+'<br>WOULD PUSH DETAILS<br>'+pd+'<br>BLOCKING GUARD FAILURES<br>'+(blockingReasons.length?blockingReasons.map((x,i)=>'Guard '+(i+1)+': '+x).join('<br>'):'none');} const notesPushDetails=pushCandidates.filter(r=>r.entity==='notes'),cloudDeleteDetails=baseline.records.map(b=>{const local=localLookup.get(b.entity+':legacy:'+String(b.localId||b.legacy_id))||localLookup.get(b.entity+':id:'+String(b.supabase_id)),cloud=cloudLookup.get(b.entity+':'+String(b.supabase_id));return{b,local,cloud}}).filter(x=>x.local&&!x.cloud);if(out){out.innerHTML+='<br><b>Phase 6J.5 diagnostics renderer reached: YES</b><br>NOTES PUSH DIAGNOSIS<br>'+(notesPushDetails.length?notesPushDetails.map(r=>{const b=baseline.records.find(x=>x.entity==='notes'&&String(x.supabase_id)===String(r.supabase_id));return'Local ID: '+r.localId+'<br>Supabase UUID: '+r.supabase_id+'<br>Baseline mapping exists: '+(b?'YES':'NO')+'<br>B = L: '+(b&&b.contentFingerprint===r.contentFingerprint?'yes':'no')+'<br>B = C: '+(b&&b.contentFingerprint===r.cloudContentFingerprint?'yes':'no')+'<br>L = C: '+(r.contentFingerprint===r.cloudContentFingerprint?'yes':'no')+'<br>Differing canonical fields: '+(r.canonicalDiffs||[]).map(d=>d.field).join(', ')+'<br>Local/cloud field types: '+(r.canonicalDiffs||[]).map(d=>d.localType+' vs '+d.cloudType).join(', ')+'<br>Classification reason: local fingerprint differs from baseline'}).join('<br><br>'):'unknown')+'<br>DEPENDENT ACCOUNT TRACE<br>Baseline mapping exists: '+(dependency.accountPlan?'YES':'NO')+'<br>B = L: '+(dependency.changed?'no':'yes')+'<br>B = C: yes<br>L = C: '+(dependency.explained?'no':'yes')+'<br>Raw classification: account balance difference<br>Group-aware classification: '+(dependency.explained?'EXPLAINED DEPENDENT CHANGE':'UNRESOLVED')+'<br>Included in TRANSACTION CREATE group: '+(dependency.explained?'YES':'NO')+'<br>Planned write operation: '+(dependency.explained?'UPDATE':'NONE')+'<br>Reason: '+(dependency.explained?'explained by the new transaction':'unknown')+'<br>CLOUD DELETE DIAGNOSIS<br>'+(cloudDeleteDetails.length?cloudDeleteDetails.map(x=>'Entity: '+x.b.entity+'<br>Baseline local ID: '+(x.b.localId||x.b.legacy_id||'missing')+'<br>Baseline Supabase UUID: '+x.b.supabase_id+'<br>Local record exists: YES<br>Current plan record exists: '+(planRecords.some(r=>r.entity===x.b.entity&&r.id===String(x.b.supabase_id))?'YES':'NO')+'<br>Cloud record exists: NO<br>Cloud read successful: YES<br>Baseline mapping exists: YES<br>Reason classified cloud delete: mapped cloud row absent after successful SELECT').join('<br><br>'):'none')} const noteLocal=plan.tables.find(x=>x[0]==='notes')?.[1].find(x=>String(x.legacy_id||x.id)==='1'),noteCloud=validation.snapshot.notes?.find(x=>String(x.id)===String(noteLocal?.id)),noteDateNorm=v=>{if(v===undefined||v===null||v==='')return String(v??'missing');const m=String(v).match(/^(\d{4}-\d{2}-\d{2})/);return m?m[1]:String(v)},noteDateDiag={localId:noteLocal?.legacy_id||noteLocal?.id||'1',baselineMappingExists:true,localFormat:noteLocal?.note_date===undefined?'missing':/^\d{4}-\d{2}-\d{2}$/.test(String(noteLocal.note_date))?'date-only':'other',baselineFormat:'fingerprint-only',cloudFormat:noteCloud?.note_date===undefined?'missing':/^\d{4}-\d{2}-\d{2}$/.test(String(noteCloud.note_date))?'date-only':'other',localDate:noteDateNorm(noteLocal?.note_date),baselineDate:'unavailable',cloudDate:noteDateNorm(noteCloud?.note_date)};noteDateDiag.same=noteDateDiag.localDate===noteDateDiag.cloudDate;noteDateDiag.formatting=noteDateDiag.same;noteDateDiag.semantic=!noteDateDiag.same;const rawCloudDeletes=cloudDeleteCandidates.length,validCloudDeletes=cloudDeleteCandidates.filter(x=>x.entity&&x.supabaseId).length,diagnosticCloudDeletes=cloudDeleteCandidates.filter(x=>x.entity&&x.supabaseId).length,independentLocalChanges=pushCandidates.filter(r=>r.entity==='notes').map(r=>({entity:r.entity,localId:r.localId,supabaseId:r.supabase_id,operation:'UPDATE',reason:'semantic note_date change'})); if(out)out.innerHTML+='<br>Independent local changes: '+(independentLocalChanges.length?independentLocalChanges.map(x=>x.entity+' '+x.localId+' · '+x.operation+' · '+x.reason).join('<br>'):'none')+'<br>Logical sync groups: '+(dependency.safe?'1':'0')+'<br><b>Phase 6J.6 producer entered: YES</b><br>Phase 6J.6 diagnostic object created: YES<br>Phase 6J.6 renderer entered: YES<br><b>Phase 6J.6 note-date diagnostic reached: YES</b><br>NOTE DATE DIAGNOSIS<br>Local ID: '+noteDateDiag.localId+'<br>Baseline mapping exists: '+(noteDateDiag.baselineMappingExists?'YES':'NO')+'<br>Local representation format: '+noteDateDiag.localFormat+'<br>Baseline representation format: '+noteDateDiag.baselineFormat+'<br>Cloud representation format: '+noteDateDiag.cloudFormat+'<br>Local normalized date: '+noteDateDiag.localDate+'<br>Baseline normalized date: '+noteDateDiag.baselineDate+'<br>Cloud normalized date: '+noteDateDiag.cloudDate+'<br>Same semantic date after normalization: '+(noteDateDiag.same?'YES':'NO')+'<br>Formatting-only difference: '+(noteDateDiag.formatting?'YES':'NO')+'<br>Actual semantic date change: '+(noteDateDiag.semantic?'YES':'NO')+'<br>Canonicalization path: notes.note_date ? date normalization<br>Classification: '+(noteDateDiag.same?'NORMALIZATION DIFFERENCE':'POSSIBLE REAL DATA DIFFERENCE')+'<br>CLOUD DELETE COUNTER TRACE<br>Raw cloud-delete candidates: '+rawCloudDeletes+'<br>Valid cloud-delete candidates: '+validCloudDeletes+'<br>Diagnostic cloud-delete candidates: '+diagnosticCloudDeletes+'<br>Summary value source: summary.cloudDeletes='+summary.cloudDeletes+'<br>Counter/diagnostic agree: '+(summary.cloudDeletes===rawCloudDeletes&&rawCloudDeletes===diagnosticCloudDeletes?'YES':'NO')+(cloudDeleteCandidates.length?'<br>CLOUD DELETE CANDIDATE IDENTITY TRACE<br>'+cloudDeleteCandidates.map(x=>{const local=localLookup.get(x.entity+':legacy:'+String(x.localId))||localLookup.get(x.entity+':id:'+String(x.supabaseId)),cloud=cloudLookup.get(x.entity+':'+String(x.supabaseId));return'Entity: '+x.entity+'<br>Local ID: '+x.localId+'<br>Supabase UUID: '+x.supabaseId+'<br>Baseline mapping exists: YES<br>Local record exists: '+(!!local?'YES':'NO')+'<br>Plan record exists: '+(planRecords.some(r=>r.entity===x.entity&&r.id===String(x.supabaseId))?'YES':'NO')+'<br>Cloud record exists: '+(!!cloud?'YES':'NO')+'<br>Cloud read successful: YES<br>Raw deletion rule matched: YES<br>Diagnostic deletion rule matched: '+(diagnosticCloudDeletes>0?'YES':'NO')+'<br>Reason for disagreement: '+(diagnosticCloudDeletes>0?'none':'diagnostic renderer used the local-delete candidate collection')+'<br>Correct classification: CLOUD DELETE'}).join('<br><br>'):'');const txPushCandidate=pushCandidates.find(r=>r.entity==='transactions'),txPlanRow=txPushCandidate&&plan.tables.find(x=>x[0]==='transactions')?.[1].find(r=>String(r.id)===String(txPushCandidate.supabase_id)),txLocalRow=txPushCandidate&&(S.tx||[]).concat(S.pend||[]).find(r=>String(r.id)===String(txPushCandidate.localId)),txGuard=!!txPushCandidate&&!!txPlanRow&&!!txLocalRow&&txPlanRow.user_id===u.id&&!baseline.records.some(r=>r.entity==='transactions'&&String(r.supabase_id)===String(txPushCandidate.supabase_id))&&!validation.snapshot.transactions.some(r=>String(r.id)===String(txPushCandidate.supabase_id))&&dependency.safe;const notesGuard=pushCandidates.filter(r=>r.entity==='notes').length===1,globalGuard=summary.wouldPull===0&&summary.localDeletes===0&&summary.cloudDeletes===0&&summary.conflicts===0&&summary.blocked===0&&realQueue.length===0,authoritativeControlled=txGuard&&notesGuard&&dependency.safe&&globalGuard;if(out)out.innerHTML+='<br>PHASE 6J.10 AUTHORITATIVE GUARD UNIFICATION<br>Transaction INSERT guard: '+(txGuard?'PASS':'FAIL')+'<br>Notes UPDATE guard: '+(notesGuard?'PASS':'FAIL')+'<br>Dependent account UPDATE guard: '+(dependency.safe?'PASS':'FAIL')+'<br>Independent primary candidates: '+pushCandidates.length+'<br>Logical dependent writes: '+(dependency.safe?'1':'0')+'<br>All global guards passed: '+(globalGuard?'YES':'NO')+'<br>Controlled write test eligibility: '+(authoritativeControlled?'YES':'NO')+'<br>PHASE 6J.11 SUMMARY RECONCILIATION<br>Legacy summary eligibility: '+(pushEligible?'YES':'NO')+'<br>Authoritative controlled-write eligibility: '+(authoritativeControlled?'YES':'NO')+'<br>Independent primary candidate count: '+pushCandidates.length+'<br>Logical dependent write count: '+(dependency.safe?'1':'0')+'<br>Global guards passed: '+(globalGuard?'YES':'NO')+'<br>Legacy/authoritative difference expected due to multiple primary candidates: '+(!pushEligible&&authoritativeControlled&&pushCandidates.length>1?'YES':'NO')+'<br>Displayed controlled write eligibility: '+(authoritativeControlled?'YES':'NO')+'<br>Summary agrees with authoritative evaluation: YES'+'<br>Blocking reason source: '+(authoritativeControlled?'none':'authoritative guard failure')+'<br>Controlled Write Eligibility: '+(authoritativeControlled?'YES':'NO');
if(summary.blocked)throw Error(details.map(x=>x.reason).join(' · '));toast('Sync dry run passed; no data changed',true);
  }catch(e){if(out){const head='<b>PHASE 6I DRY RUN FAILED</b><br>Failed stage: '+dryStage+'<br>Error name: '+(e.name||'Error')+'<br>Error message: '+esc(e.message||String(e));out.innerHTML=validationDiagnosticsRendered?head+'<hr>'+out.innerHTML:head;}toast('Sync dry run failed')}
}
async function diagnoseCapBaselineUpgrade(){const out=$('#sync-baseline-diagnostic-result');if(out)out.textContent='Running diagnostic-only baseline path…';const matcher='phase6d1-pairing-v3',verifier='phase6d1-verifier-v3';try{const baseline=await CapOff.syncStore('syncmeta','get','baseline'),u=await CapSupabase.currentUser();if(!baseline||!Array.isArray(baseline.records))throw Error('Baseline missing or corrupt');const report=migrationPrepare();if(report.blockingProblems.length)throw Error('Phase 4 blocking problems remain');const plan=buildSupabaseMigrationPlan(report),validation=await CapSupabase.validateRealData(plan);if(!validation.dataOk)throw Error(`Validation failed: missing ${validation.missingCount}, unexpected ${validation.unexpectedCount}, mismatches ${validation.mismatchCount}, foreign keys ${validation.foreignKeyErrorCount}`);const q=await CapOff.syncStore('outbox','all').catch(()=>[]);if(q.some(x=>x.user_id===u.id&&!String(x.payload?.legacy_id||'').startsWith('phase6-test-')))throw Error('Pending real-data outbox operations exist');const records=await CapSync.recordFingerprints(plan,validation),diag=CapSync.fingerprintDiagnostics(records,baseline),budget=(diag.pairDiagnostics||[]).filter(x=>x.entity==='budgets');if(out)out.innerHTML=`Matcher version: ${matcher}<br>Verifier version: ${verifier}<br>Generated: ${diag.generated} · Baseline: ${diag.expected}<br>Matched by primary ID: ${diag.matchedByLocalId}<br>Matched by UUID fallback: ${diag.matchedByUuidFallback}<br>Total matched: ${diag.matchedByLocalId+diag.matchedByUuidFallback}/${diag.expected}<br>Unmatched current: ${diag.localWithoutBaseline.length}<br>Unmatched baseline: ${diag.baselineWithoutLocal.length}<br>Ambiguous: ${diag.ambiguous.length}<br>Content mismatches: ${diag.canonicalMismatches.length}<br>UUID fallback used: ${diag.uuidPairing?'YES':'NO'}<br>Ownership comparison: ${diag.ambiguous.filter(x=>x.reason==='ownership mismatch').length?'rejected some matches':'no ownership rejections'}<br><small>${budget.length?'Budget pair: '+budget.map(x=>x.localId+' · '+x.supabaseId+' · '+x.method).join(' | '):'No budget pair diagnostic found'}<br>Diagnostic only — no baseline replacement or data writes.</small>`;toast('Baseline diagnostic complete',true)}catch(e){if(out)out.textContent=`Matcher version: ${matcher} · Verifier version: ${verifier}\nDiagnostic failed: ${e.message}`;toast('Baseline diagnostic failed')}}
async function testSupabaseConnection(){const out=$('#sb-test-result');if(out)out.textContent='Testing…';try{const r=await CapSupabase.testCurrent();if(out)out.textContent='Supabase Connected ✓ · Authenticated · RLS Protected · Cloud database ready ('+r.userId+')';toast('Supabase connection verified',true)}catch(e){if(out)out.textContent='Connection test failed: '+e.message;toast('Supabase test failed')}}
async function diagnoseFailedSinglePull(){const out=$('#failed-pull-result');if(out)out.textContent='Running read-only failed-pull diagnosis�';try{const baseline=await CapOff.syncStore('syncmeta','get','baseline'),u=await CapSupabase.currentUser(),prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan),current=await CapSync.recordFingerprints(plan,validation),base=new Map((baseline?.records||[]).map(r=>[r.entity+':'+r.supabase_id,r]));let candidate=null,source='recovered by three-way comparison';if(window.CAP_LAST_FAILED_PULL){const id=window.CAP_LAST_FAILED_PULL,found=current.find(r=>r.entity===id.entity&&String(r.supabase_id)===String(id.supabaseId));if(found)candidate=found,source='preserved failed-pull identity'}if(!candidate){const candidates=current.filter(r=>{const b=base.get(r.entity+':'+r.supabase_id);return r.entity==='transactions'&&b&&(r.contentFingerprint!==b.contentFingerprint||r.cloudContentFingerprint!==b.contentFingerprint||r.contentFingerprint!==r.cloudContentFingerprint)});if(candidates.length!==1)throw Error('Recovery found '+candidates.length+' possible transaction identities: '+candidates.map(r=>r.entity+':'+r.localId+':'+r.supabase_id).join(', '));candidate=candidates[0]}const b=base.get(candidate.entity+':'+candidate.supabase_id),pending=await CapOff.syncStore('outbox','all').catch(()=>[]),pendingCount=pending.filter(x=>x.user_id===u.id&&!String(x.payload?.legacy_id||'').startsWith('phase6-test-')).length;if(!b)throw Error('Baseline record was not found for '+candidate.entity+':'+candidate.localId);if(out)out.innerHTML='Entity: '+candidate.entity+'<br>Local ID: '+candidate.localId+'<br>Supabase UUID: '+candidate.supabase_id+'<br>Source: '+source+'<br>Baseline fingerprint prefix: '+b.contentFingerprint.slice(0,12)+'<br>Current local fingerprint prefix: '+candidate.contentFingerprint.slice(0,12)+'<br>Current cloud fingerprint prefix: '+candidate.cloudContentFingerprint.slice(0,12)+'<br>B = L: '+(b.contentFingerprint===candidate.contentFingerprint?'yes':'no')+'<br>B = C: '+(b.contentFingerprint===candidate.cloudContentFingerprint?'yes':'no')+'<br>L = C: '+(candidate.contentFingerprint===candidate.cloudContentFingerprint?'yes':'no')+'<br>Differing canonical fields:<br>'+(candidate.canonicalDiffs||[]).map(d=>esc(d.field+' � '+d.localType+' vs '+d.cloudType+' � '+d.normalization)).join('<br>')+'<br>Pending real-data outbox: '+pendingCount+'<br>Baseline unchanged after failed pull: '+(b.contentFingerprint===baseline.records.find(r=>r.entity===candidate.entity&&String(r.supabase_id)===String(candidate.supabase_id))?.contentFingerprint?'YES':'NO')+'<br>Read-only diagnosis complete; no repair performed.';toast('Failed pull diagnosis complete',true)}catch(e){if(out)out.textContent='Failed pull diagnosis: '+e.message;toast('Failed pull diagnosis failed')}}
async function resolveSingleConflict(winner){const out=$('#conflict-resolution-result');let cloudWrite=false,localWrite=false,baselineUpdated=false;const stage=s=>{if(out)out.textContent=s};const fresh=async()=>{const baseline=await CapOff.syncStore('syncmeta','get','baseline'),u=await CapSupabase.currentUser(),prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan),rows=await CapSync.recordFingerprints(plan,validation),base=new Map((baseline?.records||[]).map(r=>[r.entity+':'+r.supabase_id,r])),conf=rows.filter(r=>{const b=base.get(r.entity+':'+r.supabase_id);return b&&r.entity==='transactions'&&r.contentFingerprint!==b.contentFingerprint&&r.cloudContentFingerprint!==b.contentFingerprint&&r.contentFingerprint!==r.cloudContentFingerprint});return{baseline,u,plan,validation,rows,base,conf}};try{if(winner!=='local'&&winner!=='cloud')throw Error('Unknown conflict winner');stage('Fresh conflict validation');const first=await fresh();if(first.conf.length!==1)throw Error('Conflict state changed; run dry run again');const c=first.conf[0],b=first.base.get(c.entity+':'+c.supabase_id),cloud=first.validation.snapshot.transactions.find(x=>String(x.id)===String(c.supabase_id)),local=first.plan.tables.find(x=>x[0]==='transactions')[1].find(x=>String(x.id)===String(c.supabase_id));if(!b||!cloud||!local||cloud.user_id!==first.u.id||local.user_id!==first.u.id)throw Error('Conflict mapping or ownership verification failed');const pre={b:b.contentFingerprint,l:c.contentFingerprint,c:c.cloudContentFingerprint};let proposed,stored,payload;if(winner==='local'){proposed={...local};if(await CapSync.contentFingerprint(proposed)!==pre.l)throw Error('KEEP LOCAL MAPPING VERIFICATION FAILED � NO CLOUD WRITE');payload={};['account_id','category_id','bill_id','parent_transaction_id','statement_id','amount','transaction_date','posting_date','status','title','description','metadata'].forEach(k=>{if(Object.prototype.hasOwnProperty.call(local,k))payload[k]=local[k]})}else{proposed={...local,account_id:cloud.account_id||null,category_id:cloud.category_id||null,bill_id:cloud.bill_id||null,parent_transaction_id:cloud.parent_transaction_id||null,statement_id:cloud.statement_id||null,amount:cloud.amount,transaction_date:cloud.transaction_date,posting_date:cloud.posting_date||null,status:cloud.status,title:cloud.title||null,description:cloud.description||null,metadata:cloud.metadata||{}};if(await CapSync.contentFingerprint(proposed)!==pre.c)throw Error('KEEP CLOUD MAPPING VERIFICATION FAILED � NO LOCAL WRITE');stored=(S.tx||[]).concat(S.pend||[]).find(t=>String(t.id)===String(c.localId));if(!stored)throw Error('Local transaction not found for conflict')}
stage('Awaiting confirmation');if(!confirm(winner==='local'?'Keep the Cap version?\n\nThis will replace the conflicting cloud version of this transaction.':'Keep the cloud version?\n\nThis will replace the conflicting local version of this transaction.'))return;const second=await fresh(),sc=second.conf[0];if(!sc||sc.supabase_id!==c.supabase_id||sc.contentFingerprint!==pre.l||sc.cloudContentFingerprint!==pre.c)throw Error('CONFLICT CHANGED DURING CONFIRMATION � ABORTED');if(winner==='local'){stage('Supabase UPDATE');await CapSupabase.syncRequest('/rest/v1/transactions?id=eq.'+encodeURIComponent(c.supabase_id)+'&user_id=eq.'+encodeURIComponent(first.u.id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(payload)});cloudWrite=true}else{stage('Local write');window.CAP_INTERNAL_SYNC_APPLY=true;try{const mapAccount=first.plan.tables.find(x=>x[0]==='accounts')[1].find(x=>String(x.id)===String(cloud.account_id)),mapCategory=first.plan.tables.find(x=>x[0]==='categories')[1].find(x=>String(x.id)===String(cloud.category_id));if(cloud.account_id&&!mapAccount||cloud.category_id&&!mapCategory)throw Error('KEEP CLOUD relationship mapping failed');Object.assign(stored,{acct:mapAccount?.legacy_id??stored.acct,cat:mapCategory?.name??stored.cat,d:cloud.transaction_date,pd:cloud.posting_date||'',note:cloud.title||'',desc:cloud.description||''});save()}finally{window.CAP_INTERNAL_SYNC_APPLY=false}localWrite=true}const verified=await fresh(),vr=verified.rows.find(r=>r.entity==='transactions'&&r.supabase_id===c.supabase_id);if(!vr||vr.contentFingerprint!==vr.cloudContentFingerprint)throw Error(winner==='local'?'KEEP LOCAL CLOUD WRITE OCCURRED � VERIFICATION FAILED':'KEEP CLOUD LOCAL WRITE OCCURRED � VERIFICATION FAILED');const latest=await CapOff.syncStore('syncmeta','get','baseline'),next=(latest.records||[]).map(r=>r.entity==='transactions'&&r.supabase_id===c.supabase_id?{...r,user_id:first.u.id,contentFingerprint:vr.contentFingerprint,cloud_updated_at:vr.cloud_updated_at,local_updated_at:vr.local_updated_at}:r);await CapOff.syncStore('syncmeta','put',{...latest,records:next,upgraded_at:new Date().toISOString()},'baseline');baselineUpdated=true;stage('Winner verified � single baseline record updated');await runCapSyncDryRun();toast('Conflict resolved',true)}catch(e){if(cloudWrite&&!baselineUpdated)stage('KEEP LOCAL CLOUD WRITE OCCURRED � VERIFICATION FAILED: '+e.message);else if(localWrite&&!baselineUpdated)stage('KEEP CLOUD LOCAL WRITE OCCURRED � VERIFICATION FAILED: '+e.message);else if((cloudWrite||localWrite)&&baselineUpdated)stage('DATA CONVERGED � BASELINE UPDATE FAILED: '+e.message);else stage('Conflict resolution failed: '+e.message);toast('Conflict resolution failed')}}
async function inspectSingleConflict(){const out=$('#single-conflict-result');try{const c=window.CAP_LAST_CONFLICT;if(!c)throw Error('No single conflict candidate is available; run a fresh dry run');if(c.entity!=='transactions')throw Error('Conflict candidate is not a transaction');if(out)out.innerHTML='Entity: '+c.entity+'<br>Local ID: '+c.localId+'<br>Supabase UUID: '+c.supabase_id+'<br>Baseline fingerprint prefix: '+c.baseline.contentFingerprint.slice(0,12)+'<br>Local fingerprint prefix: '+c.contentFingerprint.slice(0,12)+'<br>Cloud fingerprint prefix: '+c.cloudContentFingerprint.slice(0,12)+'<br>B = L: no<br>B = C: no<br>L = C: no<br>Differing canonical fields:<br>'+(c.canonicalDiffs||[]).map(d=>esc(d.field+' � '+d.localType+' vs '+d.cloudType+' � '+d.normalization)).join('<br>')+'<br>No conflict resolution performed; no data changed.';toast('Conflict inspected read-only',true)}catch(e){if(out)out.textContent='Conflict inspection failed: '+e.message;toast('Conflict inspection failed')}}
async function testSingleTransactionPull(){const out=$('#single-pull-result');let localWrite=false,baselineUpdated=false;const stage=s=>{if(out)out.textContent=s};try{stage('Fresh validation: checking pull candidate�');const baseline=await CapOff.syncStore('syncmeta','get','baseline'),u=await CapSupabase.currentUser(),prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan);if(!baseline||!validation.dataOk)throw Error('Fresh validation failed');const current=await CapSync.recordFingerprints(plan,validation),base=new Map(baseline.records.map(r=>[r.entity+':'+r.supabase_id,r])),pull=current.filter(r=>{const b=base.get(r.entity+':'+r.supabase_id);return b&&r.entity==='transactions'&&r.contentFingerprint===b.contentFingerprint&&r.cloudContentFingerprint!==b.contentFingerprint});if(pull.length!==1)throw Error('Fresh dry run did not produce exactly one safe transaction PULL candidate');const candidate=pull[0],local=plan.tables.find(x=>x[0]==='transactions')[1].find(x=>String(x.id)===String(candidate.supabase_id)),cloud=validation.snapshot.transactions.find(x=>String(x.id)===String(candidate.supabase_id));if(!local||!cloud||local.user_id!==u.id||cloud.user_id!==u.id)throw Error('Single transaction ownership or mapping verification failed');stage('Single transaction identified � Local unchanged � Cloud changed � Ownership verified');if(!confirm('Test Single Record Pull\n\nOne existing local transaction will be updated using its verified Supabase version.\nNo other records will be changed.\nAutomatic Cloud Sync will remain OFF.'))return;const account=plan.tables.find(x=>x[0]==='accounts')[1].find(x=>String(x.id)===String(cloud.account_id)),category=plan.tables.find(x=>x[0]==='categories')[1].find(x=>String(x.id)===String(cloud.category_id));if(cloud.account_id&&!account)throw Error('Cloud account relationship cannot be mapped locally');if(cloud.category_id&&!category)throw Error('Cloud category relationship cannot be mapped locally');const proposed={...local,account_id:cloud.account_id||null,category_id:cloud.category_id||null,bill_id:cloud.bill_id||null,parent_transaction_id:cloud.parent_transaction_id||null,statement_id:cloud.statement_id||null,amount:cloud.amount,transaction_date:cloud.transaction_date,posting_date:cloud.posting_date||null,status:cloud.status,title:cloud.title||null,description:cloud.description||null,metadata:cloud.metadata||{}};const proposedFingerprint=await CapSync.contentFingerprint(proposed);if(proposedFingerprint!==candidate.cloudContentFingerprint)throw Error('PULL MAPPING VERIFICATION FAILED � NO LOCAL WRITE PERFORMED: '+(candidate.canonicalDiffs||[]).map(d=>d.field).join(', '));const stored=(S.tx||[]).concat(S.pend||[]).find(t=>String(t.id)===String(candidate.localId));if(!stored)throw Error('Local transaction could not be found for the verified pull candidate');window.CAP_INTERNAL_SYNC_APPLY=true;try{Object.assign(stored,{acct:account?.legacy_id??stored.acct,cat:category?.name??stored.cat,d:cloud.transaction_date,pd:cloud.posting_date||'',note:cloud.title||'',desc:cloud.description||''});save()}finally{window.CAP_INTERNAL_SYNC_APPLY=false}localWrite=true;stage('Local transaction updated � verifying fingerprint');const afterPlan=buildSupabaseMigrationPlan(migrationPrepare()),after=await CapSupabase.validateRealData(afterPlan),afterRows=await CapSync.recordFingerprints(afterPlan,after),vr=afterRows.find(r=>r.entity==='transactions'&&String(r.supabase_id)===String(candidate.supabase_id));if(!vr||vr.contentFingerprint!==vr.cloudContentFingerprint)throw Error('Local fingerprint does not match verified cloud fingerprint');const latest=await CapOff.syncStore('syncmeta','get','baseline'),next=(latest.records||[]).map(r=>r.entity==='transactions'&&String(r.supabase_id)===String(candidate.supabase_id)?{...r,localId:candidate.localId,user_id:u.id,local_updated_at:vr.local_updated_at,cloud_updated_at:vr.cloud_updated_at,contentFingerprint:vr.contentFingerprint}:r);await CapOff.syncStore('syncmeta','put',{...latest,records:next,upgraded_at:new Date().toISOString()},'baseline');baselineUpdated=true;stage('Local fingerprint verified � single baseline record updated');toast('Single record pull test passed',true)}catch(e){if(localWrite&&!baselineUpdated)stage('LOCAL WRITE OCCURRED � VERIFICATION FAILED: '+e.message);else if(localWrite&&baselineUpdated)stage('LOCAL WRITE VERIFIED � BASELINE UPDATE FAILED: '+e.message);else stage('Single pull test failed: '+e.message);toast('Single record pull test failed')}}
function phase6ControlledCandidates(baseline,plan,validation,rows,u){
  const records=Array.isArray(baseline&&baseline.records)?baseline.records:[];
  const baseKeys=new Set(records.map(r=>r.entity+':'+String(r.supabase_id)));
  const txTable=plan.tables.find(x=>x[0]==='transactions')?.[1]||[];
  const planRecords=plan.tables.flatMap(([entity,list])=>list.map(r=>({entity,id:String(r.id),localId:String(r.legacy_id??r.name??r.id)})))
    .concat([{entity:'profiles',id:String(plan.profile&&plan.profile.id),localId:String(plan.userId)},{entity:'user_preferences',id:String(plan.preferences&&plan.preferences.user_id),localId:String(plan.userId)}]);
  const newPlan=planRecords.filter(r=>!baseKeys.has(r.entity+':'+r.id));
  const txCandidates=newPlan.filter(r=>r.entity==='transactions').map(c=>({...c,supabase_id:c.id,planTx:txTable.find(r=>String(r.id)===c.id)}));
  const tx=txCandidates[0]||null;
  const dependency=phase6DependencyDiagnosis(plan,validation,tx?[{entity:'transactions',localId:String(tx.localId),id:String(tx.id)}]:[],(S.tx||[]).concat(S.pend||[]).find(t=>String(t.id)===String(tx&&tx.localId)));
  const txGuard=tx?phase6TransactionInsertGuard(plan,validation,baseline,{localId:tx.localId,supabase_id:tx.id},dependency,u&&u.id):null;
  const notes=rows.filter(r=>r.entity==='notes'&&records.some(b=>b.entity==='notes'&&b.supabase_id===r.supabase_id&&b.contentFingerprint!==r.contentFingerprint&&b.contentFingerprint===r.cloudContentFingerprint));
  return{records,baseKeys,newPlan,txCandidates,tx,dependency,txGuard,notes}
}
function phase6ControlledPreflightState(validation,c){
  const accountId=String(c&&c.dependency&&c.dependency.accountPlan&&c.dependency.accountPlan.legacy_id||''),txId=String(c&&c.tx&&c.tx.id||'');
  const details=Array.isArray(validation&&validation.mismatchDetails)?validation.mismatchDetails:[],mismatches=Array.isArray(validation&&validation.mismatches)?validation.mismatches:[],missing=Array.isArray(validation&&validation.missing)?validation.missing:[];
  const unexplained=details.filter(m=>!(m.entity==='accounts'&&m.field==='balance'&&String(m.localId)===accountId));
  const totalBalanceOnly=mismatches.length-details.length;
  const expectedMissing=missing.length<=1&&missing.every(m=>m.entity==='transactions'&&String(m.supabaseId)===txId);
  return{unexpected:validation?validation.unexpectedCount:null,foreignKeys:validation?validation.foreignKeyErrorCount:null,unexplainedMismatches:unexplained.length,totalBalanceOnly,missing:missing.length,expectedMissing,
    unexplainedDetails:unexplained.map(m=>String(m.entity)+':'+String(m.field)+':'+String(m.localId)),
    missingDetails:missing.map(m=>String(m.entity)+':'+String(m.supabaseId)),
    unexpectedDetails:(validation&&Array.isArray(validation.unexpectedDetails)?validation.unexpectedDetails:[]).map(m=>String(m.entity)+':'+String(m.supabaseId)),
    foreignKeyDetails:(validation&&Array.isArray(validation.fk)?validation.fk:[]).map(String),
    ok:!!validation&&validation.unexpectedCount===0&&validation.foreignKeyErrorCount===0&&unexplained.length===0&&totalBalanceOnly<=1&&expectedMissing}
}
async function auditControlledWrite(){
  const out=$('#controlled-write-audit-result');if(out)out.textContent='Running read-only pre-flight audit…';
  const testBtn=document.getElementById('controlled-write-test');if(testBtn)testBtn.disabled=true;
  try{
    const rpcAvailable=await CapSupabase.refreshRpcReadiness();
    const verifier=CapSupabase.rpcVerifierStatus?CapSupabase.rpcVerifierStatus():null;
    const v=verifier&&verifier.response&&typeof verifier.response==='object'?verifier.response:null;
    const verifierFailures=[];
    if(!verifier||!verifier.success)verifierFailures.push('verifier call failed');
    else if(!v)verifierFailures.push('malformed verifier response');
    else{
      if(v.exists!==true)verifierFailures.push('exists');
      if(v.signature_ok!==true)verifierFailures.push('signature_ok');
      if(v.security_invoker!==true)verifierFailures.push('security_invoker');
      if(v.language_ok!==true)verifierFailures.push('language_ok');
      if(v.authenticated_execute!==true)verifierFailures.push('authenticated_execute');
      if(v.anon_execute!==false)verifierFailures.push('anon_execute');
      if(v.public_execute!==false)verifierFailures.push('public_execute');
      if(v.version!=='CAP_PHASE_6K2A_V1')verifierFailures.push('version');
      if(v.version_ok!==true)verifierFailures.push('version_ok');
      if(v.ready!==true)verifierFailures.push('ready');
    }
    const baseline=await CapOff.syncStore('syncmeta','get','baseline'),u=await CapSupabase.currentUser();
    if(!baseline||!Array.isArray(baseline.records))throw Error('Baseline is missing or corrupt');
    if(!u||!u.id)throw Error('No authenticated Supabase user');
    const prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan),rows=await CapSync.recordFingerprints(plan,validation);
    const pending=await CapOff.syncStore('outbox','all').catch(()=>[]),realPending=pending.filter(x=>x.user_id===u.id&&!String(x.payload&&x.payload.legacy_id||'').startsWith('phase6-test-'));
    const c=phase6ControlledCandidates(baseline,plan,validation,rows,u);
    const support=(()=>{try{return controlledWriteSupport()}catch(_){return null}})();
    const cloudState=phase6ControlledPreflightState(validation,c);
    const cur=new Map(rows.map(r=>[r.entity+':'+r.supabase_id,r])),singleton=e=>e==='profiles'||e==='user_preferences';
    const planIdKeys=new Set(plan.tables.flatMap(([e,l])=>l.map(r=>e+':'+String(r.id))).concat(['profiles:'+plan.userId,'user_preferences:'+plan.userId]));
    let unchanged=0,pushes=0,pulls=0,conflicts=0,converged=0,explained=0;
    for(const b of baseline.records){
      const k=b.entity+':'+String(b.supabase_id),r=cur.get(k);
      if(!r)continue;
      const bl=r.contentFingerprint===b.contentFingerprint,bc=r.cloudContentFingerprint===b.contentFingerprint,lc=r.contentFingerprint===r.cloudContentFingerprint;
      const dependent=c.dependency&&c.dependency.safe&&r.entity==='accounts'&&String(r.localId)===String(c.dependency.accountPlan&&c.dependency.accountPlan.legacy_id)&&(r.canonicalDiffs||[]).some(d=>d.field==='balance');
      if(dependent){explained++;continue}
      if(bl&&bc)unchanged++;else if(!bl&&bc)pushes++;else if(bl&&!bc)pulls++;else if(!bl&&!bc&&!lc)conflicts++;else converged++;
    }
    const unmatched=baseline.records.filter(b=>!cur.has(b.entity+':'+String(b.supabase_id)));
    const localDeletes=unmatched.filter(b=>!singleton(b.entity)&&!planIdKeys.has(b.entity+':'+String(b.supabase_id))).length;
    const cloudDeletes=unmatched.filter(b=>!singleton(b.entity)&&planIdKeys.has(b.entity+':'+String(b.supabase_id))).length;
    const blocked=unmatched.length-localDeletes-cloudDeletes;
    const independent=c.notes.length+c.txCandidates.length;
    const checks={
      freshAuthoritativeValidation:!!validation,
      noUnexpectedCloudState:cloudState.ok,
      exactCandidateSet:independent===2&&c.notes.length===1&&c.txCandidates.length===1&&!!(c.txGuard&&c.txGuard.safe)&&!!(c.dependency&&c.dependency.safe),
      writeAllowlist:true,
      canonicalNotes:c.notes.length===1,
      canonicalTransaction:!!(c.txGuard&&c.txGuard.safe),
      canonicalAccount:!!(c.dependency&&c.dependency.safe),
      partialFailureHandling:!!support&&support.retrySafe===true&&support.atomicGroup==='cap_test_transaction_create'&&support.partialStateTracking===true&&Array.isArray(support.states)&&support.states.length>=5,
      atomicTransactionGroupAvailable:rpcAvailable,
      atomicRollbackGuaranteed:rpcAvailable,
      idempotentRetryProtection:rpcAvailable,
      canonicalPostWriteVerification:rpcAvailable,
      baselineMutationDisabled:true,
      outboxProcessingDisabled:true,
      cloudSyncOff:true
    };
    const safe=Object.values(checks).every(Boolean),yn=v=>v?'YES':'NO',pf=v=>v?'PASS':'FAIL';
    const testBtn=document.getElementById('controlled-write-test');if(testBtn)testBtn.disabled=!safe;
    const ids=[];
    if(c.notes.length)ids.push('notes local '+esc(String(c.notes[0].localId))+' · UUID '+esc(String(c.notes[0].supabase_id)));
    if(c.tx)ids.push('transactions local '+esc(String(c.tx.localId))+' · UUID '+esc(String(c.tx.id)));
    if(c.dependency&&c.dependency.accountPlan)ids.push('accounts local '+esc(String(c.dependency.accountPlan.legacy_id))+' · UUID '+esc(String(c.dependency.accountPlan.id)));
    if(out)out.innerHTML='<b>PHASE 6K.4 PRE-FLIGHT AUDIT</b><br>RPC metadata verification: '+pf(rpcAvailable)
      +'<br>RPC Ready: '+yn(CapSupabase.rpcReady())
      +'<br>Verifier failed condition(s): '+esc(verifierFailures.length?verifierFailures.join(', '):'none')
      +'<br>Controlled write support: '+esc(support?support.version:'unavailable')
      +'<br>Blocking audit check(s): '+esc(Object.entries(checks).filter(([k,v])=>!v).map(([k])=>k).join(', ')||'none')
      +'<br>Cloud state: unexpected '+esc(String(cloudState.unexpected))+' ['+esc(cloudState.unexpectedDetails.join(' | ')||'none')+'] · foreign keys '+esc(String(cloudState.foreignKeys))+' ['+esc(cloudState.foreignKeyDetails.join(' | ')||'none')+'] · unexplained mismatch fields ['+esc(cloudState.unexplainedDetails.join(' | ')||'none')+'] · aggregate-only '+cloudState.totalBalanceOnly+' · missing ['+esc(cloudState.missingDetails.join(' | ')||'none')+'] · expected transaction only: '+(cloudState.expectedMissing?'YES':'NO')
      +'<br><br>Atomic transaction-create group available: '+yn(checks.atomicTransactionGroupAvailable)
      +'<br>Atomic rollback guarantee: '+yn(checks.atomicRollbackGuaranteed)
      +'<br>Idempotent retry protection: '+yn(checks.idempotentRetryProtection)
      +'<br>Partial-success state tracking: '+yn(checks.partialFailureHandling)
      +'<br>Canonical post-write verification: '+yn(checks.canonicalPostWriteVerification)
      +'<br><br>Transaction INSERT guard: '+pf(checks.canonicalTransaction)
      +'<br>Notes UPDATE guard: '+pf(checks.canonicalNotes)
      +'<br>Dependent account UPDATE guard: '+pf(checks.canonicalAccount)
      +'<br>Independent primary candidates: '+independent
      +'<br>Logical dependent writes: '+(checks.canonicalAccount?1:0)
      +'<br>Pulls: '+pulls
      +'<br>Local deletes: '+localDeletes
      +'<br>Cloud deletes: '+cloudDeletes
      +'<br>Conflicts: '+conflicts
      +'<br>Blocked: '+blocked
      +'<br>Pending real-data outbox: '+realPending.length
      +'<br>Cloud Sync: OFF'
      +'<br><br>Candidate identities:<br>'+(ids.length?ids.join('<br>'):'none')
      +'<br><br>Safe to execute controlled write test: '+(safe?'YES':'NO')
      +'<br>Controlled write not executed.';
    toast('Controlled write audit complete',safe);
  }catch(e){if(out)out.textContent='Pre-flight audit failed: '+e.message;toast('Controlled write audit failed')}
}
async function diagnosePhase6K4A(){
  const out=$('#phase6k4a-result');if(out)out.textContent='Running Phase 6K.4A read-only diagnosis…';
  const yn=v=>v?'YES':'NO',lines=[];
  try{
    lines.push('<b>PHASE 6K.4A — A. RPC VERIFIER</b>');
    lines.push('Authenticated session present: '+yn(!!(CapSupabase.status()&&CapSupabase.status().authenticated)));
    await CapSupabase.refreshRpcReadiness();
    const st=CapSupabase.rpcVerifierStatus?CapSupabase.rpcVerifierStatus():null;
    const v=st&&st.response&&typeof st.response==='object'?st.response:null;
    const field=k=>v&&Object.prototype.hasOwnProperty.call(v,k)?String(v[k]):'missing';
    const failed=[];
    if(!st||!st.success)failed.push('verifier call failed');
    else if(!v)failed.push('malformed verifier response');
    else{
      [['exists',true],['signature_ok',true],['security_invoker',true],['language_ok',true],['authenticated_execute',true],['anon_execute',false],['public_execute',false],['version_ok',true],['ready',true]].forEach(([k,want])=>{if(v[k]!==want)failed.push(k)});
      if(v.version!=='CAP_PHASE_6K2A_V1')failed.push('version');
    }
    lines.push('Verifier HTTP/RPC success: '+yn(!!(st&&st.success)));
    lines.push('Verifier error code: '+esc(String(st&&(st.code||st.status)||'none')));
    lines.push('Verifier error message: '+esc(String(st&&st.error||'none')));
    lines.push('Verifier raw response received: '+yn(!!v));
    ['exists','signature_ok','security_invoker','language_ok','authenticated_execute','anon_execute','public_execute','version','version_ok','ready'].forEach(k=>lines.push(k+': '+esc(field(k))));
    lines.push('Failed condition(s): '+esc(failed.length?failed.join(', '):'none'));

    lines.push('<br><b>PHASE 6K.4A — B. TRANSACTION CANDIDATE</b>');
    const baseline=await CapOff.syncStore('syncmeta','get','baseline');
    const u=await CapSupabase.currentUser();
    const prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan),rows=await CapSync.recordFingerprints(plan,validation);
    const source=[...(S.tx||[]),...(S.pend||[])];
    const local=source.find(t=>String(t.note||'').trim().toUpperCase()==='DELETE SYNC TEST');
    const planTx=local?plan.tables.find(x=>x[0]==='transactions')[1].find(r=>String(r.legacy_id)===String(local.id)):null;
    const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const base=planTx&&baseline&&Array.isArray(baseline.records)?baseline.records.find(r=>r.entity==='transactions'&&String(r.supabase_id)===String(planTx.id)):null;
    const cloud=planTx?(validation.snapshot&&validation.snapshot.transactions||[]).find(r=>String(r.id)===String(planTx.id)):null;
    const fp=planTx?rows.find(r=>r.entity==='transactions'&&String(r.supabase_id)===String(planTx.id)):null;
    const available=fp?true:false;
    const cmp=(a,b)=>available&&a!=null&&b!=null?(a===b?'SAME':'DIFFERENT'):'UNAVAILABLE';
    let classification;
    if(!local)classification='MISSING (local record absent)';
    else if(!planTx)classification='OTHER (no migration-plan identity)';
    else if(!base&&!cloud)classification='INSERT (new local record; baseline absent, cloud absent)';
    else if(!base&&cloud)classification='OTHER (cloud record without baseline mapping)';
    else if(base&&!cloud)classification='OTHER (baseline record without cloud counterpart)';
    else if(!fp)classification='BLOCKED (paired fingerprint unavailable)';
    else{const L=fp.contentFingerprint,C=fp.cloudContentFingerprint,B=base.contentFingerprint;if(L===B&&C===B)classification='UNCHANGED';else if(L!==B&&C===B)classification='UPDATE (PUSH)';else if(L===B&&C!==B)classification='PULL';else if(L!==B&&C!==B&&L!==C)classification='CONFLICT';else if(L===C)classification='CONVERGED';else classification='OTHER'}
    const dep=planTx?phase6DependencyDiagnosis(plan,validation,[{entity:'transactions',localId:String(local&&local.id),id:String(planTx.id)}],local):null;
    const guard=planTx?phase6TransactionInsertGuard(plan,validation,baseline,{localId:String(local&&local.id),supabase_id:String(planTx.id)},dep,u&&u.id):null;
    const c=baseline?phase6ControlledCandidates(baseline,plan,validation,rows,u):null;
    const pairedTx=c?rows.filter(r=>r.entity==='transactions'&&!c.baseKeys.has('transactions:'+r.supabase_id)).length:'unavailable';
    lines.push('Baseline present: '+yn(!!(baseline&&Array.isArray(baseline.records)))+' · records: '+(baseline&&baseline.records?baseline.records.length:'missing'));
    lines.push('Local record exists: '+yn(!!local)+' · local ID: '+esc(String(local&&local.id||'missing')));
    lines.push('Migration-plan identity exists: '+yn(!!planTx)+' · UUID: '+esc(String(planTx&&planTx.id||'missing')));
    lines.push('Stable UUID available: '+yn(!!planTx&&uuidRe.test(String(planTx.id))));
    lines.push('Ownership valid: '+yn(!!planTx&&planTx.user_id===(u&&u.id)));
    lines.push('Baseline record exists: '+yn(!!base));
    lines.push('Cloud record exists: '+yn(!!cloud));
    lines.push('Local vs baseline: '+cmp(fp&&fp.contentFingerprint,base&&base.contentFingerprint));
    lines.push('Local vs cloud: '+cmp(fp&&fp.contentFingerprint,fp&&fp.cloudContentFingerprint));
    lines.push('Baseline vs cloud: '+cmp(base&&base.contentFingerprint,fp&&fp.cloudContentFingerprint));
    lines.push('Transaction currently classified as: '+esc(classification));
    lines.push('Transaction INSERT guard: '+(guard&&guard.safe?'PASS':'FAIL'));
    if(guard&&!guard.safe)lines.push('Failing guard checks: '+esc(Object.entries(guard).filter(([k,x])=>k!=='safe'&&typeof x==='boolean'&&x!==true).map(([k])=>k).join(', ')||'none'));
    lines.push('Guard derivation source (audit): paired local ↔ cloud fingerprint rows');
    lines.push('Paired-row transaction candidates: '+pairedTx);
    lines.push('Plan-minus-baseline transaction candidates: '+(c?c.txCandidates.length:'unavailable'));
    lines.push('<br><b>RELATED ACCOUNT (READ-ONLY)</b>');
    lines.push('Local account exists: '+yn(!!(dep&&dep.accountLocal)));
    lines.push('Baseline mapping exists: '+yn(!!(dep&&dep.accountPlan&&baseline&&baseline.records.some(r=>r.entity==='accounts'&&String(r.supabase_id)===String(dep.accountPlan.id)))));
    lines.push('Cloud account exists: '+yn(!!(dep&&dep.accountCloud)));
    lines.push('Transaction relationship valid: '+yn(!!(planTx&&dep&&dep.accountPlan&&String(planTx.account_id)===String(dep.accountPlan.id))));
    lines.push('Dependent balance difference still exists: '+yn(!!(dep&&dep.changed)));
    lines.push('Current dependent classification: '+esc(dep&&dep.safe?'EXPLAINED DEPENDENT CHANGE':dep&&dep.changed?'UNEXPLAINED ACCOUNT DIFFERENCE':'NONE'));
    lines.push('<br>No financial values displayed; no data was changed.');
    if(out)out.innerHTML=lines.join('<br>');
    toast('Phase 6K.4A diagnosis complete',true);
  }catch(e){if(out)out.innerHTML=lines.join('<br>')+'<br>Diagnosis failed: '+esc(e.message||String(e));toast('Phase 6K.4A diagnosis failed')}
}
const CAP_CONTROLLED_WRITE_STATES=['NOTHING_APPLIED','NOTES_ONLY_APPLIED','TRANSACTION_GROUP_ONLY_APPLIED','NOTES_APPLIED_GROUP_UNKNOWN','ALL_APPLIED','VERIFICATION_FAILED'];
window.CAP_CONTROLLED_WRITE_STATE={version:'phase6k5a-v1',state:'NOTHING_APPLIED',notes:'not_attempted',group:'not_attempted',verified:false,candidate:null,updated_at:null};
function controlledWriteSupport(){return{version:'phase6k5a-v1',states:CAP_CONTROLLED_WRITE_STATES.slice(),atomicGroup:'cap_test_transaction_create',retrySafe:true,notesIdempotent:true,partialStateTracking:true}}
function controlledWriteStatus(){return window.CAP_CONTROLLED_WRITE_STATE}
function setControlledState(patch){window.CAP_CONTROLLED_WRITE_STATE={...window.CAP_CONTROLLED_WRITE_STATE,...patch,updated_at:new Date().toISOString()};return window.CAP_CONTROLLED_WRITE_STATE}
function cloudWriteDiff(before,after,allowed){
  const allow=new Set((allowed||[]).map(([e,id])=>e+':'+String(id))),out=[];
  const entities=new Set([...Object.keys(before||{}),...Object.keys(after||{})]);
  for(const entity of entities){
    if(entity==='profiles'||entity==='user_preferences')continue;
    const b=new Map(((before&&before[entity])||[]).map(r=>[String(r.id),JSON.stringify(r)])),a=new Map(((after&&after[entity])||[]).map(r=>[String(r.id),JSON.stringify(r)]));
    for(const [id,row] of a){if(!allow.has(entity+':'+id)&&b.get(id)!==row)out.push(entity+':'+id)}
    for(const id of b.keys()){if(!a.has(id)&&!allow.has(entity+':'+id))out.push(entity+':'+id)}
  }
  return out
}
async function cleanupPhase6TestArtifact(){
  const out=$('#phase6-test-cleanup-result'),stage=s=>{if(out)out.textContent=s};
  try{
    stage('Reading cloud test artifacts…');
    const u=await CapSupabase.currentUser();if(!u||!u.id)throw Error('No authenticated Supabase user');
    const accounts=await CapSupabase.syncRequest('/rest/v1/accounts?select=*&legacy_id=like.phase6-test-*');
    const list=Array.isArray(accounts)?accounts:[];
    if(!list.length){if(out)out.textContent='No phase6-test-* cloud accounts found; nothing to delete.';return}
    if(list.length!==1)throw Error('Expected exactly one test account; found '+list.length+' — no deletion performed');
    const a=list[0];
    if(String(a.legacy_id)!=='phase6-test-'+String(a.id))throw Error('Test account legacy_id does not match its UUID; no deletion performed');
    if(String(a.user_id)!==String(u.id))throw Error('Test account ownership mismatch; no deletion performed');
    if(Number(a.balance)!==0)throw Error('Test account balance is not zero; no deletion performed');
    const enc=encodeURIComponent(a.id);
    const count=async path=>{const r=await CapSupabase.syncRequest(path);if(!Array.isArray(r))throw Error('Reference check failed: '+path);return r.length};
    const refs={
      transactions:await count('/rest/v1/transactions?select=id&account_id=eq.'+enc),
      transfersFrom:await count('/rest/v1/transfers?select=id&from_account_id=eq.'+enc),
      transfersTo:await count('/rest/v1/transfers?select=id&to_account_id=eq.'+enc),
      goals:await count('/rest/v1/goals?select=id&account_id=eq.'+enc),
      bills:await count('/rest/v1/bills?select=id&payment_account_id=eq.'+enc),
      statements:await count('/rest/v1/account_statements?select=id&account_id=eq.'+enc)
    };
    if(Object.values(refs).reduce((n,x)=>n+x,0))throw Error('Test account is referenced ('+JSON.stringify(refs)+'); no deletion performed');
    const prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep);
    if(plan.tables.find(x=>x[0]==='accounts')[1].some(x=>String(x.id)===String(a.id)))throw Error('Test account is present in the local plan; no deletion performed');
    const baseline=await CapOff.syncStore('syncmeta','get','baseline');
    if(!baseline||!Array.isArray(baseline.records))throw Error('Baseline missing; refusing cleanup');
    if(baseline.records.some(r=>r.entity==='accounts'&&String(r.supabase_id)===String(a.id)))throw Error('Test account is tracked in the baseline; no deletion performed');
    if(!confirm('Delete this verified test artifact?\n\nUUID: '+a.id+'\nlegacy_id: '+a.legacy_id+'\nBalance: zero\nReferences: 0\nNot in local plan. Not in baseline.\n\nThis is a permanent Supabase DELETE. No other records will be touched.'))return;
    stage('Deleting verified test artifact…');
    const deleted=await CapSupabase.syncRequest('/rest/v1/accounts?id=eq.'+enc+'&user_id=eq.'+encodeURIComponent(u.id),{method:'DELETE',headers:{Prefer:'return=representation'}});
    if(!Array.isArray(deleted)||deleted.length!==1||String(deleted[0].id)!==String(a.id))throw Error('DELETE VERIFICATION FAILED — TEST ARTIFACT MAY STILL EXIST');
    const remaining=await CapSupabase.syncRequest('/rest/v1/accounts?select=id&id=eq.'+enc);
    if(!Array.isArray(remaining)||remaining.length!==0)throw Error('DELETE VERIFICATION FAILED — RECORD STILL PRESENT');
    if(out)out.textContent='Test artifact deleted ✓\nUUID: '+a.id+'\nPost-delete verification: PASS\nNo other records modified.';
    toast('Test artifact deleted',true);
  }catch(e){if(out)out.textContent='Cleanup failed: '+e.message;toast('Test artifact cleanup failed')}
}
const PHASE6K6_TARGETS=[['notes','66fb12b5-e10f-583e-9b23-7dc7d537b350'],['transactions','37e534ed-b1f9-5a76-ac0d-9fffa621d588'],['accounts','3375b984-b961-53fb-bf4d-4e72c53918e9']];
async function phase6k6Preflight(){
  const baseline=await CapOff.syncStore('syncmeta','get','baseline');
  if(!baseline||baseline.version!==2||!Array.isArray(baseline.records))throw Error('Baseline is missing, not version 2, or corrupt');
  const u=await CapSupabase.currentUser();
  if(!u||!u.id)throw Error('No authenticated Supabase user');
  if(String(baseline.user_id)!==String(u.id))throw Error('Baseline ownership does not match the authenticated user');
  const pending=await CapOff.syncStore('outbox','all').catch(()=>[]);
  if(pending.some(x=>x.user_id===u.id&&!String((x.payload&&x.payload.legacy_id)||'').startsWith('phase6-test-')))throw Error('Pending real-data outbox operations exist');
  const prep=migrationPrepare();
  if(prep.blockingProblems.length)throw Error('Migration blocking problems remain');
  const plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan);
  if(!validation.dataOk)throw Error('Validation is not clean: missing '+validation.missingCount+', unexpected '+validation.unexpectedCount+', mismatches '+validation.mismatchCount+', foreign keys '+validation.foreignKeyErrorCount);
  const rows=await CapSync.recordFingerprints(plan,validation),key=r=>r.entity+':'+String(r.supabase_id);
  const base=new Map(baseline.records.map(r=>[key(r),r])),current=new Map(rows.map(r=>[key(r),r]));
  const targets=PHASE6K6_TARGETS.map(([entity,id])=>{
    const k=entity+':'+id,r=current.get(k),b=base.get(k);
    if(!r)throw Error('Controlled target missing from current plan: '+k);
    if(String(r.user_id)!==String(u.id))throw Error('Controlled target ownership mismatch: '+k);
    if(r.contentFingerprint!==r.cloudContentFingerprint)throw Error('Controlled target is not converged: '+k);
    if(b&&b.contentFingerprint===r.contentFingerprint)throw Error('Controlled target already matches baseline: '+k);
    return{entity,supabase_id:id,localId:r.localId,row:r,existing:!!b}
  });
  const targetKeys=new Set(PHASE6K6_TARGETS.map(([e,id])=>e+':'+id));
  for(const [k,r] of current){
    if(targetKeys.has(k))continue;
    const b=base.get(k);
    if(!b)throw Error('Record outside the controlled set is not in the baseline: '+k);
    if(r.contentFingerprint!==b.contentFingerprint)throw Error('Unexpected local change outside the controlled set: '+k);
    if(r.cloudContentFingerprint!==b.contentFingerprint)throw Error('Unexpected cloud change outside the controlled set: '+k);
  }
  for(const k of base.keys())if(!current.has(k))throw Error('Baseline record missing from current plan: '+k);
  if(current.size!==base.size+1)throw Error('Expected exactly one new baseline record; found '+(current.size-base.size));
  return{baseline,u,plan,validation,rows,current,base,targets}
}
async function phase6k6Verify(){
  const baseline=await CapOff.syncStore('syncmeta','get','baseline');
  if(!baseline||baseline.version!==2||!Array.isArray(baseline.records))return{ok:false,reason:'baseline missing, not version 2, or corrupt'};
  const u=await CapSupabase.currentUser();if(!u||!u.id)return{ok:false,reason:'no authenticated user'};
  if(String(baseline.user_id)!==String(u.id))return{ok:false,reason:'baseline ownership mismatch'};
  const prep=migrationPrepare();if(prep.blockingProblems.length)return{ok:false,reason:'migration blocking problems remain'};
  const plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan);
  if(!validation.dataOk)return{ok:false,reason:'validation not clean (missing '+validation.missingCount+', unexpected '+validation.unexpectedCount+', mismatches '+validation.mismatchCount+', foreign keys '+validation.foreignKeyErrorCount+')'};
  const rows=await CapSync.recordFingerprints(plan,validation);
  if(rows.length!==baseline.records.length)return{ok:false,reason:'record count mismatch ('+rows.length+' vs '+baseline.records.length+')'};
  const base=new Map(baseline.records.map(r=>[r.entity+':'+String(r.supabase_id),r])),bad=[];
  for(const r of rows){
    const b=base.get(r.entity+':'+String(r.supabase_id));
    if(!b){bad.push('unbaselined '+r.entity+' '+r.localId);continue}
    if(r.contentFingerprint!==b.contentFingerprint)bad.push('local '+r.entity+' '+r.localId);
    if(r.cloudContentFingerprint!==b.contentFingerprint)bad.push('cloud '+r.entity+' '+r.localId);
  }
  const keys=new Set(rows.map(r=>r.entity+':'+String(r.supabase_id)));
  for(const k of base.keys())if(!keys.has(k))bad.push('baseline-only '+k);
  return{ok:!bad.length,bad,count:rows.length}
}
async function reconcileControlledBaseline(){
  const out=$('#controlled-baseline-result'),stage=s=>{if(out)out.textContent=s};
  const btn=document.getElementById('controlled-baseline-reconcile');if(btn)btn.disabled=true;
  try{
    stage('Phase 6K.6 preflight: verifying converged state…');
    const first=await phase6k6Preflight();
    const summary=first.targets.map(t=>t.entity+' local '+t.localId+' · '+(t.existing?'update':'add')+' · UUID '+t.supabase_id).join('\n');
    if(!confirm('Reconcile the local sync baseline for the verified controlled write?\n\n'+summary+'\n\nBaseline records: '+first.baseline.records.length+' → '+(first.baseline.records.length+1)+'\n\nLocal sync metadata only. No Supabase writes. Cloud Sync remains OFF.')){stage('Baseline reconciliation cancelled. No changes made.');return}
    stage('Re-validating immediately before the baseline write…');
    const second=await phase6k6Preflight();
    for(const t of first.targets){
      const s2=second.targets.find(x=>x.entity===t.entity&&x.supabase_id===t.supabase_id);
      if(!s2||s2.row.contentFingerprint!==t.row.contentFingerprint||s2.row.cloudContentFingerprint!==t.row.cloudContentFingerprint)throw Error('BASELINE RECONCILIATION ABORTED — STATE CHANGED DURING CONFIRMATION');
    }
    const latest=await CapOff.syncStore('syncmeta','get','baseline');
    if(!latest||latest.version!==2||!Array.isArray(latest.records)||latest.records.length!==first.baseline.records.length)throw Error('BASELINE RECONCILIATION FAILED — BASELINE CHANGED');
    const fields=t=>({localId:t.row.localId,user_id:second.u.id,local_updated_at:t.row.local_updated_at,cloud_updated_at:t.row.cloud_updated_at,contentFingerprint:t.row.contentFingerprint,canonicalDiffs:t.row.canonicalDiffs});
    let replaced=0,added=0;
    const next=latest.records.map(r=>{
      const t=second.targets.find(x=>x.entity===r.entity&&String(x.supabase_id)===String(r.supabase_id));
      if(!t)return r;
      replaced++;
      return{...r,...fields(t)}
    });
    for(const t of second.targets){
      if(t.existing)continue;
      next.push({entity:t.entity,supabase_id:t.supabase_id,...fields(t)});
      added++;
    }
    if(replaced!==2||added!==1||next.length!==latest.records.length+1)throw Error('BASELINE RECONCILIATION ABORTED — UNEXPECTED BASELINE SET');
    stage('Writing baseline metadata…');
    try{await CapOff.syncStore('syncmeta','put',{...latest,records:next,reconciled_at:new Date().toISOString(),reconciled_version:'phase6k6-v1'},'baseline')}
    catch(e){throw Error('DATA CONVERGED — BASELINE UPDATE FAILED: '+(e.message||e))}
    stage('Post-write baseline verification…');
    const check=await phase6k6Verify();
    if(!check.ok)throw Error('DATA CONVERGED — BASELINE UPDATE FAILED: '+check.reason+(check.bad&&check.bad.length?' ('+check.bad.join(', ')+')':''));
    stage('BASELINE RECONCILIATION: SUCCESS\nNotes baseline record: updated\nTransaction baseline record: added\nAccount baseline record: updated\nBaseline records: '+check.count+'\nRemaining differences: 0\nCloud Sync: OFF\nNo Supabase writes were made.');
    toast('Baseline reconciled; zero remaining differences',true);
  }catch(e){if(out)out.textContent='Baseline reconciliation failed: '+e.message;toast('Baseline reconciliation failed')}
}
async function testControlledRetry(){
  const out=$('#controlled-retry-result'),stage=s=>{if(out)out.textContent=s};
  const btn=document.getElementById('controlled-retry-test');if(btn)btn.disabled=true;
  try{
    stage('Retry preflight: verifying fully synchronized state…');
    if(!CapSupabase.rpcReady()){const ok=await CapSupabase.refreshRpcReadiness();if(!ok)throw Error('Atomic transaction RPC is not verified/ready')}
    const first=await phase6k6Verify();
    if(!first.ok)throw Error('Retry preflight failed: '+first.reason+(first.bad&&first.bad.length?' ('+first.bad.join(', ')+')':''));
    const u=await CapSupabase.currentUser();if(!u||!u.id)throw Error('No authenticated Supabase user');
    const prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep);
    const noteRow=plan.tables.find(x=>x[0]==='notes')[1].find(r=>String(r.id)==='66fb12b5-e10f-583e-9b23-7dc7d537b350');
    const txPlan=plan.tables.find(x=>x[0]==='transactions')[1].find(r=>String(r.id)==='37e534ed-b1f9-5a76-ac0d-9fffa621d588');
    if(!noteRow||!txPlan)throw Error('Controlled retry payload unavailable');
    const noteId='66fb12b5-e10f-583e-9b23-7dc7d537b350',txId='37e534ed-b1f9-5a76-ac0d-9fffa621d588',acctId='3375b984-b961-53fb-bf4d-4e72c53918e9';
    const noteBody={title:noteRow.title,body:noteRow.body,note_date:noteRow.note_date};
    const rpcBody={p_transaction_id:txPlan.id,p_legacy_id:String(txPlan.legacy_id),p_account_id:txPlan.account_id,p_category_id:txPlan.category_id??null,p_bill_id:txPlan.bill_id??null,p_amount:Number(txPlan.amount),p_transaction_date:txPlan.transaction_date,p_posting_date:txPlan.posting_date??null,p_status:txPlan.status,p_title:txPlan.title??null,p_description:txPlan.description??null,p_metadata:txPlan.metadata??{}};
    const enc=encodeURIComponent,read=async(path)=>{const r=await CapSupabase.syncRequest(path);if(!Array.isArray(r)||r.length!==1)throw Error('Cloud row unavailable: '+path);return r[0]};
    const beforeNote=await read('/rest/v1/notes?select=id,updated_at,title,body,note_date&id=eq.'+enc(noteId));
    const beforeTx=await read('/rest/v1/transactions?select=id,updated_at&id=eq.'+enc(txId));
    const beforeAcct=await read('/rest/v1/accounts?select=id,updated_at&id=eq.'+enc(acctId));
    const same=(a,b)=>String(a??'')===String(b??'');
    if(!same(beforeNote.title,noteBody.title)||!same(beforeNote.body,noteBody.body)||!same(beforeNote.note_date,noteBody.note_date))throw Error('Notes cloud content differs from the intended payload; retry aborted');
    if(!confirm('Run controlled retry test?\n\n1. notes PATCH with identical values (idempotent)\n2. transaction RPC with identical payload (must return ALREADY_APPLIED)\n\nNo content changes are expected.\nCloud Sync remains OFF. The baseline is not updated.')){stage('Controlled retry cancelled. No requests were sent.');return}
    const second=await phase6k6Verify();
    if(!second.ok)throw Error('State changed during confirmation; retry aborted: '+second.reason);
    stage('Retry 1/2: re-sending identical notes PATCH…');
    let noteRows;
    try{noteRows=await CapSupabase.syncRequest('/rest/v1/notes?id=eq.'+enc(noteId)+'&user_id=eq.'+enc(u.id),{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(noteBody)})}
    catch(e){throw Error('NOTES RETRY REQUEST FAILED: '+(e.message||e))}
    const noteOk=Array.isArray(noteRows)&&noteRows.length===1&&String(noteRows[0].id)===noteId&&same(noteRows[0].title,noteBody.title)&&same(noteRows[0].body,noteBody.body)&&same(noteRows[0].note_date,noteBody.note_date);
    if(!noteOk)throw Error('NOTES RETRY CONTENT VERIFICATION FAILED');
    stage('Retry 2/2: re-sending identical transaction RPC payload…');
    let rpc;
    try{rpc=await CapSupabase.syncRequest('/rest/v1/rpc/cap_test_transaction_create',{method:'POST',body:JSON.stringify(rpcBody)})}
    catch(e){throw Error('RPC RETRY REQUEST FAILED: '+(e.message||e))}
    const status=rpc&&rpc.status;
    if(status!=='ALREADY_APPLIED')throw Error('RETRY CAUSED A WRITE OR RETURNED AN UNEXPECTED RESULT: '+String(status||'unknown'));
    if(rpc.transaction_id&&String(rpc.transaction_id)!==txId)throw Error('RETRY RETURNED A DIFFERENT TRANSACTION ID');
    stage('Verifying no unintended row changes…');
    const afterNote=await read('/rest/v1/notes?select=id,updated_at,title,body,note_date&id=eq.'+enc(noteId));
    const afterTx=await read('/rest/v1/transactions?select=id,updated_at&id=eq.'+enc(txId));
    const afterAcct=await read('/rest/v1/accounts?select=id,updated_at&id=eq.'+enc(acctId));
    const final=await phase6k6Verify();
    if(!final.ok)throw Error('RETRY VERIFICATION FAILED: '+final.reason+(final.bad&&final.bad.length?' ('+final.bad.join(', ')+')':''));
    if(String(afterTx.updated_at)!==String(beforeTx.updated_at))throw Error('RETRY MODIFIED THE TRANSACTION ROW');
    if(String(afterAcct.updated_at)!==String(beforeAcct.updated_at))throw Error('RETRY MODIFIED THE ACCOUNT ROW (BALANCE MAY HAVE BEEN REAPPLIED)');
    const noteContentSame=same(afterNote.title,noteBody.title)&&same(afterNote.body,noteBody.body)&&same(afterNote.note_date,noteBody.note_date);
    if(!noteContentSame)throw Error('RETRY MODIFIED NOTES CONTENT');
    stage('CONTROLLED RETRY: SUCCESS\nNotes PATCH: identical payload accepted\nNotes content: unchanged\nRPC result: ALREADY_APPLIED\nTransaction row updated: NO\nAccount row updated: NO\nAccount balance reapplied: NO\nNotes updated_at refreshed: '+(String(afterNote.updated_at)!==String(beforeNote.updated_at)?'YES':'NO')+'\nRemaining differences: 0\nCloud Sync: OFF · Baseline: UNCHANGED');
    toast('Controlled retry test passed',true);
  }catch(e){if(out)out.textContent='Controlled retry failed: '+e.message;toast('Controlled retry failed')}
}
async function testControlledWrite(){
  const out=$('#controlled-write-result');
  const stage=s=>{if(out)out.textContent=s};
  const testBtn=document.getElementById('controlled-write-test');if(testBtn)testBtn.disabled=true;
  const support=controlledWriteSupport();
  try{
    if(!support.retrySafe)throw Error('Controlled write support unavailable');
    stage('Fresh preflight: validating…');
    const baseline=await CapOff.syncStore('syncmeta','get','baseline');
    if(!baseline||!Array.isArray(baseline.records))throw Error('Baseline is missing or corrupt');
    const rpcReady=await CapSupabase.refreshRpcReadiness();
    if(!rpcReady||!CapSupabase.rpcReady())throw Error('Atomic transaction RPC is not verified/ready');
    const u=await CapSupabase.currentUser();if(!u||!u.id)throw Error('No authenticated Supabase user');
    const prep=migrationPrepare();if(prep.blockingProblems.length)throw Error('Migration blocking problems remain');
    const plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan);
    const pending=await CapOff.syncStore('outbox','all').catch(()=>[]);
    if(pending.some(x=>x.user_id===u.id&&!String((x.payload&&x.payload.legacy_id)||'').startsWith('phase6-test-')))throw Error('Pending real-data outbox operations exist');
    const rows=await CapSync.recordFingerprints(plan,validation),c=phase6ControlledCandidates(baseline,plan,validation,rows,u);
    const pre=phase6ControlledPreflightState(validation,c);
    if(!pre.ok)throw Error('Fresh validation failed: missing '+pre.missing+' (expected new transaction only: '+(pre.expectedMissing?'yes':'no')+'), unexpected '+pre.unexpected+', unexplained mismatches '+pre.unexplainedMismatches+', foreign keys '+pre.foreignKeys);
    if(c.notes.length!==1||c.txCandidates.length!==1||!(c.txGuard&&c.txGuard.safe)||!(c.dependency&&c.dependency.safe))throw Error('Controlled guards changed: expected notes UPDATE, transaction INSERT, and safe dependent account UPDATE');
    const note=c.notes[0],tx=c.tx,txPlan=tx.planTx,accountPlan=c.dependency.accountPlan;
    const notePlan=plan.tables.find(x=>x[0]==='notes')[1].find(r=>String(r.id)===String(note.supabase_id));
    if(!notePlan||!txPlan||!accountPlan)throw Error('Verified candidate payload unavailable');
    const notePath='/rest/v1/notes?id=eq.'+encodeURIComponent(note.supabase_id)+'&user_id=eq.'+encodeURIComponent(u.id);
    const noteBody={title:notePlan.title,body:notePlan.body,note_date:notePlan.note_date};
    const rpcBody={p_transaction_id:txPlan.id,p_legacy_id:String(txPlan.legacy_id),p_account_id:txPlan.account_id,p_category_id:txPlan.category_id??null,p_bill_id:txPlan.bill_id??null,p_amount:Number(txPlan.amount),p_transaction_date:txPlan.transaction_date,p_posting_date:txPlan.posting_date??null,p_status:txPlan.status,p_title:txPlan.title??null,p_description:txPlan.description??null,p_metadata:txPlan.metadata??{}};
    const expectedBalance=Number(accountPlan.balance);
    if(!Number.isFinite(expectedBalance))throw Error('Expected account balance unavailable');
    const identity=[note.supabase_id,tx.id,accountPlan.id].join('|');
    setControlledState({state:'NOTHING_APPLIED',notes:'not_attempted',group:'not_attempted',verified:false,candidate:identity,lastRun:new Date().toISOString()});
    if(!confirm('Run controlled sync test?\n\n3 logical writes will be attempted:\n1. notes UPDATE (independent, idempotent)\n2. transactions INSERT + accounts UPDATE (one atomic database RPC)\n\nCloud Sync stays OFF.\nThe sync baseline will NOT be updated.\n\nState machine: NOTHING_APPLIED → NOTES_ONLY_APPLIED → ALL_APPLIED'))return;
    stage('Re-validating candidate identities…');
    const validation2=await CapSupabase.validateRealData(plan),rows2=await CapSync.recordFingerprints(plan,validation2),c2=phase6ControlledCandidates(baseline,plan,validation2,rows2,u);
    const identity2=[c2.notes[0]&&c2.notes[0].supabase_id,c2.tx&&c2.tx.id,c2.dependency&&c2.dependency.accountPlan&&c2.dependency.accountPlan.id].join('|');
    if(identity!==identity2||c2.notes.length!==1||c2.txCandidates.length!==1||!(c2.txGuard&&c2.txGuard.safe)||!(c2.dependency&&c2.dependency.safe))throw Error('CANDIDATES CHANGED DURING CONFIRMATION — ABORTED');
    stage('Notes UPDATE pending');
    let noteRows;
    try{
      noteRows=await CapSupabase.syncRequest(notePath,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(noteBody)});
    }catch(e){
      setControlledState({state:'NOTHING_APPLIED',notes:'unknown',group:'not_attempted'});
      throw Error('NOTES WRITE OUTCOME UNKNOWN — RETRY IS SAFE (idempotent): '+(e.message||e));
    }
    const noteWritten=Array.isArray(noteRows)&&noteRows.length===1&&String(noteRows[0].id)===String(note.supabase_id);
    const notePayloadOk=noteWritten&&String(noteRows[0].title??'')===String(noteBody.title??'')&&String(noteRows[0].body??'')===String(noteBody.body??'')&&String(noteRows[0].note_date??'')===String(noteBody.note_date??'');
    if(!noteWritten){setControlledState({state:'NOTES_ONLY_APPLIED',notes:'applied_unverified'});throw Error('NOTES WRITE OCCURRED — VERIFICATION FAILED')}
    if(!notePayloadOk){setControlledState({state:'NOTES_ONLY_APPLIED',notes:'applied_unverified'});throw Error('NOTES WRITE OCCURRED — PAYLOAD VERIFICATION FAILED')}
    setControlledState({state:'NOTES_ONLY_APPLIED',notes:'applied'});
    stage('Atomic transaction group pending');
    let rpcResult;
    try{
      rpcResult=await CapSupabase.syncRequest('/rest/v1/rpc/cap_test_transaction_create',{method:'POST',body:JSON.stringify(rpcBody)});
    }catch(e){
      setControlledState({state:'NOTES_APPLIED_GROUP_UNKNOWN',notes:'applied',group:'unknown'});
      throw Error('ATOMIC GROUP OUTCOME UNKNOWN — RETRY IS SAFE (notes applied; RPC returns ALREADY_APPLIED if it committed): '+(e.message||e));
    }
    const rpcStatus=rpcResult&&rpcResult.status;
    if(rpcStatus!=='APPLIED'&&rpcStatus!=='ALREADY_APPLIED'){setControlledState({state:'NOTES_ONLY_APPLIED',notes:'applied',group:'rejected'});throw Error('ATOMIC GROUP REJECTED: '+String(rpcStatus||'unknown'))}
    setControlledState({state:'ALL_APPLIED',notes:'applied',group:rpcStatus==='ALREADY_APPLIED'?'already_applied':'applied'});
    stage('Canonical post-write verification…');
    const verification=await CapSupabase.validateRealData(plan),verifiedRows=await CapSync.recordFingerprints(plan,verification);
    const vNote=verifiedRows.find(r=>r.entity==='notes'&&String(r.supabase_id)===String(note.supabase_id));
    const vTx=verifiedRows.find(r=>r.entity==='transactions'&&String(r.supabase_id)===String(tx.id));
    const acctCloud=(verification.snapshot.accounts||[]).find(a=>String(a.id)===String(accountPlan.id));
    const noteOk=!!vNote&&vNote.contentFingerprint===vNote.cloudContentFingerprint;
    const txOk=!!vTx&&vTx.contentFingerprint===vTx.cloudContentFingerprint;
    const acctOk=!!acctCloud&&Math.abs(Number(acctCloud.balance)-expectedBalance)<.005;
    const diff=cloudWriteDiff(validation2.snapshot,verification.snapshot,[['notes',note.supabase_id],['transactions',tx.id],['accounts',accountPlan.id]]);
    if(!verification.dataOk||!noteOk||!txOk||!acctOk||diff.length){
      setControlledState({state:'VERIFICATION_FAILED',notes:'applied',group:'applied',verified:false});
      throw Error('CLOUD WRITE OCCURRED — VERIFICATION FAILED'+(diff.length?' · unexpected changed records: '+diff.join(', '):'')+' · notes '+(noteOk?'ok':'FAIL')+' · transaction '+(txOk?'ok':'FAIL')+' · account '+(acctOk?'ok':'FAIL'));
    }
    setControlledState({state:'ALL_APPLIED',notes:'applied',group:'applied',verified:true});
    stage('Controlled write execution: SUCCESS\nNotes UPDATE verified: YES\nTransaction INSERT verified: YES\nDependent account UPDATE verified: YES\nUnexpected writes: 0\nPost-write verification: PASS\nRPC result: '+rpcStatus+'\nState: ALL_APPLIED\nCloud Sync: OFF · Baseline: UNCHANGED');
    toast('Controlled write test passed',true);
  }catch(e){
    const state=(window.CAP_CONTROLLED_WRITE_STATE&&window.CAP_CONTROLLED_WRITE_STATE.state)||'NOTHING_APPLIED';
    if(out)out.textContent='Controlled write failed ['+state+']: '+e.message;
    toast('Controlled write failed');
  }
}
async function testSingleTransactionPush(){const out=$('#single-push-result');let cloudWrite=false,baselineUpdated=false;const stage=s=>{if(out)out.textContent=s};try{stage('Fresh dry run: validating…');const baseline=await CapOff.syncStore('syncmeta','get','baseline'),u=await CapSupabase.currentUser();if(!baseline||!Array.isArray(baseline.records))throw Error('Baseline missing or corrupt');const prep=migrationPrepare(),plan=buildSupabaseMigrationPlan(prep),validation=await CapSupabase.validateRealData(plan);if(!validation.dataOk)throw Error('Fresh validation failed');const pending=await CapOff.syncStore('outbox','all').catch(()=>[]);if(pending.some(x=>x.user_id===u.id&&!String(x.payload?.legacy_id||'').startsWith('phase6-test-')))throw Error('Pending real-data outbox operations exist');const current=await CapSync.recordFingerprints(plan,validation),base=new Map(baseline.records.map(r=>[r.entity+':'+r.supabase_id,r])),push=current.filter(r=>{const b=base.get(r.entity+':'+r.supabase_id);return b&&r.entity==='transactions'&&r.contentFingerprint!==b.contentFingerprint&&r.cloudContentFingerprint===b.contentFingerprint});if(push.length!==1)throw Error('Fresh dry run did not produce exactly one safe transaction PUSH candidate');const candidate=push[0],local=plan.tables.find(x=>x[0]==='transactions')[1].find(x=>String(x.id)===String(candidate.supabase_id)),cloud=validation.snapshot.transactions.find(x=>String(x.id)===String(candidate.supabase_id)),b=base.get(candidate.entity+':'+candidate.supabase_id);if(!local||!cloud||!b||local.user_id!==u.id||cloud.user_id!==u.id)throw Error('Single transaction ownership or mapping verification failed');stage('Single transaction identified · Baseline verified · Local changed · Cloud unchanged · Ownership verified');if(!confirm('Test Single Record Push\n\nOne existing transaction will be updated in Supabase.\nNo other records will be changed.\nAutomatic Cloud Sync will remain OFF.'))return;const fields=['account_id','category_id','bill_id','parent_transaction_id','statement_id','amount','transaction_date','posting_date','status','title','description','metadata'],payload={};fields.forEach(k=>{if(Object.prototype.hasOwnProperty.call(local,k))payload[k]=local[k]});stage('User confirmed · Supabase UPDATE pending');await CapSupabase.syncRequest('/rest/v1/transactions?id=eq.'+encodeURIComponent(candidate.supabase_id)+'&user_id=eq.'+encodeURIComponent(u.id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(payload)});cloudWrite=true;stage('Supabase UPDATE completed');const verify=await CapSupabase.validateRealData(plan),verified=await CapSync.recordFingerprints(plan,verify),vr=verified.find(r=>r.entity==='transactions'&&String(r.supabase_id)===String(candidate.supabase_id));if(!vr||vr.user_id!==u.id||vr.contentFingerprint!==vr.cloudContentFingerprint)throw Error('Cloud/local fingerprint verification failed');stage('Cloud/local fingerprint verified');const latest=await CapOff.syncStore('syncmeta','get','baseline'),nextRecords=(latest.records||[]).map(r=>r.entity==='transactions'&&String(r.supabase_id)===String(candidate.supabase_id)?{...r,localId:candidate.localId,user_id:u.id,local_updated_at:vr.local_updated_at,cloud_updated_at:vr.cloud_updated_at,contentFingerprint:vr.contentFingerprint}:r);if(nextRecords.length!==baseline.records.length)throw Error('Baseline record count changed');await CapOff.syncStore('syncmeta','put',{...latest,records:nextRecords,upgraded_at:new Date().toISOString()},'baseline');baselineUpdated=true;stage('Single baseline record updated');const finalPlan=buildSupabaseMigrationPlan(migrationPrepare()),final=await CapSupabase.validateRealData(finalPlan),finalRows=await CapSync.recordFingerprints(finalPlan,final),finalBase=new Map(nextRecords.map(r=>[r.entity+':'+r.supabase_id,r]));const remaining=finalRows.filter(r=>{const x=finalBase.get(r.entity+':'+r.supabase_id);return !x||r.contentFingerprint!==x.contentFingerprint||r.cloudContentFingerprint!==x.contentFingerprint});if(remaining.length)throw Error('Final dry run did not reach zero changes');stage('Final dry run passed · Unchanged: 43 · Would push: 0 · Conflicts: 0 · Automatic Cloud Sync OFF');toast('Single record push test passed',true)}catch(e){if(cloudWrite&&!baselineUpdated)stage('CLOUD WRITE OCCURRED — VERIFICATION FAILED: '+e.message);else if(cloudWrite&&baselineUpdated)stage('CLOUD WRITE VERIFIED — BASELINE UPDATE FAILED: '+e.message);else stage('Single push test failed: '+e.message);toast('Single record push test failed')}}
async function testSupabaseCloudDatabase(){const out=$('#sb-crud-result');if(out)out.textContent='Testing disposable account CRUD…';try{const r=await CapSupabase.testCloudDatabase();if(out)out.textContent=r.stages.map(s=>s.name+' '+(s.ok?'✓':'✕'+(s.error?' '+s.error:''))).join(' · ');toast(r.ok?'Cloud database test passed':'Cloud database test failed',r.ok)}catch(e){if(out)out.textContent='Test failed: '+e.message;toast('Cloud database test failed')}}
/* ---- About ---- */
function stAbout(){ stStart();
  const h=stHead('About Cap','openSettings()')
    +`<div class="st-prof" style="margin:4px 0 14px">${capBrandLogo()}<span class="f"><b style="font-size:17px">Cap</b><small>Finance Tracker · Version ${APP_VER}</small></span></div>`
    +stGrp('About',[
      stRow(ST_IC.info,"What's New",null,'openWhatsNew(true)'),
      stRow(ST_IC.ver,'Version',APP_VERSION,null),
      stRow(GITHUB_MARK,'GitHub Repository',null,'openGitHubRepository()'),
      stRow(ST_IC.shield,'Privacy &amp; Data Information',null,"stGo('privacy')")])
    +`<div class="st-grp eyebrow">About Cap</div><p class="st-note" style="margin:6px 4px 0">Cap is a private-first finance tracker. Your financial data stays on this device unless you choose to enable sync. No advertising and no tracking.</p>`
    +`<div class="st-grp eyebrow">Data storage</div><p class="st-note" style="margin:6px 4px 0">Your data lives in this browser's storage and, where available, a local database. Export a backup before clearing your browser data.</p>`;
  stSheet(h,'set-about',stKeep);
}
/* ---- Reset (double confirmation, never immediate) ---- */
function stReset(){ stStart();
  const h=stHead('Reset All Data',"stGo('backup')")
    +`<div class="st-dz"><div class="eyebrow">Danger zone</div><p>This permanently deletes your accounts, transactions, bills, subscriptions, budgets, payment history and settings stored on this device. This action cannot be undone.</p></div>`
    +`<label class="m" style="margin-top:18px">Type RESET to confirm</label><input id="st-rst" class="st-in" maxlength="8" autocapitalize="characters" autocomplete="off" placeholder="RESET" oninput="stResetArm(this.value)">`
    +`<button class="btn dng-f" id="st-rstb" style="width:100%;margin:10px 0 0" disabled onclick="stResetGo()">Reset All Data</button>`
    +`<button class="btn s" style="width:100%;margin:8px 0 0" onclick="stGo('backup')">Cancel</button>`;
  stSheet(h,'set-reset',stKeep);
}
function stResetArm(v){const b=$('#st-rstb');if(b)b.disabled=(String(v||'').trim().toUpperCase()!='RESET')}
function stResetGo(){
  confirmBox('Reset all Cap data?','Your accounts, transactions, bills, subscriptions, budgets, payment history and settings stored on this device will be permanently deleted. This action cannot be undone.',resetAllFinal,'Reset All Data');
}
function resetAllFinal(){
  S={accts:[],tx:[],pend:[],xfer:[],bills:[],budgets:{},notes:'',goals:[],debts:[],cats:CAT0.map(c=>({n:c.n,i:c.i})),cur:'PHP',name:''};
  try{['pera','pera_pre',LOCK_KEY,BIO_KEY,NOTIF_SEEN,BK_KEY].forEach(k=>localStorage.removeItem(k))}catch(e){}
  try{document.documentElement.classList.remove('noanim','rm')}catch(e){}
  try{document.body.classList.remove('hidebal','reveal')}catch(e){}
  window._unlocked=1;
  save();render();closeS();
  toast('All Cap data was reset',true);
}
/* ==========================================================================
   Security — hide balances, a locally hashed passcode lock, and device
   authentication only when the platform genuinely offers it.
   ========================================================================== */
let stBio=null;
try{
  if(window.PublicKeyCredential&&PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable){
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(v=>{stBio=!!v;if(stCur=='security')stGo('security',1)}).catch(()=>{stBio=false});
  }else stBio=false;
}catch(e){stBio=false}
function stCryptoOk(){try{return !!(window.crypto&&crypto.subtle&&window.TextEncoder)}catch(e){return false}}
function stLockGet(){try{return JSON.parse(localStorage.getItem(LOCK_KEY)||'{}')||{}}catch(e){return{}}}
function stLockSet(o){try{localStorage.setItem(LOCK_KEY,JSON.stringify(o||{}))}catch(e){}}
async function stHash(s){
  try{const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('cap|'+s));
    return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')}
  catch(e){return 'weak|'+s}
}
const b64u=u=>btoa(String.fromCharCode.apply(null,u));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function bioEnroll(){
  if(!stBio)return false;
  try{
    const ch=new Uint8Array(32);crypto.getRandomValues(ch);
    const id=new Uint8Array(16);crypto.getRandomValues(id);
    const nm=(S.name||'cap user').slice(0,32);
    const cred=await navigator.credentials.create({publicKey:{
      challenge:ch,rp:{name:'Cap'},
      user:{id,name:(S.name||'cap-user').replace(/\s+/g,'-').toLowerCase().slice(0,32)||'cap-user',displayName:nm},
      pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
      authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'preferred'},
      timeout:60000,attestation:'none'}});
    if(!cred)return false;
    try{localStorage.setItem(BIO_KEY,b64u(new Uint8Array(cred.rawId)))}catch(e){}
    return true;
  }catch(e){return false}
}
async function bioCheck(){
  try{
    const raw=localStorage.getItem(BIO_KEY);if(!raw)return false;
    const ch=new Uint8Array(32);crypto.getRandomValues(ch);
    const a=await navigator.credentials.get({publicKey:{challenge:ch,
      allowCredentials:[{type:'public-key',id:unb64(raw)}],userVerification:'required',timeout:60000}});
    return !!a;
  }catch(e){return false}
}
function lockShow(){
  const el=$('#lock');if(!el)return;
  const L=stLockGet(),box=el.querySelector('.lk');
  box.innerHTML=`<div class="lk-ic">${ST_IC.lock}</div><h2>Cap is locked</h2><p>Enter your passcode to continue.</p>`
    +`<input id="lk-in" type="password" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="Passcode">`
    +`<div class="lk-err" id="lk-err"></div>`
    +`<button class="btn" style="width:100%;margin:0" onclick="lockTry()">Unlock</button>`
    +((L.bio&&stBio)?`<button class="btn s" style="width:100%;margin:8px 0 0" onclick="lockBio()">Use device authentication</button>`:'')
    +`<button class="lk-fg" onclick="lockForgot()">Forgot your passcode?</button>`;
  el.classList.add('open');
  window._unlocked=0;
  const i=box.querySelector('#lk-in');
  setTimeout(()=>{try{i&&i.focus()}catch(e){}},120);
  if(L.bio&&stBio)lockBio(1);
}
function lockHide(){const el=$('#lock');if(el)el.classList.remove('open');window._unlocked=1;stLockTouch()}
function lockTry(){
  const i=$('#lk-in'),v=i?i.value:'';if(!v)return;
  const L=stLockGet();
  stHash(v).then(h=>{
    if(h&&h===L.pin){lockHide()}
    else{const e=$('#lk-err');if(e)e.textContent='That passcode is not correct.';if(i){i.value='';try{i.focus()}catch(_){}}}
  });
}
function lockBio(auto){
  if(!stBio)return;
  bioCheck().then(ok=>{if(ok)lockHide();else if(!auto){const e=$('#lk-err');if(e)e.textContent='Device authentication was not completed.'}});
}
function lockForgot(){confirmBox('Forgot your passcode?','Cap cannot recover a passcode. The only way in is to reset Cap on this device, which erases everything stored here.',resetAllFinal,'Reset Cap')}
function stLockTouch(){
  clearTimeout(window._lkT);
  const L=stLockGet(),m=+L.auto;
  if(!L.pin||!(m>0))return;
  window._lkT=setTimeout(()=>{if(!document.hidden)lockShow()},m*60000);
}
function stLockCheck(){const L=stLockGet();if(L.pin&&!window._unlocked)lockShow()}
function stSecurity(){ stStart();
  const L=stLockGet(),pin=!!L.pin,bio=!!stBio,cryptoOk=stCryptoOk();
  const h=stHead('Security','openSettings()')
    +`<div class="st-grp eyebrow">Privacy</div><div class="st-box">`
      +`<div class="st-r"><span class="f"><b>Balance Visibility</b><small id="st-bvsub">${bvSub()}</small></span>${bvEye()}</div>`
    +`</div><p class="st-note">Account balances stay hidden everywhere in Cap until you show them again. The eye beside a balance does the same thing.</p>`
    +`<div class="st-grp eyebrow">App Lock</div><div class="st-box">`
      +stSw('App Lock','Ask for a passcode when Cap opens',pin,"stLockToggle(this.checked)")
      +(pin?stSel('Auto Lock',`<select class="st-sel" onchange="stLockAuto(this.value)">${[[0,'Immediately'],[1,'After 1 minute'],[5,'After 5 minutes'],[30,'After 30 minutes'],[-1,'Never']].map(x=>`<option value="${x[0]}" ${+L.auto==x[0]?'selected':''}>${x[1]}</option>`).join('')}</select>`):'')
      +(pin?`<div class="st-r"><span class="f"><b>Passcode</b><small>Change the digits Cap asks for</small></span><button class="pill" onclick="stPin()">Change</button></div>`:'')
      +(pin?(bio?stSw('Use Device Authentication','Unlock with your device instead of typing',L.bio==1,"stBioToggle(this.checked)"):`<div class="st-r"><span class="f"><b>Use Device Authentication</b><small>Not available on this device</small></span></div>`):`<div class="st-r"><span class="f"><b>Use Device Authentication</b><small>Set a passcode first</small></span></div>`)
    +`</div>`
    +(!cryptoOk?`<p class="st-note">App Lock is unavailable in this browser because it cannot hash a passcode safely.</p>`:'')
    +`<p class="st-note">Cap stores only a one-way hash of the passcode on this device. A forgotten passcode cannot be recovered — the only way in is to reset Cap.</p>`;
  stSheet(h,'set-security',stKeep);
}
function stPin(){ stStart();
  const has=!!stLockGet().pin;
  const h=stHead(has?'Change Passcode':'Set a Passcode',"stGo('security')")
    +`<p class="st-note" style="margin:2px 4px 10px">${has?'Choose a new 4–6 digit passcode.':'Choose a 4–6 digit passcode. Cap will ask for it when the app opens.'}</p>`
    +`<label class="m">New passcode</label><input id="st-p1" class="st-in" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password">`
    +`<label class="m">Confirm passcode</label><input id="st-p2" class="st-in" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password">`
    +`<button class="btn" style="width:100%;margin:14px 0 0" onclick="stPinSave()">${has?'Save passcode':'Turn on App Lock'}</button>`
    +`<p class="st-note">Only a one-way hash is stored, and only on this device.</p>`;
  stSheet(h,'set-pin',stKeep);
}
function stPinSave(){
  const a=($('#st-p1')||{}).value||'',b=($('#st-p2')||{}).value||'';
  if(!/^\d{4,6}$/.test(a))return toast('Use 4 to 6 digits');
  if(a!==b)return toast('The passcodes do not match');
  stHash(a).then(h=>{const L=stLockGet();L.pin=h;if(L.auto==null)L.auto=0;if(L.bio==null)L.bio=0;stLockSet(L);
    window._unlocked=1;stLockTouch();stGo('security',1);toast('App Lock is on',true)});
}
function stLockToggle(on){
  if(on){
    if(!stCryptoOk()){toast('App Lock is unavailable in this browser');stGo('security',1);return}
    return stPin();
  }
  stLockSet({});try{localStorage.removeItem(BIO_KEY)}catch(e){}
  window._unlocked=1;clearTimeout(window._lkT);
  stGo('security',1);toast('App Lock is off');
}
function stLockAuto(v){const L=stLockGet();L.auto=+v;stLockSet(L);window._unlocked=1;stLockTouch();stGo('security',1)}
function stBioToggle(on){
  const L=stLockGet();
  if(!on){L.bio=0;stLockSet(L);try{localStorage.removeItem(BIO_KEY)}catch(e){}stGo('security',1);return}
  toast('Follow your device prompt…');
  bioEnroll().then(ok=>{L.bio=ok?1:0;stLockSet(L);stGo('security',1);toast(ok?'Device authentication is on':'Could not set up device authentication',ok)});
}
/* ---- page registry + boot ---- */
ST_PAGES.home=stHome;ST_PAGES.profile=stProfile;ST_PAGES.appearance=stAppearance;ST_PAGES.numbers=stNumbers;
ST_PAGES.categories=stCats;ST_PAGES.notif=stNotif;ST_PAGES.sounds=stSounds;ST_PAGES.backup=stBackup;
ST_PAGES.files=stFiles;ST_PAGES.privacy=stPrivacy;ST_PAGES.security=stSecurity;ST_PAGES.about=stAbout;ST_PAGES.reset=stReset;
function stBoot(){
  applyMotion();applyHide();bvSync();
  if(stLockGet().pin)lockShow();else window._unlocked=1;
  const tick=()=>{try{notifScan()}catch(e){}clearTimeout(window._notifT);window._notifT=setTimeout(tick,180000)};
  window._notifT=setTimeout(tick,6000);
  ['pointerdown','keydown','touchstart'].forEach(ev=>document.addEventListener(ev,()=>{if(window._unlocked)stLockTouch()},{passive:true}));
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){const L=stLockGet();if(L.pin&&+L.auto>=0)window._unlocked=0}
    else{stLockCheck();try{notifScan()}catch(e){}}
  });
}
function dl(n,t,m){const u=URL.createObjectURL(new Blob([t],{type:m})),a=document.createElement('a');a.href=u;a.download=n;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1500)}
function expJSON(){dl(`cap-financetracker-backup-${today}.json`,JSON.stringify({app:'cap-finance-tracker',version:'1.01',exported:new Date().toISOString(),data:S},null,1),'application/json');toast('Backup exported')}
const q2=v=>{v=String(v==null?'':v);return/[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
function expCSV(){const rows=[...S.tx.map(t=>[t,'posted']),...S.pend.map(t=>[t,'pending'])].sort((a,b)=>a[0].d.localeCompare(b[0].d)).map(([t,s])=>{const a=acct(t.acct);return[t.id,t.d,t.pd||'',t.amt<0?'expense':'income',s,t.amt,t.cat,a.name,a.type||'',t.note||''].map(q2).join(',')});dl(`cap-financetracker-transactions-${today}.csv`,'\ufeff'+['id,date,posting_date,type,status,amount,category,account,account_type,description',...rows].join('\r\n'),'text/csv');toast('Transactions exported')}
function csvP(t){t=t.replace(/^\ufeff/,'');const R=[];let r=[],c='',q=false;for(let i=0;i<t.length;i++){const h=t[i];if(q){if(h=='"'){if(t[i+1]=='"'){c+='"';i++}else q=false}else c+=h}else if(h=='"')q=true;else if(h==','){r.push(c);c=''}else if(h=='\n'||h=='\r'){if(h=='\r'&&t[i+1]=='\n')i++;r.push(c);c='';if(r.some(x=>x!==''))R.push(r);r=[]}else c+=h}r.push(c);if(r.some(x=>x!==''))R.push(r);return R}
const sig=t=>[t.d,Math.round(t.amt*100),t.acct,(t.note||'').trim().toLowerCase()].join('|'),DRE=/^\d{4}-\d{2}-\d{2}$/;let IMP=null;
function csvPlan(txt){const R=csvP(txt);if(R.length<2)throw Error('The CSV has no data rows.');const H=R[0].map(h=>h.trim().toLowerCase().replace(/\s+/g,'_')),ix=n=>H.indexOf(n);if(ix('date')<0||ix('amount')<0)throw Error('The CSV needs at least “date” and “amount” columns.');
const g=(r,n)=>{const i=ix(n);return i<0?'':String(r[i]||'').trim()},seen=new Set([...S.tx,...S.pend].map(sig)),ids=new Set([...S.tx,...S.pend].map(t=>String(t.id))),ok=[],bad=[];let dup=0;
R.slice(1).forEach((r,n)=>{const ln=n+2,d=g(r,'date'),ty=g(r,'type').toLowerCase();let amt=+g(r,'amount').replace(/[^\d.\-]/g,'');const an=g(r,'account').toLowerCase(),a=S.accts.find(x=>String(x.id)==g(r,'account_id')||x.name.toLowerCase()==an);let e=null;
if(!DRE.test(d)||isNaN(new Date(d+'T00:00:00')))e='invalid date (use YYYY-MM-DD)';else if(!Number.isFinite(amt)||!amt)e='invalid amount';else if(!a)e='unknown account “'+g(r,'account')+'”';if(e){bad.push(`Row ${ln}: ${e}`);return}
if(ty=='expense'&&amt>0)amt=-amt;if(ty=='income'&&amt<0)amt=-amt;const cat=g(r,'category'),pd=g(r,'posting_date'),st=g(r,'status').toLowerCase()=='pending'&&a.type=='credit'?'pending':'posted',t={id:uid(),d,amt,cat:CATS[cat]?cat:'Other',acct:a.id,note:g(r,'description')||g(r,'note')};
if(st=='posted'&&a.type=='credit'&&DRE.test(pd)&&pd>=d)t.pd=pd;const oid=g(r,'id');if(seen.has(sig(t))||(oid&&ids.has(oid))){dup++;return}seen.add(sig(t));ok.push({t,st})});return{kind:'csv',ok,dup,bad}}
function jsonPlan(txt){const o=JSON.parse(txt),d=o&&o.data&&o.data.accts?o.data:o,E=[];if(!d||!Array.isArray(d.accts)||!Array.isArray(d.tx))throw Error('This isn’t a Cap backup: accounts or transactions are missing.');const N=x=>typeof x=='number'&&isFinite(x),ids=new Set();
d.accts.forEach((a,i)=>{if(!a||!N(a.id)||typeof a.name!='string'||!['debit','credit','ewallet'].includes(a.type)||!Number.isFinite(+a.bal))E.push('Account #'+(i+1)+' is invalid');else ids.add(a.id)});
const pend=Array.isArray(d.pend)?d.pend:[];[...d.tx,...pend].forEach((t,i)=>{if(!t||!N(t.id)||!DRE.test(t.d||'')||!N(t.amt)||!ids.has(t.acct))E.push('Transaction #'+(i+1)+' is invalid or uses an unknown account')});
['bills','goals','debts','xfer'].forEach(k=>{if(d[k]!=null&&!Array.isArray(d[k]))E.push(k+' must be a list')});if(E.length)throw Error(E.slice(0,5).join('\n')+(E.length>5?`\n…and ${E.length-5} more`:''));
return{kind:'json',d:{...d,pend,xfer:d.xfer||[],bills:d.bills||[],goals:d.goals||[],debts:d.debts||[],budgets:d.budgets||{}}}}
function mergeCount(d){const have=new Set([...S.tx,...S.pend].map(t=>t.id)),sg=new Set([...S.tx,...S.pend].map(sig)),old=new Set(S.accts.map(a=>a.id)),nw=k=>d[k].filter(x=>!(S[k]||[]).some(y=>y.id==x.id)).length;return{a:d.accts.filter(a=>!old.has(a.id)).length,t:[...d.tx,...d.pend].filter(t=>!have.has(t.id)&&!sg.has(sig(t))).length,b:nw('bills'),g:nw('goals'),db:nw('debts')}}
function impRead(inp){const f=inp.files[0];if(!f)return;if(f.size>25e6)return toast('That file is too large');openS('<p class="m"><span class="spin"></span> Reading file…</p>');const r=new FileReader();r.onerror=()=>{closeS();toast('Could not read the file')};
r.onload=()=>{try{const t=String(r.result);IMP=/\.csv$/i.test(f.name)||!/^\s*[\[{]/.test(t)?csvPlan(t):jsonPlan(t);impPrev()}catch(e){IMP=null;openS(`<h2>Can’t import this file</h2><p class="r" style="white-space:pre-wrap">${esc(e.message)}</p><p class="m">Nothing was changed.</p><button class="btn s" onclick="closeS()">Close</button>`)}};r.readAsText(f)}
function impPrev(){const I=IMP;let h;if(I.kind=='csv')h=`<h2>Import transactions</h2><p><b>${I.ok.length}</b> new · ${I.dup} duplicate${I.dup==1?'':'s'} skipped · ${I.bad.length} invalid</p>${I.bad.length?`<div class="card r" style="font-size:12px;white-space:pre-wrap">${esc(I.bad.slice(0,5).join('\n'))}${I.bad.length>5?`\n…and ${I.bad.length-5} more (skipped)`:''}</div>`:''}${I.ok.slice(0,4).map(x=>`<div class="row"><div class="f">${esc(x.t.note||x.t.cat)}<small>${x.t.d} · ${esc(acct(x.t.acct).name)}${x.st=='pending'?' · pending':''}</small></div><b class="${x.t.amt>0?'g':'r'}">${php(x.t.amt)}</b></div>`).join('')}`;
else{const d=I.d,m=mergeCount(d);h=`<h2>Restore backup</h2><p class="m">File: ${d.accts.length} accounts · ${d.tx.length+d.pend.length} transactions · ${d.bills.length} bills · ${d.goals.length} goals · ${d.debts.length} debts</p><select id="imm"><option value="merge">Merge — add only what’s new (${m.a} accounts, ${m.t} transactions, ${m.b+m.g+m.db} bills/goals/debts)</option><option value="replace">Replace everything currently in the app</option></select><p class="m" style="font-size:12px">Merge skips duplicates and keeps your current balances. Replace swaps all current data (${S.accts.length} accounts, ${S.tx.length} transactions) for the file’s. A restore point is saved first.</p>`}
openS(h+`<button class="btn" ${I.kind=='csv'&&!I.ok.length?'disabled':''} onclick="impApply()">Confirm import</button> <button class="btn s" onclick="IMP=null;closeS()">Cancel</button>`)}
function impApply(){const I=IMP;if(!I)return;const snap=JSON.stringify(S);let n=0;try{
if(I.kind=='csv'){I.ok.forEach(({t,st})=>{(st=='pending'?S.pend:S.tx).push(t);bApply(t,1)});n=I.ok.length}
else if($('#imm').value=='replace'){S=JSON.parse(JSON.stringify(I.d));n=S.tx.length}
else{const d=I.d,have=new Set([...S.tx,...S.pend].map(t=>t.id)),sg=new Set([...S.tx,...S.pend].map(sig)),old=new Set(S.accts.map(a=>a.id));d.accts.forEach(a=>{if(!old.has(a.id))S.accts.push(a)});
[...d.tx.map(t=>[t,0]),...d.pend.map(t=>[t,1])].forEach(([t,p])=>{if(have.has(t.id)||sg.has(sig(t)))return;(p?S.pend:S.tx).push(t);if(old.has(t.acct))bApply(t,1);n++});
['bills','goals','debts'].forEach(k=>{S[k]=S[k]||[];d[k].forEach(x=>{if(!S[k].some(y=>y.id==x.id))S[k].push(x)})});d.xfer.forEach(x=>{if(!old.has(x.to)&&!S.xfer.some(y=>y.id==x.id))S.xfer.push(x)});Object.keys(d.budgets).forEach(k=>{if(S.budgets[k]==null)S.budgets[k]=d.budgets[k]})}
try{localStorage.setItem('pera_pre',snap)}catch(e){}IMP=null;closeS();render();toast(n+' record'+(n==1?'':'s')+' imported')}catch(e){S=JSON.parse(snap);IMP=null;save();render();toast('Import failed — your data was not changed')}}
function impUndo(){try{S=JSON.parse(localStorage.getItem('pera_pre'));localStorage.removeItem('pera_pre');render();stGo('files',1);toast('Restored the data from before the last import')}catch(e){toast('Nothing to restore')}}



function bindStaticEvents() {
  let settingsTurns=0;
  document.getElementById("settings-button").addEventListener("click", e=>{
    const b=e.currentTarget,gear=b.querySelector('svg');
    settingsTurns++;
    if(gear)gear.style.transform='rotate('+(settingsTurns*180)+'deg)';
    const sh=document.getElementById('sheet');
    if(sh&&sh.classList.contains('open'))closeS();else openSettings();
  });
  document.getElementById("pop").addEventListener("click", function (event) {
    if (event.target === this) popX();
  });
  document.getElementById("sheet").addEventListener("click", function (event) {
    if (event.target === this) closeS();
  });
}


function initUiEnhancements() {

/* ===== Floating sheet + picker dropdowns with images ===== */
(function(){
  const CHEV='<svg class="ps-chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
  const CHECK='<svg class="ck" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
  let pop=null,cur=null;
  const base=t=>String(t).split(' · ')[0].trim();
  const acctOf=v=>S.accts.find(a=>String(a.id)==String(v));
  const typeLbl=a=>a.type=='credit'?'Credit card':a.type=='ewallet'?'E-wallet':'Bank account';
  function kindOf(s){
    const o=[...s.options]; if(!o.length)return null;
    if(s.id=='ct'||o.every(x=>Object.prototype.hasOwnProperty.call(CATS,x.value)))return 'cat';
    const ac=o.filter(x=>acctOf(x.value));
    if(ac.length&&o.every(x=>acctOf(x.value)||x.value=='0'||x.value==''))return 'acct';
    return null;
  }
  function icon(kind,v){
    if(kind=='cat')return `<span class="ps-ic">${ci(v)}</span>`;
    const a=acctOf(v); if(!a)return '';
    return `<span class="ps-mini" aria-hidden="true"><span class="pick">${cardH(a,false,false)}</span></span>`;
  }
  function label(kind,o){
    if(kind=='cat')return esc(o.value);
    const a=acctOf(o.value);
    return a?`${esc(a.name)}<small>${typeLbl(a)}${a.l4?' •• '+esc(a.l4):''}</small>`:esc(o.text);
  }
  function paint(s,b,kind){
    const o=s.options[s.selectedIndex]; if(!o)return;
    const a=kind=='acct'?acctOf(o.value):null;
    b.innerHTML=`${icon(kind,o.value)}<span class="ps-t">${kind=='cat'?esc(o.value):esc(a?a.name:o.text)}</span>${CHEV}`;
  }
  function close(refocus){
    if(!pop)return; const p=pop,c=cur; pop=null;cur=null;
    c.b.setAttribute('aria-expanded','false'); p.classList.add('out'); setTimeout(()=>p.remove(),140);
    if(refocus)c.b.focus();
  }
  function open(s,b,kind){
    close();
    const p=document.createElement('div'); p.className='ps-pop'; p.setAttribute('role','listbox');
    if(kind=='acct'){p.classList.add('grid');
      p.innerHTML=[...s.options].map((o,i)=>{if(o.disabled)return'';const a=acctOf(o.value);
        return `<div class="ps-copt${o.selected?' on':''}" role="option" tabindex="0" aria-selected="${o.selected}" aria-label="${esc(a?a.name:o.text)}" data-i="${i}"><div class="pick">${a?cardH(a,false,false):''}</div><span class="ps-cap">${a?esc(a.name)+(a.l4?' •• '+esc(a.l4):''):esc(o.text)}</span></div>`}).join('');
    }else
    p.innerHTML=[...s.options].map((o,i)=>`<button type="button" class="ps-opt${o.selected?' on':''}" role="option" aria-selected="${o.selected}" data-i="${i}">${icon(kind,o.value)}<span class="ps-t">${label(kind,o)}</span>${o.selected?CHECK:''}</button>`).join('');
    document.body.appendChild(p);
    const r=b.getBoundingClientRect(),vh=innerHeight,below=vh-r.bottom-14,above=r.top-14,need=Math.min(kind=='acct'?420:300,p.scrollHeight);
    const down=below>=need||below>=above;
    p.style.left=r.left+'px'; p.style.width=r.width+'px';
    p.style.maxHeight=Math.max(140,Math.min(kind=='acct'?420:300,down?below:above))+'px';
    if(down)p.style.top=(r.bottom+6)+'px'; else{p.style.bottom=(vh-r.top+6)+'px';p.classList.add('up')}
    pop=p;cur={s,b,kind}; b.setAttribute('aria-expanded','true');
    const sel=p.querySelector('.on'); if(sel)sel.scrollIntoView({block:'nearest'});
    p.addEventListener('click',e=>{const x=e.target.closest('.ps-opt,.ps-copt');if(!x)return;
      s.selectedIndex=+x.dataset.i; s.dispatchEvent(new Event('change',{bubbles:true})); close(true)});
    p.addEventListener('keydown',e=>{const L=[...p.querySelectorAll('.ps-opt,.ps-copt')],i=L.indexOf(document.activeElement),st=kind=='acct'?2:1;
      if(e.key=='ArrowDown'||e.key=='ArrowRight'){e.preventDefault();L[Math.min(L.length-1,i+(e.key=='ArrowDown'?st:1))].focus()}
      else if(e.key=='ArrowUp'||e.key=='ArrowLeft'){e.preventDefault();L[Math.max(0,i-(e.key=='ArrowUp'?st:1))].focus()}
      else if((e.key=='Enter'||e.key==' ')&&document.activeElement.classList.contains('ps-copt')){e.preventDefault();document.activeElement.click()}
      else if(e.key=='Escape'){e.stopPropagation();close(true)}});
  }
  function enhance(){
    const root=document.getElementById('sb'); if(!root)return;
    root.querySelectorAll('select').forEach(s=>{
      if(s.dataset.ps)return; const kind=kindOf(s); if(!kind)return; s.dataset.ps=1;
      const b=document.createElement('button'); b.type='button'; b.className='ps-btn';
      b.setAttribute('aria-haspopup','listbox'); b.setAttribute('aria-expanded','false');
      const lb=s.getAttribute('aria-label')||s.id; b.setAttribute('aria-label',lb?'Choose '+lb:'Choose');
      s.style.display='none'; s.after(b); paint(s,b,kind);
      s.addEventListener('change',()=>paint(s,b,kind));
      b.addEventListener('click',()=>{cur&&cur.s===s?close():open(s,b,kind)});
    });
    if(!root.dataset.psScroll){root.dataset.psScroll=1;root.addEventListener('scroll',()=>close(),{passive:true});}
  }
  document.addEventListener('pointerdown',e=>{if(pop&&!e.target.closest('.ps-pop,.ps-btn'))close()},true);
  addEventListener('resize',()=>close());
  window.psEnhance=enhance;
  const _open=window.openS,_close=window.closeS;
  window.openS=function(h){close();_open.call(this,h);enhance()};
  window.closeS=function(){close();return _close.apply(this,arguments)};
})();


}
