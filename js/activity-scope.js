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
      const n = upDays().reduce((a, x) => a + x.l.length, 0);
      return n ? `${n} scheduled` : "nothing scheduled";
    }
    const n = filt === "All" ? l.length + Object.values(scheduledDays()).reduce((a, x) => a + x.length, 0) : l.length;
    return `${n} ${n === 1 ? "entry" : "entries"}`;
  }

  function periodLabel() {
    if (ASC.mode === "all") return filt === "Upcoming" ? "Next 45 days" : "All dates";
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

  /* The opener — the Accounts ••• button and its menu — placed on the pills
     row, flush right, directly above the column of daily totals. */
  function openerHTML() {
    const on = ASC.mode !== "all";
    return (
      `<button id="activity-options-button" class="pill account-options-button${on ? " on" : ""}" aria-label="Date range" aria-haspopup="menu" aria-expanded="false" onclick="toggleScopeMenu()">&#8943;</button>` +
      `<div id="activity-options-menu" class="account-options-menu" role="menu" aria-label="Date range" hidden></div>`
    );
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
        `<div class="ao-dow">${["S", "M", "T", "W", "T", "F", "S"].map(x => `<span>${x}</span>`).join("")}</div>` +
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

  /* Repainting the body swaps the page inside the same popup, so the swap
     gets the component's own entrance animation for free. */
  function paint(focus) {
    const m = el("activity-options-menu"),
      b = el("activity-options-button");
    if (!m) return;
    m.innerHTML = menuHTML();
    m.hidden = !open;
    if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && focus) {
      const f = m.querySelector("button");
      if (f) f.focus();
    }
  }

  function closeMenu(focus) {
    open = false;
    const m = el("activity-options-menu"),
      b = el("activity-options-button");
    if (m) m.hidden = true;
    if (b) {
      b.setAttribute("aria-expanded", "false");
      if (focus) b.focus();
    }
  }

  function seedPick() {
    const a = D(ASC.anchor || today);
    py = a.getFullYear();
    pm = a.getMonth();
    wy = a.getFullYear() - 4;
  }

  /* ------------------------------------------------- day-select motion ----- */

  /* The tapped cell presses in and springs back bigger. The calendar is rebuilt
     on every pick, so the class goes on the fresh cell and the CSS runs it. */
  function popDay(k) {
    const c = document.querySelector(`.acal .dc[data-k="${k}"]`);
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
    if (!el("activity-options-menu")) return;
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

  window.pickDay = k => {
    /* the calendar is part of the scope, so this one needs the calendar rebuilt */
    const off = ASC.mode === "day" && ASC.anchor === k;
    if (off) ASC.mode = "all";
    else {
      ASC.mode = "day";
      ASC.anchor = k;
    }
    selSync();
    refresh(0);
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
              (x[0].kind !== "tx" || k > today) &&
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
    return d.length
      ? d.map(x => grp(x.k, x.l.map(y => rowH(x.k, y[0], y[1])).join(""), "Planned")).join("")
      : '<p class="m">Nothing planned in this period.</p>';
  };

  /* ---- All: the calendar's scheduled events, not only transactions ----
     Upcoming is the planning lens; "All" is the whole calendar, so a bill,
     card due date or statement painted on a day must be listed there too.
     Paid bills stay out so their payment can never appear twice. */
  function scheduledDays() {
    const r = range(),
      from = r ? r.from : today,
      to = r ? r.to : isoD(addD(D(today), 44)),
      out = {};
    for (let d = D(from); isoD(d) <= to; d = addD(d, 1)) {
      const k = isoD(d),
        l = evs(k)
          .map((e, j) => [e, j])
          .filter(
            ([e]) =>
              e.kind !== "tx" &&
              e.kind !== "xfer" &&
              !(e.kind === "bill" && bPaid(S.bills.find(b => b.id === e.id), k)) &&
              (!q || tt(e.t).toLowerCase().includes(q.toLowerCase())),
          );
      if (l.length) out[k] = l;
    }
    return out;
  }

  function allGroups() {
    const g = {};
    actList().forEach(t => (g[t.d] = g[t.d] || []).push(t));
    /* pending rows keep the same section the standard list uses */
    const pl = (S.pend || [])
      .filter(t => !q || (t.note + (t.desc || "") + t.cat + Math.abs(t.amt)).toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => b.d.localeCompare(a.d));
    const ph = pl.length
      ? `<div style="display:flex;justify-content:space-between;margin:18px 4px 6px"><b>Pending · not posted</b><span class="m" style="font-size:13px">${pl.length} · not in balances</span></div><div class="card" style="padding:2px 14px">${pl.map(rowT).join("")}</div>`
      : "";
    const ev = scheduledDays();
    const txHTML = Object.keys(g)
      .sort()
      .reverse()
      .map(k => {
        const l = g[k],
          txs = l.filter(t => !t.transfer),
          tot = sum(txs.map(t => t.amt));
        return grp(k, l.map(rowT).join(""), k > today ? "Planned" : txs.length ? (tot < 0 ? "−" : "+") + php(Math.abs(tot)) : "");
      })
      .join("");
    /* No date scope: actual activity stays latest-first. Scheduled bills and
       card dates follow below instead of pushing future dates above it. */
    if (ASC.mode === "all") {
      const evHTML = Object.keys(ev)
        .sort()
        .map(k => grp(k, ev[k].map(([e, j]) => rowH(k, e, j)).join(""), "Planned"))
        .join("");
      return ph + (
        txHTML +
        (evHTML
          ? '<div style="display:flex;justify-content:space-between;margin:18px 4px 6px"><b>Scheduled</b><span class="m" style="font-size:13px">Next 45 days</span></div>' + evHTML
          : "") || (ph ? "" : '<p class="m">Nothing here yet.</p>')
      );
    }
    return (
      ph +
      (Object.keys({ ...g, ...ev })
        .sort()
        .reverse()
        .map(k => {
          const l = g[k] || [],
            txs = l.filter(t => !t.transfer),
            tot = sum(txs.map(t => t.amt));
          return grp(
            k,
            l.map(rowT).join("") + (ev[k] || []).map(([e, j]) => rowH(k, e, j)).join(""),
            k > today ? "Planned" : txs.length ? (tot < 0 ? "−" : "+") + php(Math.abs(tot)) : "",
          );
        })
        .join("") || (ph ? "" : '<p class="m">Nothing here yet.</p>'))
    );
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
    if (ASC.mode === "all") return calGo0.apply(this, arguments);
    window.stepScope(d);
  };

  /* The app's Today button resets the grid offset. While a scope is active the
     period is what moves, so Today goes to the period that contains today. */
  window.calToday = () => {
    if (ASC.mode === "all") {
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
    const slide = dir && !RM();
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

  selSync();
}
