/* ==========================================================================
   Activity — the date scope: All dates / Day / Week / Month / Year.

   The scope used to sit on the page as a full-width selector. It now lives in
   the ••• popup that the Accounts tab already uses, so Activity keeps the type
   filters as the only control row and the two menus read as a single system:

       All  Expenses  Income  Transfers  Upcoming            ⋯
       current period · entry count

   The popup reuses the Accounts component wholesale — .account-heading,
   .account-options-button, .account-options-menu, .ao-check, .ao-icon,
   .ao-body and @keyframes accountMenuIn (css/account-options.css). Only the
   date grids are new, because the Accounts menu has no equivalent for them.

   Nothing is read until call time, so the only load-order rule is that this
   file comes after app.js / transactions.js (index.html guarantees that) and
   that initActivityScope() runs after initTransactionV2().

     Activity()  re-implemented: the old "selected day" branch is gone (the
                 scope owns the period now) while the All/Expenses/Income/
                 Transfers/Upcoming pills keep filtering the same list.
     actList()   wrapped, so the period is applied before the rows are grouped.
     calH()      wrapped: a scope marks the calendar rather than editing it —
                 every day keeps its entries and the month header, Today and
                 ‹ › stay put; the week gets a tint, days outside the period
                 get dimmed dates, and Year swaps in twelve month tiles.
     calGo()     wrapped: a swipe (or the calendar arrows) steps the period.
     calToday()  added: Today moves the period, not just the grid offset.
     scopeClear() added: the ••• menu can release the selection — "Clear dates"
                 — instead of making you walk back to the All dates row.
   ========================================================================== */
function initActivityScope() {
  if (window.__ascope) return;
  window.__ascope = 1;

  const P2 = n => String(n).padStart(2, "0");
  const isoD = d => `${d.getFullYear()}-${P2(d.getMonth() + 1)}-${P2(d.getDate())}`;
  const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const D = k => new Date(k + "T00:00:00");
  const shortM = d => d.toLocaleDateString("en-PH", { month: "short" });
  const longM = d => d.toLocaleDateString("en-PH", { month: "long" });
  const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* The app's own switch (Settings → animations) counts as reduced motion for
     the day-select motion; RM() itself is left alone so the existing swipe and
     rise behaviour is untouched. */
  const RMA = () => RM() || S.rm === 1 || S.anim === 0;
  const MODES = ["all", "day", "week", "month", "year"];
  const NAMES = { all: "All dates", day: "Day", week: "Week", month: "Month", year: "Year" };
  const el = id => document.getElementById(id);

  /* The scope lives in memory only: leaving Activity and coming back keeps the
     period you were reading, but a reload starts clean on All. */
  window.ASC = { mode: "all", anchor: today };

  /* Popup state. Rendered markup is a pure function of these, and every
     re-render (filter change, search, period step) puts the menu back on page
     one, closed — which is also what makes a rebuilt node impossible to leave
     stale. */
  let open = false,
    stage = 1,
    pmode = "month",
    py = 0,
    pm = 0,
    wy = 0;

  /* Body-level singleton menu — created once, appended to document.body.
     The button remains in #app and toggles this menu. */
  let scopeMenu = null;
  function ensureScopeMenu() {
    if (scopeMenu) return scopeMenu;
    scopeMenu = document.createElement("div");
    scopeMenu.id = "activity-options-menu";
    scopeMenu.className = "account-options-menu";
    scopeMenu.setAttribute("role", "menu");
    scopeMenu.setAttribute("aria-label", "Date range");
    scopeMenu.hidden = true;
    document.body.appendChild(scopeMenu);
    return scopeMenu;
  }

  /* Calendar-only visibility. This deliberately never touches S or the
     transaction list: it is just a presentation filter that lasts while the
     Activity tab remains mounted. */
  const calVis = { o: true, i: true, b: true };
  const calVisType = k => (k === "s" || k === "u" ? "b" : k);

  function calLegend() {
    const items = [
      ["o", "Spending", "#ff453a"],
      ["i", "Income", "#30d158"],
      ["b", "Bills & card dates", "#ffd60a"],
    ];
    return `<p class="m cal-legend" role="group" aria-label="Calendar event visibility">${items
      .map(
        ([k, label, color]) =>
          `<button type="button" data-cal-kind="${k}" class="cal-legend-item${calVis[k] ? "" : " off"}" aria-pressed="${calVis[k]}" onclick="toggleCalVisibility('${k}')"><i style="background:${color}"></i><span>${label}</span></button>`,
       )
       .join("")}</p>`;
  }

  function syncCalVisibility(root) {
    const scope = root || document;
    scope.querySelectorAll(".acal .ap").forEach(e => {
      const k = calVisType([...e.classList].find(x => ["o", "i", "s", "u"].includes(x)) || "");
      e.classList.toggle("cal-hidden", !!k && !calVis[k]);
      e.setAttribute("aria-hidden", !!k && !calVis[k] ? "true" : "false");
    });
    const legend = scope.querySelector(".cal-legend");
    if (legend) {
      legend.querySelectorAll(".cal-legend-item").forEach(b => {
        const k = b.getAttribute("data-cal-kind") || (b.getAttribute("onclick") || "").match(/'([^']+)'/)?.[1];
        if (!k || !calVis[k]) b.classList.toggle("off", true);
        else b.classList.toggle("off", false);
        b.setAttribute("aria-pressed", String(!!calVis[k]));
      });
    }
  }

  window.toggleCalVisibility = k => {
    if (!Object.prototype.hasOwnProperty.call(calVis, k)) return;
    calVis[k] = !calVis[k];
    syncCalVisibility();
  };
  /* ---------------------------------------------------------------- period */

  function range() {
    if (ASC.mode === "all") return null;
    const a = D(ASC.anchor);
    if (ASC.mode === "day") return { from: ASC.anchor, to: ASC.anchor };
    if (ASC.mode === "week") {
      const s = addD(a, -a.getDay()); /* weeks run Sunday → Saturday, like the grid */
      return { from: isoD(s), to: isoD(addD(s, 6)) };
    }
    if (ASC.mode === "month")
      return {
        from: isoD(new Date(a.getFullYear(), a.getMonth(), 1)),
        to: isoD(new Date(a.getFullYear(), a.getMonth() + 1, 0)),
      };
    return { from: `${a.getFullYear()}-01-01`, to: `${a.getFullYear()}-12-31` };
  }
  window.ascRange = range;

  function fmtRange(r) {
    const f = D(r.from),
      t = D(r.to),
      fy = f.getFullYear(),
      ty = t.getFullYear();
    if (ASC.mode === "day")
      return f.toLocaleDateString("en-PH", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
    if (ASC.mode === "year") return String(fy);
    if (ASC.mode === "month") return f.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
    if (fy === ty && f.getMonth() === t.getMonth()) return `${shortM(f)} ${f.getDate()} – ${t.getDate()}, ${ty}`;
    if (fy === ty) return `${shortM(f)} ${f.getDate()} – ${shortM(t)} ${t.getDate()}, ${ty}`;
    return `${shortM(f)} ${f.getDate()}, ${fy} – ${shortM(t)} ${t.getDate()}, ${ty}`;
  }

  /* Moving month by month always lands on the 1st, so stepping Oct -> Nov ->
     Dec -> Jan can never drift off a short month. */
  function shift(n) {
    const a = D(ASC.anchor);
    if (ASC.mode === "day") ASC.anchor = isoD(addD(a, n));
    else if (ASC.mode === "week") ASC.anchor = isoD(addD(a, 7 * n));
    else if (ASC.mode === "month") ASC.anchor = isoD(new Date(a.getFullYear(), a.getMonth() + n, 1));
    else if (ASC.mode === "year") ASC.anchor = `${a.getFullYear() + n}-01-01`;
  }

  /* sel is the app's own "picked day" flag. Keeping it in step with a Day
     scope means the calendar's existing .sel highlight comes for free. */
  function selSync() {
    sel = ASC.mode === "day" ? ASC.anchor : "";
  }

  /* Point the month grid at the period being viewed, so stepping through
     October -> November actually moves the grid. */
  function alignCal() {
    if (ASC.mode === "all" || ASC.mode === "year") return;
    // Browsing the timeline does not change the selected date/filter. A real
    // scope change still recentres on its anchor on the next render.
    if (timeline && timeline.w.isConnected && timeline.scopeKey === ASC.mode + '|' + ASC.anchor) {
      cm = timeline.offset;
      return;
    }
    const a = D(ASC.anchor);
    cm = (a.getFullYear() - T.getFullYear()) * 12 + (a.getMonth() - T.getMonth());
  }

  /* Switching mode keeps you where you were; a month/year anchor only falls
     back to today when today still lives inside it (so Year 2026 -> Month
     opens on October, not January). */
  function anchorFor(mode) {
    const a = D(ASC.anchor || today),
      y = a.getFullYear(),
      m = a.getMonth(),
      d = a.getDate(),
      t = D(today);
    if (mode === "day" || mode === "week") {
      if (d === 1 && t.getFullYear() === y && t.getMonth() === m) return today;
      return isoD(a);
    }
    if (mode === "month") {
      if (m === 0 && d === 1 && t.getFullYear() === y) return today;
      return isoD(new Date(y, m, 1));
    }
    return `${y}-01-01`;
  }

  /* ------------------------------------------------------- the opener line */

  function tallyShort(l) {
    if (filt === "Upcoming") {
      const r=range(),pending=(S.pend||[]).filter(t=>(!r||t.d>=r.from&&t.d<=r.to)&&(!q||(t.note+(t.desc||'')+t.cat+Math.abs(t.amt)).toLowerCase().includes(q.toLowerCase()))).length;
      const n = upDays().reduce((a, x) => a + x.l.length, 0) + pending;
      return n ? `${n} pending / scheduled` : "nothing scheduled";
    }
    const n = l.length;
    return `${n} ${n === 1 ? "entry" : "entries"}`;
  }

  function periodLabel() {
    if (ASC.mode === "all") return filt === "Upcoming" ? "Pending & next 45 days" : "All dates";
    return fmtRange(range());
  }

  /* The period caption. It keeps its own line so the ••• can ride the type
     filters above it. */
  function headHTML() {
    const l = actList(),
      on = ASC.mode !== "all";
    return (
      `<div class="as-head">` +
      `<span class="as-cur${on ? " on" : ""}"><b>${esc(periodLabel())}</b><small>${esc(tallyShort(l))}</small></span>` +
      `</div>`
    );
  }

  /* The opener — the Accounts ••• button — placed on the pills
     row, flush right, directly above the column of daily totals.
     The menu is a body-level singleton created by ensureScopeMenu(). */
  function openerHTML() {
    const on = ASC.mode !== "all";
    return `<button id="activity-options-button" class="pill account-options-button${on ? " on" : ""}" aria-label="Date range" aria-haspopup="menu" aria-expanded="false" onclick="toggleScopeMenu()">&#8943;</button>`;
  }

  /* -------------------------------------------------------------- popup UI */

  const SVG = d =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const CAL = '<rect x="3.2" y="5" width="17.6" height="15.2" rx="3.4"/><path d="M3.2 9.8h17.6M8 3.4v3.2M16 3.4v3.2"/>';
  const ICO = {
    all: SVG(CAL),
    day: SVG(CAL + '<circle cx="12" cy="15.3" r="2.1" fill="currentColor" stroke="none"/>'),
    week: SVG(CAL + '<rect x="5.8" y="12.4" width="12.4" height="2.7" rx="1.35" fill="currentColor" stroke="none"/>'),
    month: SVG(
      '<rect x="3.4" y="3.4" width="7.2" height="7.2" rx="2"/><rect x="13.4" y="3.4" width="7.2" height="7.2" rx="2"/><rect x="3.4" y="13.4" width="7.2" height="7.2" rx="2"/><rect x="13.4" y="13.4" width="7.2" height="7.2" rx="2"/>',
    ),
    year: SVG(
      '<rect x="3.4" y="4.2" width="17.2" height="16.2" rx="3.4"/><path d="M3.4 8.8h17.2"/><path d="M7.4 12.6h3M13.8 12.6h3M7.4 16.4h6.8"/>',
    ),
    back: SVG('<path d="M14.4 5.4 7.8 12l6.6 6.6"/>'),
    left: SVG('<path d="M14.4 5.4 7.8 12l6.6 6.6"/>'),
    right: SVG('<path d="M9.6 5.4 16.2 12l-6.6 6.6"/>'),
    clear: SVG('<circle cx="12" cy="12" r="8.4"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>'),
  };

  function body(html) {
    return `<div class="ao-body">${html}</div>`;
  }
  function row(on, icon, label, action, tail) {
    return (
      `<button type="button" role="menuitemradio" aria-checked="${on ? "true" : "false"}" onclick="${action}">` +
      `<span class="ao-check">${on ? "✓" : ""}</span>` +
      `<span class="ao-icon" aria-hidden="true">${icon}</span>` +
      `<span class="ao-label">${label}</span>${tail || ""}</button>`
    );
  }
  function arrow(d) {
    return (
      `<button type="button" class="ao-arrow" data-d="${d}" aria-label="${d < 0 ? "Previous" : "Next"}"` +
      ` onclick="scopeBrowse(${d})">${d < 0 ? ICO.left : ICO.right}</button>`
    );
  }
  function navbar(label) {
    return `<div class="ao-nav">${arrow(-1)}<b>${label}</b>${arrow(1)}</div>`;
  }
  function backRow() {
    return `<button type="button" class="ao-back" onclick="scopeBack()"><span class="ao-icon" aria-hidden="true">${ICO.back}</span><span class="ao-label">Date range</span></button>`;
  }
  const SEP = '<div role="separator"></div>';

  /* Clearing is its own action, not a sixth mode: it drops the period back to
     All dates and releases the calendar's picked day, so the selection can be
     undone from wherever in the menu you happen to be. The tag names the
     selection that will go. */
  function clearTag() {
    const a = D(ASC.anchor || today);
    if (ASC.mode === "day") return a.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
    if (ASC.mode === "month") return `${shortM(a)} ${a.getFullYear()}`;
    if (ASC.mode === "year") return String(a.getFullYear());
    const f = D(range().from),
      t = D(range().to);
    return `${shortM(f)} ${f.getDate()}–${t.getDate()}`;
  }
  /* Nothing selected means nothing to clear, so the row is simply absent. */
  function clearRow() {
    if (ASC.mode === "all") return "";
    return (
      `<button type="button" class="ao-clear" role="menuitem" onclick="scopeClear()">` +
      `<span class="ao-icon" aria-hidden="true">${ICO.clear}</span>` +
      `<span class="ao-label">Clear dates</span>` +
      `<span class="ao-tag">${clearTag()}</span></button>`
    );
  }

  function modePage() {
    const rows = MODES.map(m => {
      const on = ASC.mode === m;
      return row(
        on,
        ICO[m],
        NAMES[m],
        `scopePick('${m}')`,
        m === "all" ? "" : '<span class="ao-go" aria-hidden="true">›</span>',
      );
    }).join("");
    const cl = clearRow();
    return body(`<p>Date range</p>${rows}${cl ? SEP + cl : ""}`);
  }

  function dayPage() {
    const st = new Date(py, pm, 1).getDay(),
      n = new Date(py, pm + 1, 0).getDate(),
      cells = Math.ceil((st + n) / 7) * 7;
    let grid = "";
    for (let i = 0; i < cells; i++) {
      const d = addD(new Date(py, pm, 1 - st), i),
        k = isoD(d),
        on = ASC.mode === "day" && ASC.anchor === k;
      grid +=
        `<button type="button" class="ao-d${d.getMonth() !== pm ? " x" : ""}${k === today ? " t" : ""}${on ? " on" : ""}"` +
        ` aria-pressed="${on ? "true" : "false"}" aria-current="${k === today ? "date" : "false"}"` +
        ` aria-label="${d.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}"` +
        ` onclick="scopeDay('${k}')">${d.getDate()}</button>`;
    }
    return body(
      backRow() +
        SEP +
        row(ASC.mode === "day" && ASC.anchor === today, ICO.day, "Today", `scopeDay('${today}')`) +
        (ASC.mode === "day" ? clearRow() : "") +
        navbar(`${longM(new Date(py, pm, 1))} ${py}`) +
         `<div class="ao-dow">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(x => `<span>${x}</span>`).join("")}</div>` +
        `<div class="ao-days">${grid}</div>`,
    );
  }

  function weekLabel(s, e) {
    const sy = s.getFullYear(),
      ey = e.getFullYear();
    if (sy !== ey) return `${shortM(s)} ${s.getDate()}, ${sy} – ${shortM(e)} ${e.getDate()}, ${ey}`;
    if (s.getMonth() !== e.getMonth()) return `${shortM(s)} ${s.getDate()} – ${shortM(e)} ${e.getDate()}, ${ey}`;
    return `${shortM(s)} ${s.getDate()} – ${e.getDate()}, ${ey}`;
  }

  function weekPage() {
    const last = new Date(py, pm + 1, 0).getTime(),
      st = new Date(py, pm, 1).getDay(),
      cur = ASC.mode === "week" ? range().from : "",
      thisWk = isoD(addD(D(today), -D(today).getDay()));
    let s = addD(new Date(py, pm, 1), -st),
      rows = "";
    while (s.getTime() <= last) {
      const e = addD(s, 6),
        k = isoD(s);
      rows += row(
        cur === k,
        "",
        weekLabel(s, e),
        `scopeWeek('${k}')`,
        thisWk === k ? '<span class="ao-tag">this week</span>' : "",
      );
      s = addD(s, 7);
    }
    return body(
      backRow() +
        SEP +
        row(ASC.mode === "week" && ASC.anchor === thisWk, ICO.week, "This week", `scopeWeek('${thisWk}')`) +
        (ASC.mode === "week" ? clearRow() : "") +
        navbar(`${longM(new Date(py, pm, 1))} ${py}`) +
        `<div class="ao-list">${rows}</div>`,
    );
  }

  function monthPage() {
    const Y = py,
      cur = ASC.mode === "month" ? range().from : "";
    let tiles = "";
    for (let m = 0; m < 12; m++) {
      const on = cur === isoD(new Date(Y, m, 1));
      tiles += `<button type="button" class="ao-tile${on ? " on" : ""}" aria-pressed="${on ? "true" : "false"}" onclick="scopeMonth(${Y},${m})">${shortM(new Date(Y, m, 1))}</button>`;
    }
    return body(
      backRow() +
        SEP +
        navbar(Y) +
        (ASC.mode === "month" ? clearRow() : "") +
        `<div class="ao-tiles">${tiles}</div>`,
    );
  }

  function yearPage() {
    const cur = ASC.mode === "year" ? +ASC.anchor.slice(0, 4) : 0;
    let tiles = "";
    for (let i = 0; i < 9; i++) {
      const Y = wy + i,
        on = cur === Y;
      tiles += `<button type="button" class="ao-tile${on ? " on" : ""}" aria-pressed="${on ? "true" : "false"}" onclick="scopeYear(${Y})">${Y}</button>`;
    }
    return body(
      backRow() +
        SEP +
        navbar(`${wy}–${wy + 8}`) +
        (ASC.mode === "year" ? clearRow() : "") +
        `<div class="ao-tiles">${tiles}</div>`,
    );
  }

  function menuHTML() {
    if (stage !== 2) return modePage();
    if (pmode === "day") return dayPage();
    if (pmode === "week") return weekPage();
    if (pmode === "year") return yearPage();
    return monthPage();
  }

  /* The Date range menu is anchored to its ••• trigger, not to a guessed page
     offset. Right-aligned below is the preferred placement; it flips above and
     clamps horizontally when the viewport would clip it. Fixed positioning is
     used only while open so scrolling or resizing can re-anchor it. */
  function positionScopeMenu() {
    ensureScopeMenu();
    const m = scopeMenu,
      b = el("activity-options-button");
    if (!m || m.hidden || !b) return;
    const margin = 8,
      gap = 6,
      vw = window.innerWidth,
      vh = window.innerHeight,
      tr = b.getBoundingClientRect();
    m.style.position = "fixed";
    m.style.right = "auto";
    m.style.maxWidth = Math.max(0, vw - margin * 2) + "px";
    const mw = m.offsetWidth,
      mh = m.offsetHeight;
    let left = tr.right - mw;
    left = Math.max(margin, Math.min(left, vw - margin - mw));
    let top = tr.bottom + gap;
    if (top + mh > vh - margin) top = tr.top - mh - gap;
    top = Math.max(margin, Math.min(top, vh - margin - mh));
    m.style.left = Math.round(left) + "px";
    m.style.top = Math.round(top) + "px";
  }
  window.positionScopeMenu = positionScopeMenu;

  /* Repainting the body swaps the page inside the same popup, so the swap
     gets the component's own entrance animation for free. */
  function paint(focus) {
    const m = ensureScopeMenu(),
      b = el("activity-options-button");
    m.innerHTML = menuHTML();
    m.hidden = !open;
    if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      positionScopeMenu();
      requestAnimationFrame(positionScopeMenu);
      if (focus) {
        const f = m.querySelector("button");
        if (f) f.focus({ preventScroll: true });
      }
    }
  }

  function closeMenu(focus) {
    open = false;
    const m = scopeMenu,
      b = el("activity-options-button");
    if (m) m.hidden = true;
    if (b) {
      b.setAttribute("aria-expanded", "false");
      if (focus) b.focus({ preventScroll: true });
    }
  }

  function seedPick() {
    const a = D(ASC.anchor || today);
    py = a.getFullYear();
    pm = a.getMonth();
    wy = a.getFullYear() - 4;
  }

  /* ------------------------------------------------- day-select motion ----- */

  /* The tapped cell presses in and springs back bigger. Selection keeps the
     mounted grid, so the class goes straight on the live cell. */
  function popDay(k) {
    /* Two months can be visible at once, so animate the cell nearest the middle
       of the scroller rather than the first match in the strip. */
    const cells = [...document.querySelectorAll(`.cal-timeline .dc[data-k="${k}"]`)];
    const view = document.querySelector(".cal-timeline");
    let c = cells.find(x => x.closest(".cal-month-current"));
    if (!c && cells.length && view) {
      const v = view.getBoundingClientRect(), mid = v.top + v.height / 2;
      const dist = x => {
        const r = x.getBoundingClientRect();
        return Math.abs(r.top + r.height / 2 - mid);
      };
      c = cells.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    }
    if (!c) c = document.querySelector(`.acal .dc[data-k="${k}"]`);
    if (!c || RMA()) return;
    c.classList.remove("pop");
    void c.offsetWidth;
    c.classList.add("pop");
    c.addEventListener("animationend", () => c.classList.remove("pop"), { once: true });
    /* a cancelled animation fires no animationend: never leave the class behind */
    clearTimeout(c._popT);
    c._popT = setTimeout(() => c.classList.remove("pop"), 800);
  }

  /* The card below springs up and its rows trail after it. The class is dropped
     when the motion is done: the rows must keep their own long-press animation,
     and a finished .as-in/.cap-in must not replay when this one is removed. */
  function dayEnter() {
    const app = document.getElementById("app");
    if (!app || RMA()) return;
    /* the picked day's entries are the last group card in the list — while the
       scope is a single day there is only ever the one */
    const cards = [...app.children].filter(
      n => n.tagName === "DIV" && n.classList.contains("card"),
    );
    const c = cards[cards.length - 1];
    if (!c) return;
    c.classList.remove("day-card", "day-enter", "as-in", "cap-in");
    void c.offsetWidth;
    c.classList.add("day-card", "day-enter");
    clearTimeout(c._dayEnter);
    c._dayEnter = setTimeout(() => c.classList.remove("day-card", "day-enter"), 900);
  }

  /* -------------------------------------------------------------- actions */

  window.toggleScopeMenu = () => {
    /* a period step animates in over ~190ms; finish it first, or the opener
       would be talking to a node that is about to be swapped out */
    settleNow();
    if (!el("activity-options-button")) return;
    ensureScopeMenu();
    open = !open;
    if (open) {
      stage = 1;
      seedPick();
    }
    paint(true);
  };

  /* A scope change is a real page change: the calendar is rebuilt, not just
     the list, so the dimmed days and the tiles stay honest. */
  function applyScope(mode, anchor) {
    ASC.mode = mode;
    if (anchor) ASC.anchor = anchor;
    selSync();
    closeMenu(false);
    refresh(0);
    /* choosing Day in the menu lands on a date: play the same motion there */
    if (mode === "day") {
      popDay(ASC.anchor);
      dayEnter();
    }
    const b = el("activity-options-button");
    if (b) b.focus({ preventScroll: true });
  }

  /* Deselect: back to All dates with no picked day. The calendar is left on the
     month you were reading, so the context stays on screen. */
  window.scopeClear = () => applyScope("all", today);

  window.scopePick = m => {
    if (m === "all") {
      applyScope("all", today);
      return;
    }
    pmode = m;
    stage = 2;
    seedPick();
    paint(true);
  };
  window.scopeBack = () => {
    stage = 1;
    paint(true);
  };
  window.scopeBrowse = d => {
    if (stage !== 2) return;
    if (pmode === "month") py += d;
    else if (pmode === "year") wy += 9 * d;
    else {
      const t = new Date(py, pm + d, 1);
      py = t.getFullYear();
      pm = t.getMonth();
    }
    paint(false);
    const a = document.querySelector(`#activity-options-menu .ao-arrow[data-d="${d}"]`);
    if (a) a.focus();
  };
  window.scopeDay = k => applyScope("day", k);
  window.scopeWeek = k => applyScope("week", k);
  window.scopeMonth = (y, m) => applyScope("month", isoD(new Date(y, m, 1)));
  window.scopeYear = y => applyScope("year", `${y}-01-01`);

  window.setScope = mode => {
    if (MODES.indexOf(mode) < 0) return;
    applyScope(mode, mode === "all" ? today : anchorFor(mode));
  };

  window.stepScope = n => {
    if (ASC.mode === "all") return;
    shift(n);
    selSync();
    refresh(n);
  };

  /* Selection is a paint operation: it never rebuilds or scrolls the timeline.
     The grid for a Day scope is the same month grid, so only the highlight (and
     any week/month dimming left by the previous scope) has to change. */
  function paintSelection() {
    const w = el("calwrap");
    if (!w) return;
    w.querySelectorAll(".dc[data-k]").forEach(c => {
      c.classList.toggle("sel", c.dataset.k === sel);
      c.classList.remove("off", "rng");
    });
  }

  window.pickDay = k => {
    const off = ASC.mode === "day" && ASC.anchor === k;
    if (off) ASC.mode = "all";
    else {
      ASC.mode = "day";
      ASC.anchor = k;
    }
    selSync();
    /* A pick changes the selection and the list only. Keeping the mounted
       timeline avoids both a rebuild and a re-centre, so a calendar resting
       between two months stays exactly there while a date in either month is
       chosen. */
    const t = timeline;
    if (t && t.w.isConnected && t.w === el("calwrap")) {
      t.scopeKey = ASC.mode + "|" + ASC.anchor;
      paintSelection();
      soft();
    } else refresh(0);
    /* picking a date plays the day-select motion; clearing one just springs
       the cell back (the CSS transition on .sel covers that half) */
    if (!off) {
      popDay(k);
      dayEnter();
    }
  };

  window.jumpMonth = (y, m) => applyScope("month", isoD(new Date(y, m, 1)));

  window.setFilt = f => {
    filt = f;
    soft();
  };

  /* ---------------------------------------------------------- integration */

  /* actList is the single source for the rows, so the period only has to be
     applied once - grouping, day totals and the Upcoming view all inherit it. */
  const actList0 = actList;
  window.actList = function () {
    const l = actList0.apply(this, arguments);
    const r = range();
    if (!r) return l;
    return l.filter(t => t.d >= r.from && t.d <= r.to);
  };

  /* Upcoming is normally "the next 45 days"; with a scope it becomes exactly
     the days inside the period, so the two controls genuinely compose. */
  const up0 = upGroups;
  function upDays() {
    const r = range() || { from: today, to: isoD(addD(D(today), 44)) };
    const out = [];
    for (let d = D(r.from); isoD(d) <= r.to && out.length < 400; d = addD(d, 1)) {
      const k = isoD(d),
        l = evs(k)
          .map((e, j) => [e, j])
          .filter(
            x =>
              x[0].kind !== "tx" &&
              x[0].kind !== "xfer" &&
              !(x[0].kind === "bill" && bPaid(S.bills.find(b => b.id === x[0].id), k)),
          );
      if (l.length) out.push({ k, l });
    }
    return out;
  }
  window.upGroups = function () {
    if (ASC.mode === "all") return up0.apply(this, arguments);
    const d = upDays();
    const r=range(),pending=pendingActivityHTML(r?.from,r?.to);
    return pending + (d.length
      ? d.map(x => grp(x.k, x.l.map(y => rowH(x.k, y[0], y[1])).join(""), "Planned")).join("")
      : pending?'':'<p class="m">Nothing planned in this period.</p>');
  };

  /* The calendar keeps all obligations. Activity All is posted history only;
     collection membership (S.tx vs S.pend), not a future date, defines status. */
  function allGroups() {
    return actGroups();
  }

  /* The Activity view itself. This replaces the old one so the "selected day"
     shortcut cannot bypass the pills, and it does two things the app's version
     cannot: the ••• rides the type-filter row (flush right, directly over the
     column of daily totals) and the period caption gets its own line above the
     list. */
  const actOld0 = actOld;
  window.Activity = function () {
    /* the menu is rebuilt with the page, so it always comes back closed */
    open = false;
    stage = 1;
    selSync();
    alignCal();
    let o = actOld0();
    o = o.replace(new RegExp('<p><b>[^<]*</b> <span class="g">.*?entries</span></p>'), "");
    /* the pills keep their own onclick, but must not wipe the chosen period */
    o = o.replace(/onclick="filt='([^']+)';sel='';(?:render|soft)\(\)"/g, (m, f) => `onclick="setFilt('${f}')"`);
    const i = o.lastIndexOf('<div class="card">'),
      tail = filt === "Upcoming" ? upGroups() : filt === "All" ? allGroups() : actGroups();
    /* front is everything above the list; its last bare <p> is the pills row.
       The row becomes a <div>: a <div class="as-pills"> is what keeps the menu
       (also a <div>) inside the positioned box instead of being hoisted out by
       the HTML parser, which is what a <p> would do. */
    let front = i < 0 ? o : o.slice(0, i);
    const pi = front.lastIndexOf("<p>"),
      pe = pi < 0 ? -1 : front.indexOf("</p>", pi);
    if (pi >= 0 && pe > pi)
      front =
        front.slice(0, pi) +
        '<div class="as-pills">' +
        front.slice(pi + 3, pe) +
        openerHTML() +
        "</div>" +
        front.slice(pe + 4);
    /* Today belongs to the period being viewed, not to the grid offset */
    front = front.replace(`onclick="cm=0;sel='';render()"`, `onclick="calToday()"`);
    return front + headHTML() + tail;
  };

  /* A scope marks the calendar, it does not edit it: the month header stays and
     every day keeps the entries it had. The week gets a tint, days outside the
     period get dimmed dates — but a Day scope leaves the grid completely alone,
     because a picked date should still read as the month you were looking at. */
  function scopeCal(h) {
    const r = range();
    if (!r) return h;
    h = h.replace('<div id="calwrap"', '<div id="calwrap" class="as-scoped"');
    /* a Day scope only highlights its date: the grid keeps its month shape */
    if (ASC.mode === "day") return h;
    /* The app's own "clear" link sets sel='' — but the scope decides the period
       now, so it would silently do nothing. Point it at All instead. */
    h = h.replace(
      /Showing [^<]*· <a href="#" onclick="sel='';render\(\);return false">clear<\/a>/,
      `<a href="#" onclick="setScope('all');return false">Show all dates</a>`,
    );
    const tint = ASC.mode === "week";
    const parts = h.split(/(?=<div class="dc)/);
    for (let i = 1; i < parts.length; i++) {
      const m = parts[i].match(/data-k="(\d{4}-\d{2}-\d{2})"/);
      if (!m) continue;
      const k = m[1];
      if (k >= r.from && k <= r.to) {
        if (tint) parts[i] = parts[i].replace(/^<div class="dc ([^"]*)"/, (mm, c) => `<div class="dc ${c.trim()} rng"`);
      } else {
        parts[i] = parts[i].replace(/^<div class="dc ([^"]*)"/, (mm, c) => `<div class="dc ${c.trim()} off"`);
      }
    }
    return parts.join("");
  }

  /* Add the interactive legend and the initial hidden state to a newly built
     calendar. Existing nodes are then updated in place by toggleCalVisibility,
     allowing CSS to animate the fade instead of replacing the calendar. */
  function decorateCal(h) {
    h = h.replace(/class="ap ([oisu])"/g, (m, k) => `class="ap ${k}${calVisType(k) && !calVis[calVisType(k)] ? " cal-hidden" : ""}"`);
    const start = h.indexOf('<p class="m" style="margin:0;padding:10px 4px;font-size:12px">');
    const end = h.lastIndexOf("</p></div>");
    if (start >= 0 && end > start) h = h.slice(0, start) + calLegend() + h.slice(end + 4);
    return h;
  }

  /* Year has no sensible day grid, so it becomes twelve month tiles. */
  function yearCal() {
    const Y = +ASC.anchor.slice(0, 4);
    const yl = S.tx.filter(t => t.d.slice(0, 4) === String(Y)),
      yi = sum(yl.filter(t => t.amt > 0).map(t => t.amt)),
      yo = -sum(yl.filter(t => t.amt < 0).map(t => t.amt));
    let cells = "";
    for (let m = 0; m < 12; m++) {
      const p = `${Y}-${P2(m + 1)}`,
        l = S.tx.filter(t => t.d.slice(0, 7) === p),
        out = -sum(l.filter(t => t.amt < 0).map(t => t.amt)),
        name = new Date(Y, m, 1).toLocaleDateString("en-PH", { month: "long" });
      cells +=
        `<button type="button" class="as-ym" onclick="jumpMonth(${Y},${m})" aria-label="${name} ${Y}, ${l.length} ${l.length === 1 ? "entry" : "entries"}">` +
        `<b>${shortM(new Date(Y, m, 1))}</b><small>${l.length ? php(out) : "—"}</small>` +
        `<span class="as-ym-n">${l.length}</span></button>`;
    }
    /* The year view keeps the same header as the month grid: the year, its
       totals, and Today / ‹ › so the period can still be stepped from here. */
    return (
      `<div id="calwrap" class="as-scoped as-year" style="padding:6px 0 0;touch-action:pan-y"` +
      ` onpointerdown="calDown(event)" onpointermove="calMove(event)" onpointerup="calUp(event)"` +
      ` onpointercancel="calUp(event)" onwheel="calWheel(event)">` +
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:0 4px 10px;gap:8px;flex-wrap:wrap">` +
      `<div style="font-size:28px;font-weight:700">${Y}<div style="font-size:14px;font-weight:500;margin-top:2px">` +
      `<span class="g">+${php(yi)}</span> <span class="m">·</span> <span class="r">−${php(yo)}</span> <span class="m">· ${yl.length} ${yl.length === 1 ? "entry" : "entries"}</span>` +
      `</div></div>` +
      `<span><button class="pill" style="border:0" onclick="calToday()">Today</button> <button class="pill" onclick="calGo(-1)">‹</button> <button class="pill" onclick="calGo(1)">›</button></span>` +
      `</div><div class="as-ygrid">${cells}</div></div>`
    );
  }

  const cal0 = calH;
  window.calH = function () {
    if (ASC.mode === "year") return yearCal();
    const h = cal0.apply(this, arguments);
    return decorateCal(ASC.mode === "all" ? h : scopeCal(h));
  };

  /* Swiping (or the calendar arrows) steps the period while a scope is active,
     and keeps browsing months when All is selected. */
  const calGo0 = calGo;
  window.calGo = function (d) {
    if (ASC.mode === "all" && timelineGo(cm + d)) return;
    if (ASC.mode === "all") return calGo0.apply(this, arguments);
    window.stepScope(d);
  };

  /* The app's Today button resets the grid offset. While a scope is active the
     period is what moves, so Today goes to the period that contains today. */
  window.calToday = () => {
    if (ASC.mode === "all") {
      if (timelineGo(0)) return;
      cm = 0;
      sel = "";
      render();
    } else applyScope(ASC.mode, today);
  };

  /* ---------------------------------------------------------------- paint */

  /* Rebuild the calendar and the list, but leave the search field mounted: no
     page reload, no re-created input, and the opener line can animate. */
  let pend = null;
  /* Rapid taps must not stack two swaps on the same calendar node, or the list
     would be appended twice. Finishing the in-flight swap first keeps the DOM
     consistent before the next one reads it. */
  function settleNow() {
    if (!pend) return;
    clearTimeout(pend.t);
    const s = pend.swap;
    pend = null;
    s();
  }
  function refresh(dir) {
    settleNow();
    if (tab !== "Activity") {
      render();
      return;
    }
    const app = document.getElementById("app"),
      w = document.getElementById("calwrap");
    if (!app || !w) {
      render();
      return;
    }
    alignCal();
    const tmp = document.createElement("div");
    tmp.innerHTML = Activity();
    const nw = tmp.querySelector("#calwrap");
    if (!nw) {
      render();
      return;
    }
    const tail = [];
    for (let n = nw.nextSibling; n; ) {
      const x = n.nextSibling;
      tail.push(n);
      n = x;
    }
    const slide = dir && !RM() && w.classList.contains('as-year');
    if (slide) {
      w.style.transition = "transform .19s ease,opacity .19s ease";
      w.style.transform = `translateX(${-dir * 44}px)`;
      w.style.opacity = 0;
    }
    const swap = () => {
      if (slide) {
        nw.style.transform = `translateX(${dir * 44}px)`;
        nw.style.opacity = 0;
      }
      w.replaceWith(nw);
      for (let s = nw.nextSibling; s; ) {
        const x = s.nextSibling;
        s.remove();
        s = x;
      }
      tail.forEach(n => app.appendChild(n));
      ensureTimeline();
      if (slide) {
        const done = () => {
          nw.style.transition = "";
          nw.style.transform = "";
          nw.style.opacity = "";
        };
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            nw.style.transition = "transform .22s ease,opacity .22s ease";
            nw.style.transform = "";
            nw.style.opacity = "";
            setTimeout(() => (nw.style.transition = ""), 260);
          }),
        );
        /* safety net: if frames never arrive the calendar must still be visible */
        setTimeout(done, 340);
      }
      rise();
    };
    if (slide)
      pend = {
        t: setTimeout(() => {
          pend = null;
          swap();
        }, 190),
        swap,
      };
    else swap();
  }

  /* The list rises in a beat after the period changes. The opener line is left
     out on purpose: it is the feedback for the change, so it must be readable
     the instant the period moves. */
  function rise() {
    const app = document.getElementById("app");
    if (!app || RM()) return;
    let i = 0;
    Array.prototype.forEach.call(app.children, n => {
      if (n.id === "calwrap" || n.classList.contains("as-head")) return;
      if (n.tagName === "H1" || n.classList.contains("sr-wrap")) return;
      n.classList.add("as-in");
      n.style.setProperty("--i", Math.min(i++, 5));
    });
  }

  /* -------------------------------------------- legacy year-period gesture */

  /* The calendar moves like a vertical strip: the current month and the
     adjacent month share one clipped stage, so the outgoing grid slides out
     while the next one physically enters. The threshold is per gesture and the
     settle lock prevents one flick from skipping months. */
  const G_AXIS = 10,
    G_COMMIT = 56,
    G_LOCK = 420;
  let g = null,
    vBusy = false,
    vLock = 0;

  /* Build the adjacent month without mutating the canonical scope state. */
  function shiftedCal(dir) {
    const anchor = ASC.anchor,
      savedCm = cm,
      savedSel = sel;
    if (ASC.mode === "all") cm += dir;
    else {
      shift(dir);
      alignCal();
    }
    let node = null;
    try {
      const tmp = document.createElement("div");
      tmp.innerHTML = Activity();
      node = tmp.querySelector("#calwrap");
    } finally {
      ASC.anchor = anchor;
      cm = savedCm;
      sel = savedSel;
    }
    return node;
  }

  function applyCalShift(dir) {
    if (ASC.mode === "all") cm += dir;
    else {
      shift(dir);
      selSync();
      alignCal();
    }
  }

  function makeStage(dir) {
    const w = el("calwrap");
    if (!w) return null;
    const h = w.offsetHeight,
      n = shiftedCal(dir);
    if (!h || !n) return null;
    const stage = document.createElement("div");
    stage.className = "cal-vstage";
    stage.style.height = h + "px";
    w.parentNode.insertBefore(stage, w);
    w.removeAttribute("id");
    w.classList.add("cal-vpage", "cal-vpage-old");
    stage.appendChild(w);
    n.removeAttribute("id");
    n.classList.add("cal-vpage", "cal-vpage-new");
    n.style.top = (dir > 0 ? h : -h) + "px";
    stage.appendChild(n);
    return { stage, w, n, h, dir };
  }

  function dropStage(s, commit) {
    if (!s) return;
    if (commit) {
      /* The prebuilt page was a preview; the canonical page is rebuilt from the
         committed state so the list, legend and scope marks all agree. */
      applyCalShift(s.dir);
      const tmp = document.createElement("div");
      tmp.innerHTML = Activity();
      const fresh = tmp.querySelector("#calwrap");
      if (!fresh) {
        s.stage.replaceWith(s.w);
        return;
      }
      const tail = [];
      for (let n = fresh.nextSibling; n; ) {
        const x = n.nextSibling;
        tail.push(n);
        n = x;
      }
      s.stage.replaceWith(fresh);
      for (let n = fresh.nextSibling; n; ) {
        const x = n.nextSibling;
        n.remove();
        n = x;
      }
      tail.forEach(n => el("app").appendChild(n));
      rise();
    } else {
      s.w.id = "calwrap";
      s.w.classList.remove("cal-vpage", "cal-vpage-old");
      s.w.style.transform = "";
      s.w.style.transition = "";
      s.stage.replaceWith(s.w);
      s.n.remove();
    }
    vBusy = false;
  }

  /* A click is the tail of a drag, not a date/marker pick. */
  function swallowClick(w) {
    if (!w) return;
    const stop = ev => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    w.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => w.removeEventListener("click", stop, true), 90);
  }

  function gestureStart(x, y, kind, target) {
    // Month view belongs to the native scrolling timeline below, not the
    // legacy threshold/page transition (retained only for the year view).
    if (el('calwrap')?.querySelector('.cal-timeline')) return;
    if (vBusy || Date.now() - vLock < G_LOCK) return;
    if (!el("calwrap") || (target && target.closest && target.closest("button,a"))) return;
    g = { x, y, kind, axis: 0, dx: 0, dy: 0, s: null };
  }

  function gestureMove(x, y, ev) {
    if (!g) return;
    const dx = x - g.x,
      dy = y - g.y;
    if (!g.axis) {
      if (Math.abs(dy) > G_AXIS && Math.abs(dy) > Math.abs(dx) * 1.1) g.axis = "y";
      else if (Math.abs(dx) > G_AXIS && Math.abs(dx) > Math.abs(dy) * 1.5) g.axis = "x";
      else return;
    }
    g.dx = dx;
    g.dy = dy;
    if (g.axis === "y") {
      if (ev && ev.cancelable) ev.preventDefault();
      if (RMA()) return;
      if (!g.s) g.s = makeStage(dy < 0 ? 1 : -1);
      if (g.s) {
        const limit = g.s.h * 0.72;
        g.s.stage.style.transition = "none";
        g.s.stage.style.transform = `translateY(${Math.max(-limit, Math.min(limit, dy * 0.62))}px)`;
      }
    } else {
      const w = el("calwrap");
      if (w && !g.s) {
        w.style.transition = "none";
        w.style.transform = `translateX(${dx * 0.45}px)`;
      }
    }
  }

  function gestureEnd() {
    if (!g) return;
    const it = g;
    g = null;
    if (!it.axis) return;
    const w = el("calwrap") || (it.s && it.s.w);
    if (it.axis === "x") {
      if (Math.abs(it.dx) > 60) {
        swallowClick(w);
        calGo(it.dx < 0 ? 1 : -1);
      } else if (w) {
        w.style.transition = "transform .2s ease";
        w.style.transform = "";
      }
      return;
    }
    const commit = Math.abs(it.dy) >= G_COMMIT;
    if (!it.s) {
      /* Reduced motion: no strip, but the same threshold and canonical state. */
      if (commit) {
        swallowClick(w);
        applyCalShift(it.dy < 0 ? 1 : -1);
        vBusy = true;
        refresh(0);
        vLock = Date.now();
        setTimeout(() => (vBusy = false), G_LOCK);
      }
      return;
    }
    const s = it.s;
    vBusy = true;
    swallowClick(s.w);
    if (commit) {
      s.stage.style.transition = "transform .28s cubic-bezier(.22,.8,.28,1)";
      s.stage.style.transform = `translateY(${-s.dir * s.h}px)`;
      vLock = Date.now();
      setTimeout(() => dropStage(s, true), 290);
    } else {
      s.stage.style.transition = "transform .22s cubic-bezier(.2,.8,.2,1)";
      s.stage.style.transform = "translateY(0)";
      setTimeout(() => dropStage(s, false), 230);
    }
  }

  window.calDown = function (e) {
    if (e.pointerType === "touch") return;
    if (e.pointerType === "mouse" && e.button) return;
    gestureStart(e.clientX, e.clientY, "pointer", e.target);
    if (g && e.pointerId != null) {
      try {
        e.target.setPointerCapture(e.pointerId);
      } catch (_) {
        /* pointer capture is an optimisation, not a requirement */
      }
    }
  };
  window.calMove = function (e) {
    if (!g || g.kind !== "pointer") return;
    gestureMove(e.clientX, e.clientY, e);
  };
  window.calUp = function (e) {
    if (!g || g.kind !== "pointer") return;
    gestureEnd();
  };
  /* The month page is re-parented mid-gesture, so pointer tracking cannot rely
     on the original inline target staying under the cursor. */
  document.addEventListener("pointermove", e => {
    if (g && g.kind === "pointer") gestureMove(e.clientX, e.clientY, e);
  });
  document.addEventListener("pointerup", e => {
    if (g && g.kind === "pointer") gestureEnd();
  });
  document.addEventListener("pointercancel", e => {
    if (g && g.kind === "pointer") gestureEnd();
  });

  /* Touch needs a non-passive listener so a committed vertical gesture can
     stop the page from scrolling underneath the month strip. Scrolling that
     starts anywhere else on the page is untouched. */
  document.addEventListener(
    "touchstart",
    e => {
      if (e.touches.length !== 1) return;
      const t = e.target;
      if (!t.closest || !t.closest("#calwrap")) return;
      gestureStart(e.touches[0].clientX, e.touches[0].clientY, "touch", t);
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    e => {
      if (!g || g.kind !== "touch" || e.touches.length !== 1) return;
      gestureMove(e.touches[0].clientX, e.touches[0].clientY, e);
    },
    { passive: false },
  );
  document.addEventListener("touchend", e => {
    if (g && g.kind === "touch") gestureEnd();
  });
  document.addEventListener("touchcancel", e => {
    if (g && g.kind === "touch") gestureEnd();
  });

  /* Trackpad / mouse wheel: vertical movement over the calendar steps one
     month after a threshold; horizontal keeps the existing behaviour. */
  window.calWheel = function (e) {
    if (!el("calwrap")) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.2 && Math.abs(e.deltaX) >= 3) {
      e.preventDefault();
      if (vBusy || Date.now() - vLock < G_LOCK) return;
      calAcc += e.deltaX;
      if (Math.abs(calAcc) > 70) {
        calGo(calAcc > 0 ? 1 : -1);
        calAcc = 0;
        vLock = Date.now();
      }
      clearTimeout(calWt);
      calWt = setTimeout(() => (calAcc = 0), 200);
      return;
    }
    e.preventDefault();
    if (vBusy || Date.now() - vLock < G_LOCK) return;
    calAcc += e.deltaY;
    if (Math.abs(calAcc) >= 60) {
      applyCalShift(calAcc < 0 ? 1 : -1);
      vBusy = true;
      refresh(0);
      calAcc = 0;
      vLock = Date.now();
      setTimeout(() => (vBusy = false), G_LOCK);
    }
    clearTimeout(calWt);
    calWt = setTimeout(() => (calAcc = 0), 180);
  };

  /* ------------------------------------------------ continuous month view */

  // Touch/trackpad momentum belongs to the browser; mouse/pen dragging uses the
  // same scroll position with a short, decaying velocity. No scroll snapping: a
  // half-month position remains a half-month position.
  let timeline = null, pointer = null, suppressCalendarClickUntil = 0;

  /* One flick may travel at most a fraction of the viewport and always stops
     inside a fixed window. The strip is only grown while a finger/pointer is
     actually driving it, so browser momentum can never run into fresh months. */
  const COAST_VIEWPORTS = 0.85,
    COAST_MAX_MS = 700,
    COAST_TAU = 150,
    COAST_MAX_VELOCITY = 2,
    COAST_STOP = 0.02,
    SETTLE_MS = 220,
    BURST_MONTHS = 2;

  function stopCoast(t) {
    if (!t) return;
    // The generation token makes every earlier frame a no-op, even if a second
    // loop ever managed to slip through.
    t.coastGen = (t.coastGen || 0) + 1;
    if (t.raf) cancelAnimationFrame(t.raf);
    t.raf = 0;t.coasting = false;
  }
  function monthSection(offset, grid, headerHTML) {
    const date = new Date(T.getFullYear(), T.getMonth() + offset, 1);
    if (!grid) {
      const saved = cm;
      try {
        cm = offset;
        const tmp = document.createElement('div'), h = cal0();
        tmp.innerHTML = decorateCal(ASC.mode === 'all' ? h : scopeCal(h));
        grid = tmp.querySelector('.acal');
        headerHTML = tmp.querySelector('#calwrap > div:first-child > div:first-child')?.innerHTML;
      } finally { cm = saved; }
    }
    const section = document.createElement('section');
    section.className = 'cal-month';section.dataset.offset = offset;
    // The month name lives in the fixed header above the scroller, not inside
    // the strip: repeating it here would break the continuous sheet of weeks.
    section.setAttribute('aria-label', date.toLocaleDateString('en-PH', {month:'long',year:'numeric'}));
    section.append(grid);section._headerHTML = headerHTML;
    syncCalVisibility(section);
    return section;
  }
  function currentTimelineMonth(t) {
    const top = t.view.scrollTop, bottom = top + t.view.clientHeight;
    let best = null, visible = -1;
    for (const section of t.strip.children) {
      const area = Math.min(bottom, section.offsetTop + section.offsetHeight) - Math.max(top, section.offsetTop);
      if (area > visible) { best = section; visible = area; }
    }
    if (!best) return;
    const offset = +best.dataset.offset;
    for (const section of t.strip.children) section.classList.toggle('cal-month-current', section === best);
    t.offset = cm = offset;
    if (t.header && best._headerHTML && t.header.innerHTML !== best._headerHTML) t.header.innerHTML = best._headerHTML;
  }
  function extendTimeline(t) {
    if (t.extending || !t.w.isConnected) return;
    t.extending = true;
    const margin = t.view.clientHeight * 1.5;
    let added = 0;
    // overflow-anchor is disabled so the compensating offset is applied once.
    if (t.view.scrollTop < margin) {
      const first = t.strip.firstElementChild, before = first.offsetTop;
      t.strip.prepend(monthSection(+first.dataset.offset - 1));
      const shift = first.offsetTop - before;t.view.scrollTop += shift;
      if (pointer?.t === t) {pointer.origin+=shift;pointer.samples.forEach(s => s.y += shift);}
      added++;
    }
    if (t.view.scrollHeight - t.view.scrollTop - t.view.clientHeight < margin) {
      t.strip.append(monthSection(+t.strip.lastElementChild.dataset.offset + 1));
      added++;
    }
    t.burstGrowth = (t.burstGrowth || 0) + added;
    t.extending = false;
  }
  function trimTimeline(t) {
    if (!t.w.isConnected || pointer || t.touching || t.raf || t.coasting) return;
    const firstVisible = [...t.strip.children].find(s => s.offsetTop + s.offsetHeight > t.view.scrollTop);
    const before = firstVisible?.offsetTop || 0;
    for (const s of [...t.strip.children]) if (Math.abs(+s.dataset.offset - t.offset) > 3) s.remove();
    if (firstVisible?.isConnected) t.view.scrollTop += firstVisible.offsetTop - before;
  }
  function settleTimeline(t) {
    if (!t || !t.w.isConnected || t.touching || t.dragging || t.raf || t.coasting) return;
    t.programmatic = false;
    extendTimeline(t);
    trimTimeline(t);
    t.burstGrowth = 0;
  }
  function timelineScrolled(t) {
    if (!t.w.isConnected) { stopCoast(t);clearTimeout(t.idle);return; }
    currentTimelineMonth(t);
    // An active finger/pointer drives the strip without a budget. Momentum may
    // grow it by at most BURST_MONTHS: enough for a hard flick to keep its feel,
    // never enough to run through years while the browser keeps coasting.
    if (!t.programmatic && (t.touching || t.dragging || (t.burstGrowth || 0) < BURST_MONTHS)) extendTimeline(t);
    clearTimeout(t.idle);
    t.idle = setTimeout(() => settleTimeline(t), SETTLE_MS);
  }
  function ensureTimeline() {
    const w = el('calwrap');
    if (timeline?.w === w && w?.isConnected) return timeline;
    if (timeline) { stopCoast(timeline);clearTimeout(timeline.idle); }
    timeline = null;pointer = null;
    if (!w || w.classList.contains('as-year')) return null;
    const grid = w.querySelector('.acal');if (!grid) return null;
    const header = w.firstElementChild?.firstElementChild;
    w.firstElementChild.classList.add('cal-timeline-header');
    const view = document.createElement('div');view.className = 'cal-timeline';view.tabIndex = 0;
    view.setAttribute('role','region');view.setAttribute('aria-label','Scrollable calendar months');
    const strip = document.createElement('div');strip.className = 'cal-month-strip';view.append(strip);
    grid.replaceWith(view);
    const centre = monthSection(cm, grid, header?.innerHTML);
    strip.append(monthSection(cm - 3), monthSection(cm - 2), monthSection(cm - 1), centre, monthSection(cm + 1), monthSection(cm + 2), monthSection(cm + 3));
    w.style.touchAction = 'pan-y pinch-zoom';
    const t = timeline = {
      w,view,strip,header,offset:cm,scopeKey:ASC.mode+'|'+ASC.anchor,
      raf:0,idle:0,extending:false,coastGen:0,coasting:false,touching:false,dragging:false,burstGrowth:0,
    };
    view.scrollTop = centre.offsetTop;
    currentTimelineMonth(t);
    view.addEventListener('scroll', () => timelineScrolled(t), {passive:true});
    view.addEventListener('touchstart',()=>{t.touching=true;t.programmatic=false;t.burstGrowth=0;stopCoast(t);},{passive:true});
    const endTouch=e=>{t.touching=e.touches.length>0;if(!t.touching){clearTimeout(t.idle);t.idle=setTimeout(()=>settleTimeline(t),SETTLE_MS);}};
    view.addEventListener('touchend',endTouch,{passive:true});view.addEventListener('touchcancel',endTouch,{passive:true});
    view.addEventListener('lostpointercapture',e=>endCalendarPointer(e,true));
    // Keyboard scrolling stays local to the calendar and uses the same position.
    view.addEventListener('keydown', e => {
      if (e.target !== view || !['ArrowUp','ArrowDown','PageUp','PageDown'].includes(e.key)) return;
      e.preventDefault();e.stopPropagation();stopCoast(t);
      const sign = e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 1;
      view.scrollBy({top:sign*(e.key.startsWith('Page') ? view.clientHeight*.8 : 64),behavior:RMA()?'instant':'smooth'});
    });
    return t;
  }
  function timelineGo(offset) {
    const t = ensureTimeline();if (!t) return false;
    stopCoast(t);pointer = null;t.dragging = false;t.programmatic=true;
    // Explicit long-distance Today jumps may rebase offscreen content. Ordinary
    // dragging/scrolling never rebuilds the visible grids or the Activity list.
    if (Math.abs(offset - t.offset) > 6) {
      t.strip.replaceChildren(...[-3,-2,-1,0,1,2,3].map(n => monthSection(offset+n)));
    }
    while (+t.strip.firstElementChild.dataset.offset > offset-3) {
      const first = t.strip.firstElementChild;t.strip.prepend(monthSection(+first.dataset.offset-1));t.view.scrollTop += first.offsetTop;
    }
    while (+t.strip.lastElementChild.dataset.offset < offset+3) t.strip.append(monthSection(+t.strip.lastElementChild.dataset.offset+1));
    const target = [...t.strip.children].find(s => +s.dataset.offset === offset);
    t.view.scrollTo({top:target.offsetTop,behavior:RMA()?'instant':'smooth'});
    if (RMA()) currentTimelineMonth(t);
    return true;
  }
  const timelineRender = render;
  window.render = function () { const result = timelineRender.apply(this,arguments);ensureTimeline();return result; };

  function moveCalendarPointer(e) {
    const p = pointer;if (!p || p.id !== e.pointerId || p.event === e) return;p.event = e;
    // A missed pointerup (released over browser chrome or another window) must
    // not leave the calendar following the cursor with no button held.
    if (e.pointerType === 'mouse' && e.buttons === 0) { endCalendarPointer(e, true);return; }
    const dy = e.clientY - p.y, dx = e.clientX - p.x;
    if (!p.moved) {
      if (Math.abs(dy) < 6) return;
      if (Math.abs(dx) > Math.abs(dy)*1.5) { pointer=null;p.t.dragging=false;return; }
      p.moved = true;
      try { p.t.view.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (e.cancelable) e.preventDefault();
    // Exactly one CSS pixel per finger/pen/mouse pixel; no damping or stage transform.
    p.t.view.scrollTop = p.origin - dy;
    const now = performance.now();p.samples.push({y:p.t.view.scrollTop,time:now});
    while (p.samples.length>2 && p.samples[0].time < now-120) p.samples.shift();
    timelineScrolled(p.t);
  }
  function startCoast(t, velocity) {
    stopCoast(t); /* only one momentum loop may ever own the scroller */
    const gen = t.coastGen,
      budget = Math.max(0, t.view.clientHeight * COAST_VIEWPORTS),
      started = performance.now();
    let previous = started, travelled = 0;
    t.coasting = true;
    const tick = time => {
      if (gen !== t.coastGen || !t.w.isConnected || RMA()) { stopCoast(t);return; }
      const dt = Math.min(32, Math.max(0, time - previous));
      previous = time;
      const room = budget - travelled;
      if (room < 0.5 || time - started > COAST_MAX_MS) { stopCoast(t);settleTimeline(t);return; }
      const step = Math.max(-room, Math.min(room, velocity * dt));
      const before = t.view.scrollTop;
      t.view.scrollTop = before + step;
      const moved = t.view.scrollTop - before;
      if (!moved) { stopCoast(t);settleTimeline(t);return; }
      travelled += moved;
      velocity *= Math.exp(-dt / COAST_TAU);
      timelineScrolled(t);
      if (Math.abs(velocity) < COAST_STOP) { stopCoast(t);settleTimeline(t);return; }
      t.raf = requestAnimationFrame(tick);
    };
    t.raf = requestAnimationFrame(tick);
  }
  function endCalendarPointer(e, cancelled) {
    const p = pointer;if (!p || p.id !== e.pointerId) return;
    pointer = null;p.t.dragging = false;
    if (!p.moved) { settleTimeline(p.t);return; }
    suppressCalendarClickUntil = performance.now()+300;
    if (cancelled || RMA()) { settleTimeline(p.t);return; }
    const now=performance.now(),recent=p.samples.filter(s=>now-s.time<=120);
    const first=recent[0],last=recent[recent.length-1];
    const span=first&&last?last.time-first.time:0;
    let velocity = span>=8 && now-last.time<=120 ? (last.y-first.y)/span : 0;
    if (!Number.isFinite(velocity)) velocity = 0;
    velocity = Math.max(-COAST_MAX_VELOCITY,Math.min(COAST_MAX_VELOCITY,velocity));
    if (Math.abs(velocity) < 0.05) { settleTimeline(p.t);return; }
    startCoast(p.t, velocity);
  }
  const yearDown=window.calDown,yearMove=window.calMove,yearUp=window.calUp,yearWheel=window.calWheel;
  window.calDown = function (e) {
    const t=ensureTimeline();
    if (!t || !e.target.closest('.cal-timeline')) return yearDown(e);
    // Any new gesture immediately takes ownership from a running momentum loop.
    stopCoast(t);
    t.programmatic=false;
    t.burstGrowth=0;
    if (e.pointerType==='touch' || !e.isPrimary || e.button || e.target.closest('button,a,input,select')) return;
    pointer={id:e.pointerId,t,x:e.clientX,y:e.clientY,origin:t.view.scrollTop,moved:false,samples:[{y:t.view.scrollTop,time:performance.now()}]};
    t.dragging=true;
  };
  window.calMove = function(e) { if(pointer)moveCalendarPointer(e);else if(!timeline)yearMove(e); };
  window.calUp = function(e) { if(pointer)endCalendarPointer(e,e.type==='pointercancel');else if(!timeline)yearUp(e); };
  window.calWheel = function(e) {
    const t=ensureTimeline();
    if(!t) return yearWheel(e);
    // A fresh wheel burst may grow the strip again; events of the same burst
    // share the cap so momentum cannot keep feeding itself for years.
    const now=performance.now();
    if(!t.lastWheel||now-t.lastWheel>200) t.burstGrowth=0;
    t.lastWheel=now;
    stopCoast(t);t.programmatic=false;
    /* Native wheel scrolling is never prevented. */
  };
  document.addEventListener('pointermove',moveCalendarPointer,{passive:false});
  document.addEventListener('pointerup',e=>endCalendarPointer(e,false));
  document.addEventListener('pointercancel',e=>endCalendarPointer(e,true));
  /* Losing focus can swallow the pointerup entirely: abandon the gesture and its
     momentum instead of leaving either running in the background. */
  window.addEventListener('blur',()=>{
    pointer=null;
    if(!timeline) return;
    timeline.dragging=false;stopCoast(timeline);settleTimeline(timeline);
  });
  document.addEventListener('click',e=>{
    if (performance.now()<suppressCalendarClickUntil && e.target.closest?.('.cal-timeline')) { e.preventDefault();e.stopImmediatePropagation(); }
  },true);

  /* ------------------------------------------------------------ keyboard */

  /* Left / right step the period, as long as the user is not typing. */
  document.addEventListener("keydown", e => {
    if (open) return; /* the popup owns the arrows while it is up */
    if (tab !== "Activity" || ASC.mode === "all") return;
    const t = e.target;
    if (t && t.closest && t.closest("input,textarea,select,[contenteditable]")) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      window.stepScope(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      window.stepScope(1);
    }
  });

  /* The popup behaves like the Accounts one: Escape closes, arrows rove. */
  document.addEventListener(
    "keydown",
    e => {
      const m = el("activity-options-menu");
      if (!m || !open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeMenu(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const bs = [...m.querySelectorAll("button")],
          i = bs.indexOf(document.activeElement),
          n =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? bs.length - 1
                : (i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length;
        if (bs[n]) bs[n].focus();
      }
    },
    true,
  );

  document.addEventListener("pointerdown", e => {
    if (!open) return;
    if (e.target.closest && e.target.closest("#activity-options-menu, .as-pills")) return;
    closeMenu(false);
  });
  document.addEventListener("focusin", e => {
    if (!open) return;
    if (e.target.closest && e.target.closest("#activity-options-menu, .as-pills")) return;
    closeMenu(false);
  });
  /* Fixed anchoring must follow the trigger through page scroll, resize,
     and animation frames while the menu is open. */
  const reanchor = () => {
    if (open) positionScopeMenu();
  };
  window.addEventListener("resize", reanchor);
  window.addEventListener("scroll", reanchor, true);
  /* Animation frame loop for smooth re-anchoring during transitions/scroll. */
  let rafId = 0;
  function rafLoop() {
    if (open) {
      positionScopeMenu();
      rafId = requestAnimationFrame(rafLoop);
    } else {
      rafId = 0;
    }
  }
  const origPaint = paint;
  paint = function (focus) {
    origPaint(focus);
    if (open && !rafId) rafId = requestAnimationFrame(rafLoop);
  };
  const origClose = closeMenu;
  closeMenu = function (focus) {
    origClose(focus);
    if (rafId) cancelAnimationFrame(rafId), (rafId = 0);
  };

  selSync();
}
