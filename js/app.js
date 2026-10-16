
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
        const r = indexedDB.open("cap-finance", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  const idbGet = (k) => idb().then((d) => new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }));
  const idbPut = (k, v) => idb().then((d) => new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }));

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
        filt = "All",
        q = "",
        cm = 0,
        sel = "",
        pt = "Budgets",
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
      const mtx = () => S.tx.filter((t) => t.d.startsWith(ym));
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
      function live(b) {
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
      function cardH(a, full, det) {
        const cr = a.type == "credit",
          lim = +a.lim || 0,
          owed = +a.bal || 0,
          used = lim ? Math.min(100, Math.round((owed / lim) * 100)) : 0,
          av = det && cr && lim,
          label = av ? "AVAILABLE CREDIT" : "BALANCE",
          amt = php(av ? Math.max(0, lim - owed) : owed),
          art = a.photo || ART[a.img] || ART[ARTN[a.name]] || ART[a.bank],
          oc = full && !det ? `onclick="acctMenu(${a.id})"` : "";
        const bar =
          full && cr && lim
            ? `<div class="pb"><b style="width:${Math.max(used, 2)}%"></b></div><div class="pr"><span>${used}% used</span><span>Limit ${php(lim)}</span></div>`
            : "";
        if (art)
          return `<div class="cc art${det ? " detail" : ""}${a.img == "securitydebit" ? " lt" : a.img == "unionplay" ? " lt ltt" : ""}" style="background-image:url(${art})${a.photo ? ';background-size:cover' : ''}" ${oc}>${a.bank == "GCash" && !a.photo ? '<img class="gl" alt="GCash" src="assets/media/media-c556353f406c.png">' : ""}<div class="tr">${cr ? "CREDIT" : a.type == "ewallet" ? "E-WALLET" : "DEBIT"}${full && a.l4 ? " •• " + a.l4 : ""}</div>${full ? `<div class="at"><small>${label}</small><div class="v">${amt}</div>${bar}</div>` : ""}</div>`;
        const n =
          a.net == "mc"
            ? '<span class="mc"><i></i><i></i></span>'
            : '<img class="visa" alt="Visa" src="' + VISAI + '">';
        return `<div class="cc${det ? " detail" : ""}" style="background:linear-gradient(135deg,${a.g[0]},${a.g[1]})" ${oc}><div style="display:flex;justify-content:space-between">${logoH(a)}<small>${cr ? "CREDIT" : a.type == "ewallet" ? "E-WALLET" : "DEBIT"}${full && a.l4 ? " •• " + a.l4 : ""}</small></div><div class="chip"></div>${full ? `<div class="at"><small>${label}</small><div class="v">${amt}</div>${bar}</div>` : ""}<div class="bt" style="justify-content:flex-end">${n}</div></div>`;
      }
      function render() {
        applyTheme();
        ensureCats();
        $("#tabs").innerHTML = ["Home", "Activity", "Plan", "Accounts"]
          .map(
            (t) =>
              `<button class="${t == tab ? "on" : ""}" onclick="tab='${t}';trendM=null;render()">${t}</button>`,
          )
          .join("");
        $("#app").innerHTML = { Home, Activity, Plan, Accounts, Notes }[tab]();
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
                  body: `${php(under)} of your ${php(budget)} monthly budget remains.`,
                  icon: "🌱",
                }
              : {
                  title: `You’re ${Math.round((Math.abs(under) / budget) * 100)}% over budget`,
                  body: `You’ve spent ${php(Math.abs(under))} beyond your ${php(budget)} monthly budget.`,
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
              value = -sum(S.tx.filter((t) => t.d.startsWith(key) && t.amt < 0).map((t) => t.amt));
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
        const td = -sum(S.tx.filter((t) => t.d == today && t.amt < 0).map((t) => t.amt));
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
<p class="m">You spent <b style="color:var(--tx)">${php(td)}</b> today.${due.length ? ` <b style="color:var(--tx)">${due.length} bill${due.length > 1 ? "s" : ""}</b> coming up soon.` : ""}</p>
<div style="margin-bottom:16px">${netChart(cash, owed)}</div>
<div class="stats"><div class="card"><div class="eyebrow">In</div><b class="g">+${php(inc)}</b></div><div class="card"><div class="eyebrow">Out</div><b class="r">${php(out)}</b></div><div class="card"><div class="eyebrow">Net</div><b class="${inc - out >= 0 ? "g" : "r"}">${php(inc - out)}</b></div></div>
  <div class="grid" style="margin-top:14px"><div>${spendingChart()}</div>
<div><div class="card"><div class="eyebrow">Needs attention</div>${due.map(attnRow).join("") + over.map((c) => `<div class="row"><div class="ico">📊</div><div class="f">${c} is over budget<small>+${php(spent(c) - S.budgets[c])}</small></div></div>`).join("") || '<p class="m">All clear 🎉</p>'}</div>
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
          yy = (CH.Y(v) / 180) * 100;
        w.classList.add("t");
        $("#chl").style.cssText = `display:block;left:${x}%;top:${yy}%`;
        $("#chd").style.cssText = `display:block;left:${x}%;top:${yy}%`;
        const n = $("#chn");
        n.style.cssText = `display:block;left:${Math.min(88, Math.max(12, x))}%;top:${yy}%`;
        n.textContent = php(v);
        const t = $("#cht");
        t.style.display = "block";
        t.textContent = CH.labs[i];
        $("#chv").textContent = php(v);
        const c = $("#chc");
        c.className = !dy ? "m" : dy > 0 ? "g" : "r";
        c.textContent = dy
          ? `${dy > 0 ? "\u2197 +" : "\u2198 "}${php(dy)}${CH.nm[i] ? " · " + CH.nm[i] : ""}`
          : i
            ? "No change"
            : "Start of range";
      }
      function chUp() {
        if (!CH) return;
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
          c.className = CH.cls;
          c.textContent = CH.sub;
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
          sub = `${dl >= 0 ? "\u2197 +" : "\u2198 "}${php(dl)} ${ph}`,
          cls = dl >= 0 ? "g" : "r";
        CH = { N: N2, pts, labs, nm, Y, top: php(nn), sub, cls };
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
                `<span class="ylb" style="top:${(y / 180) * 100}%">${php(Math.round(mn + ((168 - y) / 144) * (mx - mn)))}</span>`,
            )
            .join("");
        return `<div><div class="eyebrow">Net balance</div><div class="big" id="chv">${php(nn)}</div><div class="${cls}" id="chc" style="font-size:13px">${sub}</div></div>
<div class="rts">${R.map((x) => `<button class="rt ${x == r ? "on" : ""}" onclick="rg='${x}';render()">${x}</button>`).join("")}</div>
<div id="chw" class="ch" style="position:relative;height:180px;touch-action:pan-y;cursor:crosshair;user-select:none;-webkit-user-select:none;border-bottom:1px solid var(--mut)" onpointermove="chMove(event)" onpointerdown="chMove(event)" onpointerup="chUp()" onpointerleave="chUp()" onpointercancel="chUp()"><svg viewBox="0 0 600 180" preserveAspectRatio="none" style="width:100%;height:100%;display:block"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".35"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>${hl}${vl}<path d="${ln} L600 180 L0 180Z" fill="url(#ag)"/><path d="${ln}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>${yl}${dots}<i id="chl" class="cl"></i><i id="chd" class="cd s"></i><span id="chn" class="cv"></span><span id="cht" class="cdt"></span></div>
<div class="xl" style="position:relative;height:18px;margin-top:4px">${xl}</div><div class="m" style="margin-top:8px;font-size:12px">Cash & e-wallets ${php(cash)} · Credit owed ${php(owed)}</div>`;
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
<div class="m" style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px">${lb.map((x) => `<span>${x}</span>`).join("")}</div><div class="m" style="margin-top:6px;font-size:12px">Cash & e-wallets ${php(cash)} · Credit owed ${php(owed)}</div>`;
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
<div class="m" style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px">${lb.map((x) => `<span>${x}</span>`).join("")}</div><div class="m" style="margin-top:6px;font-size:12px">Cash & e-wallets ${php(cash)} · Credit owed ${php(owed)}</div>`;
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
<div class="m" style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px">${lb.map((x) => `<span>${x}</span>`).join("")}</div><div class="m" style="margin-top:6px;font-size:12px">Cash & e-wallets ${php(cash)} · Credit owed ${php(owed)}</div>`;
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
              .filter((t) => t.d.startsWith(pym) && t.amt < 0 && +t.d.slice(8) <= dm)
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
              .filter((t) => t.d.startsWith(pym) && t.amt < 0 && +t.d.slice(8) <= dm)
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
        openSettings();
      }
      function openSettings() {
        const t = S.theme || "auto";
        openS(
          `<h2>Settings</h2><div class="eyebrow" style="margin-bottom:6px">Your name</div><input placeholder="Enter your name" value="${esc(S.name || "")}" oninput="S.name=this.value;render()"><div class="eyebrow" style="margin-bottom:8px">Appearance</div><p style="display:flex;gap:6px">${[
            ["light", "☀️ Light"],
            ["dark", "🌙 Dark"],
            ["auto", "⚙️ Auto"],
          ]
            .map(
              (x) =>
                `<button class="pill ${t == x[0] ? "on" : ""}" style="flex:1" onclick="setTheme('${x[0]}')">${x[1]}</button>`,
            )
            .join(
              "",
            )}</p><p class="m" style="font-size:12px">Auto follows your device's light or dark setting.</p>${prefHtml()}<div class="eyebrow" style="margin:14px 0 6px">Categories</div><button class="btn s" onclick="catMgr()">Edit categories</button>${dataHtml()}<div class="eyebrow" style="margin:14px 0 8px">Privacy &amp; sync</div>${window.CapOff ? CapOff.settingsHtml() : ""}<button class="btn s" onclick="closeS()">Done</button> <button class="btn s" style="color:#ff453a" onclick="sure(this,()=>{S={accts:[],tx:[],bills:[],budgets:{},notes:[],goals:[],debts:[]};closeS();render()})">Reset all data</button>`,
        );
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
                `<span class="ap ${x[0]}" onclick="event.stopPropagation();evDetail('${k}',${j})">${x[1]}</span>`,
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
          )}${sel ? `<span>Showing ${new Date(sel + "T00:00:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" })} · <a href="#" onclick="sel='';render();return false">clear</a></span>` : ""}</p></div>`;
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
        return `<h1>Plan</h1><p style="display:flex;gap:6px;overflow:auto">${["Budgets", "Upcoming", "Goals", "Debts", "Notes"].map((t) => `<button class="pill ${t == pt ? "on" : ""}" style="flex:1" onclick="pt='${t}';render()">${t}</button>`).join("")}</p>${body}`;
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
        const ms = -sum(l.filter((t) => t.d.startsWith(ym) && t.amt < 0).map((t) => t.amt));
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
const bnd=s=>bi(s)||xb(s);

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
const billAria=(b,t)=>`tabindex="0" role="button" aria-label="${esc(b.name)}, ${t}, ${php(b.amt)}. Press and hold, right-click or press Enter to edit."`;
/* urgency tiers by whole days left: overdue (<0) deep red · 0-3 red · 4-7 yellow · later neutral */
const urgOf=n=>n<0?'o':n<=3?'r':n<=7?'y':'n';
const urgTxt=n=>n<0?'<span class="odb">Overdue</span>'+Math.abs(n)+'d':n==0?'Due today':'Due in '+n+'d';
function attnRow(b){
  const nd=nextDue(b),n=days(b),u=urgOf(n),plain=n<0?'Overdue by '+Math.abs(n)+'d':n==0?'Due today':'Due in '+n+'d';
  return `<div class="row urg-${u}" data-due="${bIso(nd)}" ${billAttr(b)} ${billAria(b,plain)}><div class="ico">${bIc(b,'⏰')}</div><div class="f">${esc(b.name)}<small class="du">${urgTxt(n)}</small></div><b class="du">${php(b.amt)}</b></div>`;
}
/* recolour the rows already on screen (so colours fade between tiers instead of being re-rendered) */
function refreshUrgency(){
  const t0=bDt(today);
  document.querySelectorAll('#app .row[data-due]').forEach(function(row){
    const n=Math.round((bDt(row.getAttribute('data-due'))-t0)/864e5),u=urgOf(n);
    ['o','r','y','n'].forEach(function(x){row.classList.toggle('urg-'+x,x===u)});
    const sm=row.querySelector('.du-status')||row.querySelector('small.du'),h=urgTxt(n);
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
  return `<span class="psrc"><span>${esc(fallback||'Paid outside this app')}</span></span>`;
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
  if(SVKEY)SVSC[SVKEY]=sb.scrollTop;                    /* remember where we left the old screen */
  SVKEY=key||'';
  if(opts.keep)SVKEEP[SVKEY]=1;
  const want=SVKEEP[SVKEY]?(SVSC[SVKEY]||0):0;          /* only restored screens keep their place */
  const sv=sb.firstElementChild;
  const sync=()=>{if(window.psEnhance)window.psEnhance()};
  const settle=()=>{clearTimeout(window._nt);window._navBusy=0;svSettle(sb);sb.scrollTop=want};
  if(!sv){sb.innerHTML='<div id="sv">'+html+'</div>';sync();svSettle(sb);sb.scrollTop=want;return}
  const commit=()=>{
    clearTimeout(window._nt);window._navBusy=0;
    sv.innerHTML=html;sync();
    sb.scrollTop=want;
    sb.style.height='auto';                             /* let the incoming view size the container */
    const target=Math.round(sb.offsetHeight);           /* already clamped to the viewport */
    sb.style.height=h0+'px';void sb.offsetHeight;       /* pin the current height so the resize animates */
    sv.style.transition='none';sv.style.opacity='0';sv.style.transform='translateY(9px) scale(.996)';
    void sv.offsetHeight;                               /* flush the starting frame */
    sb.style.transition='height '+SV_MS+'ms '+SV_EASE;
    sv.style.transition='opacity '+SV_IN+'ms '+SV_EASE+' 40ms,transform '+SV_IN+'ms '+SV_EASE+' 40ms';
    sb.style.height=target+'px';
    sv.style.opacity='1';sv.style.transform='none';
    svHold(want,SV_MS);
    window._nt=setTimeout(settle,SV_MS+160);
  };
  const h0=Math.round(sb.offsetHeight);
  if(busy)return commit();
  if(matchMedia('(prefers-reduced-motion:reduce)').matches){
    sv.innerHTML=html;sync();svSettle(sb);sb.scrollTop=want;return;
  }
  /* keep the shell's size while the old view leaves, then hand over */
  sb.style.transition='none';
  sb.style.height=h0+'px';
  sb.style.overflow='hidden';
  sv.style.transition='opacity '+SV_OUT+'ms ease,transform '+SV_OUT+'ms ease';
  sv.style.opacity='0';
  sv.style.transform='translateY(-7px) scale(.995)';
  window._navBusy=1;
  window._nt=setTimeout(commit,SV_OUT);
}
function editBillSheet(id){
  const b=S.bills.find(x=>x.id==id);if(!b)return;
  const nd=bIso(nextDue(b)),fq=b.freq||'monthly',pays=billPayments(b),last=pays[0];
  navS(`<div class="sh-h"><h2>Edit bill</h2>${billStatusChip(b)}</div><label class="m">Name</label><input id="eb-n" maxlength="60" value="${esc(b.name)}"><label class="m">Amount (${CS()})</label><input id="eb-a" type="number" inputmode="decimal" step="0.01" min="0" value="${b.amt}"><label class="m">Due date</label><input id="eb-d" type="date" value="${nd}" data-o="${nd}"><label class="m">Repeats</label><select id="eb-r">${Object.keys(BF).map(k=>`<option value="${k}" ${fq==k?'selected':''}>${k=='once'?'Never (one-time)':BF[k]}</option>`).join('')}</select><p class="hint">Next due ${bDt(nd).toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'})}</p><label class="m">Pay from</label><select id="eb-p" aria-label="Pay from"><option value="0">Choose later</option>${S.accts.map(a=>`<option value="${a.id}" ${a.id==b.acct?'selected':''}>${esc(a.name)}</option>`).join('')}</select><div class="logo-row"><span class="ico">${bIc(b)}</span><span class="f"><b>Logo</b><small>${b.logo?'Your uploaded logo':'Automatic, from the bill name'}</small></span><label class="pill" style="cursor:pointer">${b.logo?'Replace':'Upload'}<input type="file" accept="image/*" hidden onchange="billLogo(${id},this)"></label>${b.logo?`<button class="pill" onclick="billNoLogo(${id})">Remove</button>`:''}</div><div class="eyebrow" style="margin:18px 0 8px">Latest Payment</div>${last?payCardHtml(last,{bill:b}):'<div class="empty"><div class="e-ic">🧾</div><p class="m">No payments recorded yet.</p></div>'}<button class="ph-row" onclick="billHistory(${id})"><span>Payment history</span><span class="ph-n">${pays.length} ›</span></button>${paidNow(b)?`<button class="btn s" style="margin-top:10px;width:100%" onclick="unpayBillAsk(${id})">Mark as unpaid</button>`:''}<button class="btn s danger-t" style="margin-top:10px;width:100%" onclick="delBillAsk(${id})">Delete bill</button><div class="sf"><button class="btn s" onclick="closeS()">Cancel</button><button class="btn" onclick="saveBillEdit(${id},this)">Save changes</button></div>`,'bill'+id);
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
  return payHistHtml(billPayments(b).map(p=>({d:p.d,amt:p.amt,acct:p.acct,acctName:p.acctName,due:p.due,logoHtml:bIc(b,'🧾'),onclick:`payDetail(${p.tx.id})`})),{year:PH[b.id],fn:'phY',id:b.id});
}
function phY(id,y){PH[id]=+y;phSwap($('#ph-body'),billHistBody(S.bills.find(x=>x.id==id)))}
function cardHistBody(a){
  return payHistHtml(S.xfer.filter(x=>x.to==a.id).sort((x,y)=>String(y.d).localeCompare(String(x.d))||y.id-x.id)
    .map(x=>({d:x.d,amt:x.amt,acct:x.from,due:x.due||'',logoHtml:cardLogo(a),onclick:`cardPayDetail(${x.id},${a.id})`})),{year:PHC[a.id],fn:'phcY',id:a.id});
}
function phcY(id,y){PHC[id]=+y;phSwap($('#ph-body'),cardHistBody(acct(id)))}
function billBack(id){return `<button class="btn s" style="margin-top:10px;width:100%" onclick="editBillSheet(${id})">‹ Back to bill</button>`}
function billHistory(id){
  const b=S.bills.find(x=>x.id==id);if(!b)return;
  const pays=billPayments(b),head=`<div class="sh-h"><button class="pill" aria-label="Back to bill" onclick="editBillSheet(${id})">‹</button><h2>Payment history</h2></div><p class="m ph-sub">${esc(b.name)}</p>`;
  if(!pays.length)return navS(head+'<div class="empty"><div class="e-ic">🧾</div><p class="m">No payments recorded yet.</p></div>'+billBack(id),'hist'+id,{keep:1});
  navS(head+`<div id="ph-body">${billHistBody(b)}</div>`+(paidNow(b)?`<button class="btn s" style="margin-top:14px;width:100%" onclick="unpayBillAsk(${id})">Mark the latest payment as unpaid</button>`:'')+billBack(id),'hist'+id,{keep:1});
}
function payDetail(txId){
  const t=S.tx.find(x=>x.id==txId);if(!t)return;
  const bill=billForTx(t),due=bill?billDueShown(bill,t):(t.billDue||''),n=payDiff(due,t.d);
  const paidName=t.note||(bill?bill.name:t.cat),renamed=bill&&t.note&&t.note!==bill.name,back=bill?`billHistory(${bill.id})`:'closeS()';
  const R=(l,v)=>`<div class="pd-r"><span class="m">${l}</span><b>${v}</b></div>`;
  navS(`<div class="sh-h"><button class="pill" aria-label="Back" onclick="${back}">‹</button><h2>Payment details</h2></div>`
    +`<div class="pd-hero"><div class="pd-h"><span class="ico">${bill?bIc(bill,'🧾'):'🧾'}</span><div class="pd-tt"><b>${esc(paidName)}</b><small>${esc(t.cat)}${renamed?` · now called ${esc(bill.name)}`:''}</small></div></div><div class="pd-amt"><span class="pd-v">${php(Math.abs(t.amt))}</span><span class="chip ok">✓ Paid</span></div>${n==null?'':`<div class="pd-tm"><span class="chip ${n<0?'warn':'ok'}">${payTimingLabel(n)}</span></div>`}</div>`
    +`<div class="card" style="margin:0 0 12px">${R('Paid on',noteD(t.d))}${due?R('Original due date',noteD(due)):''}${R('Paid with',paySrcHtml(t.acct,t.acctName))}${t.desc?R('Note',esc(t.desc)):''}</div>`
    +`<button class="btn s" style="width:100%" onclick="editTx(${t.id})">Open in Activity</button>`
    +`${bill?`<button class="btn s dng" onclick="unpayFromDetail(${bill.id},${t.id})">Mark as unpaid</button>`:''}`
    +`<button class="btn s" style="margin-top:10px;width:100%" onclick="${back}">‹ Back to payments</button>`,'pd'+t.id);
}
function unpayFromDetail(bid,tid){
  const b=S.bills.find(x=>x.id==bid),t=S.tx.find(x=>x.id==tid);
  if(!b||!t)return;
  confirmBox('Mark this payment as unpaid?',b.name+' · '+php(Math.abs(t.amt))+' · '+noteD(t.d),()=>{undoBillPayment(b,t,t.billDue);closeS();render();toast('Bill marked unpaid')});
}
function saveBillEdit(id,btn){
  const b=S.bills.find(x=>x.id==id);if(!b)return;
  const n=$('#eb-n').value.trim(),a=parseFloat($('#eb-a').value),dEl=$('#eb-d'),f=$('#eb-r').value;
  if(!n)return toast('Enter a name');
  if(!(a>=0))return toast('Enter a valid amount');
  const dateChanged=dEl.value&&dEl.value!==dEl.dataset.o,freqChanged=f!==(b.freq||'monthly');
  b.name=n;b.amt=a;b.acct=+$('#eb-p').value||0;
  /* only re-anchor the schedule when the date or frequency was actually changed */
  if(dateChanged||freqChanged){const st=dEl.value||dEl.dataset.o;b.start=st;b.due=+st.slice(8,10);b.freq=f}
  const done=()=>{closeS();render();toast('Bill updated',true)};
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
function billLogo(id,inp){const b=S.bills.find(x=>x.id==id);if(!b)return;imgPick(inp,64,'png',u=>{b.logo=u;save();render();editBillSheet(id);toast('Logo updated')})}
function billNoLogo(id){const b=S.bills.find(x=>x.id==id);if(!b)return;delete b.logo;save();render();editBillSheet(id);toast('Logo removed')}
function cardPayInfo(cid){
  const a=S.accts.find(x=>x.id==cid);if(!a)return;
  const open=outstandingCardStatements().find(x=>x.a.id==cid),nd=open?bDt(open.due):nextCardDue(a),amount=open?open.amount:dueAmt(a),R=(l,v)=>`<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0"><span class="m">${l}</span><b style="text-align:right">${v}</b></div>`;
  const pays=S.xfer.filter(x=>x.to==cid);
  navS(`<div class="sh-h"><h2>${esc(a.name)} Payment</h2></div><p class="m" style="font-size:13px">This payment comes from the card itself, so its name, amount and due date follow the card's settings.</p><div class="card" style="margin:0 0 12px">${R('Card',esc(a.name))}${open?R('Statement period',noteD(open.statement.c.st)+' – '+noteD(open.statement.c.en)):''}${R('Amount due',php(amount))}${R('Due date',nd?nd.toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric"}):'—')}</div>${open?`<button class="btn" onclick="payCard(${a.id},1)">Pay statement</button> `:''}${pays.length?`<div id="ph-body">${cardHistBody(a)}</div>`:'<div class="empty"><div class="e-ic">💳</div><p class="m">No payments recorded yet.</p></div>'}<button class="btn s" onclick="acctMenu(${a.id})">Edit card &amp; due date</button><button class="btn s" style="width:100%;margin-top:8px" onclick="closeS()">Close</button>`,'card'+cid,{keep:1});
}
function cardPayDetail(xid,cid){
  const x=S.xfer.find(z=>z.id==xid);if(!x)return;
  const c=S.accts.find(z=>z.id==cid)||S.accts.find(z=>z.id==x.to),f=S.accts.find(z=>z.id==x.from),n=payDiff(x.due,x.d);
  const R=(l,v)=>`<div class="pd-r"><span class="m">${l}</span><b>${v}</b></div>`;
  navS(`<div class="sh-h"><button class="pill" aria-label="Back" onclick="cardPayInfo(${cid})">‹</button><h2>Payment details</h2></div>`
    +`<div class="pd-hero"><div class="pd-h"><span class="ico">${c?cardLogo(c):'💳'}</span><div class="pd-tt"><b>${esc(c?c.name:'Card')}</b><small>Card payment</small></div></div><div class="pd-amt"><span class="pd-v">${php(x.amt)}</span><span class="chip ok">✓ Paid</span></div>${n==null?'':`<div class="pd-tm"><span class="chip ${n<0?'warn':'ok'}">${payTimingLabel(n)}</span></div>`}</div>`
    +`<div class="card" style="margin:0 0 12px">${R('Paid on',noteD(x.d))}${x.due?R('Statement due',noteD(x.due)):''}${R('Paid from',f?paySrcHtml(f.id):'Outside this app')}${x.note?R('Note',esc(x.note)):''}</div>`
    +`<button class="btn s dng" onclick="undoCardPay(${x.id},${cid})">Mark as unpaid</button>`
    +`<button class="btn s" style="margin-top:10px;width:100%" onclick="cardPayInfo(${cid})">‹ Back to payments</button>`,'cpd'+x.id);
}
function undoCardPay(xid,cid){
  const x=S.xfer.find(z=>z.id==xid);if(!x)return;
  const c=S.accts.find(z=>z.id==x.to),f=S.accts.find(z=>z.id==x.from);
  confirmBox('Mark this payment as unpaid?',(S.accts.find(z=>z.id==cid)||{}).name+' · '+php(x.amt)+' · '+noteD(x.d),()=>{if(c)c.bal+=x.amt;if(f)f.bal+=x.amt;S.xfer=S.xfer.filter(z=>z.id!=xid);render();cardPayInfo(cid);toast('Marked as unpaid')});
}

function ensureCats(){migrate();if(!Array.isArray(S.cats)||!S.cats.length)S.cats=CAT0.map(c=>({n:c.n,i:c.i}));for(const k of Object.keys(CATS))delete CATS[k];S.cats.forEach(c=>{CATS[c.n]=c.i||'📦'})}
function imgPick(inp,mw,fmt,cb){const f=inp.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const k=Math.min(1,mw/Math.max(im.width,im.height)),w=Math.max(1,Math.round(im.width*k)),hh=Math.max(1,Math.round(im.height*k)),c=document.createElement('canvas');c.width=w;c.height=hh;c.getContext('2d').drawImage(im,0,0,w,hh);cb(fmt=='png'?c.toDataURL('image/png'):c.toDataURL('image/jpeg',.78))};im.src=r.result};r.readAsDataURL(f)}
function catMgr(){openS(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2 style="margin:0">Categories</h2><button class="pill" onclick="closeS();render()">Done</button></div><p class="m" style="font-size:12px;margin:0 0 8px">Rename a category, change its emoji, or upload a logo (a logo replaces the emoji everywhere). If a note contains a category's name, like Meralco, that logo shows on the entry too.</p>${S.cats.map((c,i)=>`<div class="row"><div class="ico">${ci(c.n)}</div><div class="f"><input value="${esc(c.n)}" onchange="catRen(${i},this.value)" style="margin:0 0 6px"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><input value="${esc(c.i||'')}" maxlength="2" onchange="catEmo(${i},this.value)" style="width:56px;margin:0" placeholder="😀"><label class="pill" style="cursor:pointer">Upload logo<input type="file" accept="image/*" hidden onchange="catLogo(${i},this)"></label>${c.l?`<button class="pill" onclick="catNoLogo(${i})">Remove logo</button>`:''}</div></div><button class="pill" onclick="sure(this,()=>catDel(${i}))">✕</button></div>`).join('')}<div class="eyebrow" style="margin:16px 0 6px">Add category</div><div style="display:flex;gap:6px"><input id="ncn" placeholder="Name" style="margin:0;flex:1"><input id="nce" placeholder="😀" maxlength="2" style="margin:0;width:56px"><button class="btn" onclick="catAdd()">Add</button></div>`)}
function catRen(i,v){v=v.trim();const c=S.cats[i];if(!v||v==c.n||S.cats.some(x=>x.n==v)){catMgr();return}S.tx.forEach(t=>{if(t.cat==c.n)t.cat=v});if(S.budgets[c.n]!=null){S.budgets[v]=S.budgets[c.n];delete S.budgets[c.n]}c.n=v;ensureCats();render();catMgr()}
function catEmo(i,v){S.cats[i].i=v.trim()||'📦';ensureCats();render();catMgr()}
function catAdd(){const n=$('#ncn').value.trim();if(!n||S.cats.some(x=>x.n==n))return;S.cats.push({n,i:$('#nce').value.trim()||'📦'});ensureCats();render();catMgr()}
function catDel(i){S.cats.splice(i,1);ensureCats();render();catMgr()}
function catNoLogo(i){delete S.cats[i].l;render();catMgr()}
function catLogo(i,inp){imgPick(inp,64,'png',u=>{S.cats[i].l=u;render();catMgr()})}
const SPX=['#3d7a5a','#6b9a80','#91b09f','#b4c7bb','#4f6f5f','#7fa391'],SPB={Food:"#165b3a",Groceries:"#2f855a",Transport:"#75a987",Bills:"#a9b9ae",Shopping:"#214f3b",Health:"#8fb996",Entertainment:"#5d7f6c",Other:"#c8d4cc"};
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
          seg = (p, n, h, c) =>
            `<div style="display:flex;gap:${h > 10 ? 6 : 2}px">${[...Array(n)].map((_, i) => `<i style="flex:1;height:${h}px;border-radius:3px;background:${i < Math.round((p / 100) * n) ? c : "var(--line)"}"></i>`).join("")}</div>`;
        goalIndex = Math.min(goalIndex, Math.max(0, A.length - 1));
        const f = A[goalIndex];
        return `<div class="card"><div class="eyebrow">Saved toward goals</div><div><span class="big" style="font-size:34px">${php(sv)}</span> <span class="m">of ${php(tg)}</span></div><div style="margin-top:10px">${seg(tg ? (sv / tg) * 100 : 0, 60, 10, "var(--g)")}</div></div>
${f ? `<div id="goal-card" class="card goal-card ${goalEnter ? `goal-in-${goalEnter}` : ""}" style="touch-action:pan-y;user-select:none;cursor:grab;transition:transform .2s ease,opacity .2s ease" onpointerdown="goalStart(event)" onpointermove="goalMove(event)" onpointerup="goalSwipe(event.clientX)" onpointercancel="goalCancel()"><div style="display:flex;justify-content:space-between;align-items:center"><div class="eyebrow">Savings goal ${A.length > 1 ? "· " + (goalIndex + 1) + " of " + A.length : ""}</div><span class="m" style="font-size:12px">Swipe right: next · left: previous</span></div><div style="font-size:40px;margin-top:6px">${f.icon}</div><h2 style="font-size:26px;margin:2px 0 10px">${esc(f.name)}</h2><div style="display:flex;justify-content:space-between;align-items:baseline"><b>${php(f.saved)} saved</b><b>${pc(f)}%</b></div><div class="bar" style="height:12px"><b style="width:${pc(f)}%"></b></div><div style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px"><span class="m">Target ${php(f.target)}</span><span class="m">${php(Math.max(0, f.target - f.saved))} remaining</span></div><p style="margin:12px 0 0"><button class="btn s" onclick="goalSheet(${f.id})">Manage goal</button></p></div>` : ""}
<div class="card"><div class="eyebrow">Goals</div>${A.map((g) => `<div class="sw" data-g="${g.id}">${swActs(g)}<div class="row sw-c" onclick="swTap(${g.id})" onpointerdown="swDown(event)" onpointermove="swMove(event)" onpointerup="swUp(event)" onpointercancel="swUp(event)"><div style="width:44px;height:44px;border-radius:50%;background:conic-gradient(var(--g) ${pc(g)}%,var(--line) 0);display:grid;place-items:center;flex:none"><div style="width:34px;height:34px;border-radius:50%;background:var(--card);display:grid;place-items:center">${g.icon}</div></div><div class="f">${esc(g.name)}<small>${php(g.saved)} saved · ${pc(g)}% · ${php(Math.max(0, g.target - g.saved))} remaining of ${php(g.target)}</small><div class="bar"><b style="width:${pc(g)}%"></b></div></div><button class="pill" onclick="event.stopPropagation();goalSheet(${g.id})">＋</button></div></div>`).join("") || '<p class="m">No goals yet.</p>'}<p class="m" style="font-size:12px">Tap a goal to add money, take money out or mark it done.</p><button class="btn s" onclick="openGoal()">＋ Add goal</button></div>
${D.length ? `<div class="card"><div class="eyebrow">Done</div>${D.map((g) => `<div class="row" style="cursor:pointer" onclick="goalSheet(${g.id})"><div class="ico">${g.icon}</div><div class="f">${esc(g.name)}<small>${php(g.saved)} saved · ${pc(g)}% · ${php(Math.max(0, g.target - g.saved))} remaining of ${php(g.target)}</small></div>✅</div>`).join("")}</div>` : ""}`;
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
      function goalSheet(id) {
        const g = S.goals.find((x) => x.id == id);
        openS(
          `<h2>${g.icon} ${g.name}</h2><p class="m">${php(g.saved)} of ${php(g.target)}</p><input id="ga" type="number" placeholder="Amount (${CS()})"><button class="btn" onclick="gMove(${id},1)">Add money</button> <button class="btn s" onclick="gMove(${id},-1)">Take out</button><p><button class="btn s" onclick="S.goals.find(x=>x.id==${id}).done=${g.done ? 0 : 1};closeS();render()">${g.done ? "Reopen goal" : "Mark as done"}</button> <button class="btn s" onclick="sure(this,()=>{S.goals=S.goals.filter(x=>x.id!=${id});closeS();render()})">Delete</button></p>`,
        );
      }
      function gMove(id, s) {
        const a = Math.abs(+$("#ga").value);
        if (!a) return;
        const g = S.goals.find((x) => x.id == id);
        g.saved = Math.max(0, g.saved + s * a);
        closeS();
        render();
      }
      function openGoal() {
        openS(
          `<h2>New goal</h2><input id="gn" placeholder="Goal name (e.g. Japan Trip)"><input id="gi" maxlength="2" placeholder="Emoji" value="🎯"><input id="gt" type="number" placeholder="Target amount (${CS()})"><input id="gs" type="number" placeholder="Already saved (${CS()})"><button class="btn" onclick="S.goals.push({id:Date.now(),name:$('#gn').value||'Goal',icon:$('#gi').value||'🎯',target:+$('#gt').value||0,saved:+$('#gs').value||0});closeS();render()">Add</button>`,
        );
      }
      function openDebt() {
        openS(
          `<h2>New debt or IOU</h2><select id="dr"><option value="in">Someone owes me</option><option value="out">I owe someone</option></select><input id="dw" placeholder="Person or lender"><input id="dn" placeholder="Note (e.g. Dinner split)"><input id="da" type="number" placeholder="Amount (${CS()})"><input id="dd2" type="date"><button class="btn" onclick="S.debts.push({id:Date.now(),dir:$('#dr').value,who:$('#dw').value||'Someone',note:$('#dn').value,amt:+$('#da').value||0,due:$('#dd2').value});closeS();render()">Add</button>`,
        );
      }
      function debtSheet(id) {
        const d = S.debts.find((x) => x.id == id);
        openS(
          `<h2>${d.who}</h2><p class="m">${php(d.amt)} ${d.dir == "in" ? "owed to you" : "you owe"}</p><input id="dp" type="number" placeholder="Payment amount (${CS()})"><button class="btn" onclick="dPay(${id})">Record payment</button> <button class="btn s" onclick="S.debts=S.debts.filter(x=>x.id!=${id});closeS();render()">Delete</button>`,
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
function fmt(n){n=+n||0;const c=CURS[S&&S.cur]||CURS.PHP,d=S&&S.dec&&c[2]!==0?2:0,v=Math.abs(n),r=d?Math.round(v*100)/100:Math.round(v);return(n<0&&r?'−':'')+c[0]+r.toLocaleString(c[1],{minimumFractionDigits:d,maximumFractionDigits:d})}
function migrate(){S.pend=S.pend||[];S.xfer=S.xfer||[];S.cur=S.cur||'PHP';(S.accts||[]).forEach(a=>{if(a&&a.bank=='GCash'&&!a.photo&&(a.img=='gcashg'||/^GCash (Mastercard|Visa Debit|Visa Card)$/.test(a.name))){a.name='GCash Visa Card';a.type='ewallet';a.net='visa';a.img='gcashg';a.g=['#0b2a7a','#2f6fe0']}})}
let _u=0;const uid=()=>Date.now()*1000+(++_u),dflt=b=>S.accts.find(a=>a.id==b.acct)||S.accts[0];


/* ---- goals: swipe actions */
const swActs=g=>`<div class="sw-b sw-bl"><button onclick="goalSheet(${g.id},'add')">＋<small>Add</small></button><button onclick="goalSheet(${g.id},'out')">−<small>Take out</small></button></div><div class="sw-b sw-br"><button onclick="goalDone(${g.id})">${g.done?'↺':'✓'}<small>${g.done?'Reopen':'Done'}</small></button><button class="d" onclick="sure(this,()=>goalDel(${g.id}))">✕<small>Delete</small></button></div>`;
let SW=null;
function swClose(x){document.querySelectorAll('.sw-c').forEach(e=>{if(e!==x){e.style.transform='';e.dataset.o=''}})}
function swDown(e){const c=e.currentTarget;swClose(c);SW={c,x:e.clientX,y:e.clientY,o:+(c.dataset.o||0),h:0,m:0};c.style.transition='none'}
function swMove(e){if(!SW)return;const dx=e.clientX-SW.x,dy=e.clientY-SW.y;if(!SW.h){if(Math.abs(dx)>8&&Math.abs(dx)>Math.abs(dy)*1.4)SW.h=1;else if(Math.abs(dy)>8){SW.c.style.transition='';SW=null;return}else return}SW.m=1;try{SW.c.setPointerCapture(e.pointerId)}catch(_){}SW.c.style.transform=`translateX(${Math.max(-150,Math.min(150,SW.o+dx))}px)`}
function swUp(e){if(!SW)return;const s=SW;SW=null;const c=s.c;c.style.transition='';if(!s.m)return;const x=s.o+(e.clientX-s.x),v=x<-60?-144:x>60?144:0;c.style.transform=v?`translateX(${v}px)`:'';c.dataset.o=v;c.dataset.d=Date.now()}
function swTap(id){const c=document.querySelector(`.sw[data-g="${id}"] .sw-c`);if(c&&Date.now()-(+c.dataset.d||0)<300)return;if(c&&+c.dataset.o)return swClose();goalSheet(id)}
function goalDone(id){const g=S.goals.find(x=>x.id==id);if(!g)return;g.done=g.done?0:1;render();toast(g.done?'Goal marked done':'Goal reopened')}
function goalDel(id){S.goals=S.goals.filter(x=>x.id!=id);render();toast('Goal deleted')}
function goalSheet(id,m){const g=S.goals.find(x=>x.id==id);if(!g)return;openS(`<h2>${g.icon} ${esc(g.name)}</h2><p class="m">${php(g.saved)} of ${php(g.target)}</p><input id="ga" type="number" min="0" step="0.01" placeholder="Amount (${CS()})"><button class="btn ${m=='out'?'s':''}" onclick="gMove(${id},1)">Add money</button> <button class="btn ${m=='out'?'':'s'}" onclick="gMove(${id},-1)">Take out</button><p><button class="btn s" onclick="goalDone(${id});closeS()">${g.done?'Reopen goal':'Mark as done'}</button> <button class="btn s" onclick="sure(this,()=>{goalDel(${id});closeS()})">Delete</button></p>`);if(m)setTimeout(()=>{const e=$('#ga');if(e)e.focus()},80)}
function gMove(id,s){const a=Math.abs(+$('#ga').value);if(!a)return toast('Enter an amount');const g=S.goals.find(x=>x.id==id);if(!g)return;if(s<0&&a>g.saved)toast('Only the saved amount was taken out');g.saved=Math.max(0,g.saved+s*a);closeS();render();fx();toast(s>0?'Added to '+g.name:'Removed from '+g.name)}
/* ---- spending: clickable monthly bars */
let trendM=null;const mName=k=>new Date(+k.slice(0,4),+k.slice(5,7)-1,1).toLocaleDateString('en-PH',{month:'long'});
function spendTop(key){const tx=S.tx.filter(t=>t.d.startsWith(key)&&t.amt<0),gr={};tx.forEach(t=>{const c=CATS[t.cat]?t.cat:'Other';gr[c]=(gr[c]||0)-t.amt});
const total=sum(Object.values(gr)),items=Object.entries(gr).sort((a,b)=>b[1]-a[1]),circ=2*Math.PI*74;let off=0;
const arcs=items.map(([c,v])=>{const len=total?circ*v/total:0,dash=Math.max(0,len-3),r=`<circle cx="100" cy="100" r="74" fill="none" stroke="${spendCol(c)}" stroke-width="19" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${-off}"/>`;off+=len;return r}).join(''),
lg=items.length?items.map(([c,v])=>`<div class="spend-legend-row"><i class="spend-dot" style="background:${spendCol(c)}"></i><span class="spend-legend-name">${esc(c)}</span><b class="spend-legend-pct">${total?Math.round(v/total*100):0}%</b><span class="spend-legend-amt">${php(v)}</span></div>`).join(''):`<p class="m" style="font-size:13px">No expenses recorded in ${mName(key)}.</p>`,
bu=Object.values(S.budgets||{}).reduce((a,v)=>a+(+v||0),0),un=bu-total,
ins=bu?un>=0?{t:`You’re ${Math.round(un/bu*100)}% under budget`,b:`${php(un)} of your ${php(bu)} monthly budget remains.`,i:'🌱'}:{t:`You’re ${Math.round(Math.abs(un)/bu*100)}% over budget`,b:`You spent ${php(Math.abs(un))} beyond your ${php(bu)} monthly budget.`,i:'📈'}:{t:'Set a monthly budget',b:'Add category budgets in Plan to see how you’re tracking.',i:'🌱'};
return`<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><h2 style="margin:2px 0 0">Your Spending — ${mName(key)}</h2><span class="m" style="font-size:13px;white-space:nowrap">${key.slice(0,4)} · ${tx.length} ${tx.length==1?'expense':'expenses'}</span></div><div class="spend-overview"><div class="spend-donut-wrap"><svg class="spend-donut" viewBox="0 0 200 200" role="img" aria-label="Spending by category donut chart"><circle cx="100" cy="100" r="74" fill="none" stroke="var(--line)" stroke-width="19"/>${arcs}</svg><div class="spend-center"><b>${php(total)}</b><span>Total spent</span></div></div><div class="spend-legend" aria-label="Spending categories">${lg}</div></div></div><div class="spend-insight"><div style="display:flex;align-items:center;gap:12px"><span style="font-size:25px" aria-hidden="true">${ins.i}</span><div><b>${ins.t}</b><div class="m" style="font-size:13px;margin-top:3px">${ins.b}</div></div>${bu?'':`<button class="pill" style="margin-left:auto;flex:none" onclick="tab='Plan';pt='Budgets';render()" aria-label="Set a budget">›</button>`}</div></div>`}
function spendingChart(){const key=trendM||ym,tr=Array.from({length:6},(_,i)=>{const d=new Date(T.getFullYear(),T.getMonth()-5+i,1),k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;return{k,label:d.toLocaleDateString('en-PH',{month:'short'}),value:-sum(S.tx.filter(t=>t.d.startsWith(k)&&t.amt<0).map(t=>t.amt)),now:i==5}}),mx=Math.max(...tr.map(x=>x.value),1);
return`<div id="sp-top">${spendTop(key)}</div><div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h2 style="margin:0">Spending trend</h2><span class="m" style="font-size:12px">Last 6 months</span></div><div class="spend-bars" role="group" aria-label="Monthly spending trend">${tr.map((x,i)=>`<div class="spend-bar-col ${x.k==key?'sel':''}" data-k="${x.k}" role="button" tabindex="0" aria-pressed="${x.k==key}" aria-label="${mName(x.k)} ${php(x.value)}" onclick="pickTrend('${x.k}')" onkeydown="if(event.key=='Enter'||event.key==' '){event.preventDefault();pickTrend('${x.k}')}"><span class="spend-total-label">${php(x.value)}</span><i class="spend-bar ${x.now?'now':''}" style="height:${Math.max(3,x.value/mx*76)}%;--delay:${i*55}ms"></i><span class="spend-month">${x.label}</span></div>`).join('')}</div></div>`}
function pickTrend(k){trendM=k==ym?null:k;const t=$('#sp-top');if(!t)return;t.innerHTML=spendTop(k);t.classList.remove('pg');void t.offsetWidth;t.classList.add('pg');document.querySelectorAll('.spend-bar-col').forEach(e=>{const on=e.dataset.k==k;e.classList.toggle('sel',on);e.setAttribute('aria-pressed',on)})}
/* ---- activity calendar: swipe between months */
let calBusy=0,calS=null,calAcc=0,calT=0,calWt;
function calGo(d){if(calBusy)return;const w=$('#calwrap');if(!w){cm+=d;render();return}calBusy=1;const tr='transform .22s ease,opacity .22s ease';w.style.transition=tr;w.style.transform=`translateX(${-d*48}px)`;w.style.opacity=0;
setTimeout(()=>{cm+=d;const h=document.createElement('div');h.innerHTML=calH();const n=h.firstElementChild;n.style.transform=`translateX(${d*48}px)`;n.style.opacity=0;w.replaceWith(n);requestAnimationFrame(()=>requestAnimationFrame(()=>{n.style.transition=tr;n.style.transform='';n.style.opacity=''}));setTimeout(()=>{n.style.transition='';calBusy=0},260)},200)}
function calDown(e){if(e.pointerType=='mouse'&&e.button)return;calS={x:e.clientX,y:e.clientY,h:0}}
function calMove(e){if(!calS||calBusy)return;const dx=e.clientX-calS.x,dy=e.clientY-calS.y;if(!calS.h){if(Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.5)calS.h=1;else if(Math.abs(dy)>10){calS=null;return}else return}const w=$('#calwrap');w.style.transition='none';w.style.transform=`translateX(${dx*.45}px)`}
function calUp(e){if(!calS)return;const s=calS;calS=null;const w=$('#calwrap');if(!s.h)return;const dx=e.clientX-s.x,stop=ev=>{ev.stopPropagation();ev.preventDefault()};w.addEventListener('click',stop,{capture:true,once:true});setTimeout(()=>w.removeEventListener('click',stop,true),80);
if(Math.abs(dx)>60)calGo(dx<0?1:-1);else{w.style.transition='transform .2s ease';w.style.transform=''}}
function calWheel(e){if(Math.abs(e.deltaX)<=Math.abs(e.deltaY)*1.2||Math.abs(e.deltaX)<3)return;e.preventDefault();calAcc+=e.deltaX;if(Math.abs(calAcc)>70&&!calBusy&&Date.now()-calT>550){calGo(calAcc>0?1:-1);calAcc=0;calT=Date.now()}clearTimeout(calWt);calWt=setTimeout(()=>calAcc=0,200)}
/* ---- settings: currency + data import / export */
function prefHtml(){return`<div class="eyebrow" style="margin:14px 0 6px">Currency</div><select onchange="setCur(this.value)">${Object.keys(CURS).map(k=>`<option value="${k}" ${(S.cur||'PHP')==k?'selected':''}>${k} (${CURS[k][0]})</option>`).join('')}</select><label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0"><span>Show decimals (${CS()}2.00)</span><input type="checkbox" style="width:auto;margin:0" ${S.dec?'checked':''} onchange="S.dec=this.checked?1:0;render();openSettings()"></label><p class="m" style="font-size:12px">Display only — your saved amounts are never converted.</p><div class="eyebrow" style="margin:14px 0 6px">Feedback</div><label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0"><span>Payment confirmation sound</span><input type="checkbox" style="width:auto;margin:0" ${S.snd!=0?'checked':''} onchange="S.snd=this.checked?1:0;render();openSettings()"></label><p class="m" style="font-size:12px">Plays a chime when you record a bill or card payment. Vibration is unaffected.</p>`}
function setCur(v){S.cur=v;render();openSettings()}
const hasPre=()=>{try{return!!localStorage.getItem('pera_pre')}catch(e){return false}};
function dataHtml(){return`<div class="eyebrow" style="margin:14px 0 6px">Data backup</div><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn s" onclick="expJSON()">Export backup (JSON)</button><button class="btn s" onclick="expCSV()">Export transactions (CSV)</button></div><input id="imf" type="file" accept=".json,.csv,application/json,text/csv" style="margin-top:8px" onchange="impRead(this)"><p class="m" style="font-size:12px">Import a JSON backup or a transactions CSV. You’ll see a preview and confirm before anything changes.</p>${hasPre()?'<button class="btn s" onclick="sure(this,impUndo)">Undo last import</button>':''}`}
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
function impPrev(){const I=IMP;let h;if(I.kind=='csv')h=`<h2>Import transactions</h2><p><b>${I.ok.length}</b> new · ${I.dup} duplicate${I.dup==1?'':'s'} skipped · ${I.bad.length} invalid</p>${I.bad.length?`<div class="card r" style="font-size:12px;white-space:pre-wrap">${esc(I.bad.slice(0,5).join('\n'))}${I.bad.length>5?`\n…and ${I.bad.length-5} more (skipped)`:''}</div>`:''}${I.ok.slice(0,4).map(x=>`<div class="row"><div class="f">${esc(x.t.note||x.t.cat)}<small>${x.t.d} · ${esc(acct(x.t.acct).name)}${x.st=='pending'?' · pending':''}</small></div><b class="${x.t.amt>0?'g':'r'}">${php(x.t.amt)}</b></div>`).join('')}<label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input id="adj" type="checkbox" checked style="width:auto;margin:0"> Apply posted rows to account balances</label>`;
else{const d=I.d,m=mergeCount(d);h=`<h2>Restore backup</h2><p class="m">File: ${d.accts.length} accounts · ${d.tx.length+d.pend.length} transactions · ${d.bills.length} bills · ${d.goals.length} goals · ${d.debts.length} debts</p><select id="imm"><option value="merge">Merge — add only what’s new (${m.a} accounts, ${m.t} transactions, ${m.b+m.g+m.db} bills/goals/debts)</option><option value="replace">Replace everything currently in the app</option></select><p class="m" style="font-size:12px">Merge skips duplicates and keeps your current balances. Replace swaps all current data (${S.accts.length} accounts, ${S.tx.length} transactions) for the file’s. A restore point is saved first.</p>`}
openS(h+`<button class="btn" ${I.kind=='csv'&&!I.ok.length?'disabled':''} onclick="impApply()">Confirm import</button> <button class="btn s" onclick="IMP=null;closeS()">Cancel</button>`)}
function impApply(){const I=IMP;if(!I)return;const snap=JSON.stringify(S);let n=0;try{
if(I.kind=='csv'){const adj=$('#adj').checked;I.ok.forEach(({t,st})=>{(st=='pending'?S.pend:S.tx).push(t);if(st!='pending'&&adj)bApply(t,1)});n=I.ok.length}
else if($('#imm').value=='replace'){S=JSON.parse(JSON.stringify(I.d));n=S.tx.length}
else{const d=I.d,have=new Set([...S.tx,...S.pend].map(t=>t.id)),sg=new Set([...S.tx,...S.pend].map(sig)),old=new Set(S.accts.map(a=>a.id));d.accts.forEach(a=>{if(!old.has(a.id))S.accts.push(a)});
[...d.tx.map(t=>[t,0]),...d.pend.map(t=>[t,1])].forEach(([t,p])=>{if(have.has(t.id)||sg.has(sig(t)))return;(p?S.pend:S.tx).push(t);if(!p&&old.has(t.acct))bApply(t,1);n++});
['bills','goals','debts'].forEach(k=>{S[k]=S[k]||[];d[k].forEach(x=>{if(!S[k].some(y=>y.id==x.id))S[k].push(x)})});d.xfer.forEach(x=>{if(!old.has(x.to)&&!S.xfer.some(y=>y.id==x.id))S.xfer.push(x)});Object.keys(d.budgets).forEach(k=>{if(S.budgets[k]==null)S.budgets[k]=d.budgets[k]})}
try{localStorage.setItem('pera_pre',snap)}catch(e){}IMP=null;closeS();render();toast(n+' record'+(n==1?'':'s')+' imported')}catch(e){S=JSON.parse(snap);IMP=null;save();render();toast('Import failed — your data was not changed')}}
function impUndo(){try{S=JSON.parse(localStorage.getItem('pera_pre'));localStorage.removeItem('pera_pre');render();openSettings();toast('Restored the data from before the last import')}catch(e){toast('Nothing to restore')}}



function bindStaticEvents() {
  document.getElementById("add-entry-button").addEventListener("click", () => openTx());
  document.getElementById("ai").addEventListener("keydown", (event) => {
    if (event.key === "Enter") aiGo();
  });
  document.getElementById("send-entry-button").addEventListener("click", () => aiGo());
  document.getElementById("settings-button").addEventListener("click", () => openSettings());
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
      p.innerHTML=[...s.options].map((o,i)=>{const a=acctOf(o.value);
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
