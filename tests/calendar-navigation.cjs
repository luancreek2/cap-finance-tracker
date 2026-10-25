/* Focused Activity calendar/popover checks on an isolated HTTP origin. The
   fixtures are synthetic; no financial write, cloud call or storage migration
   is executed. Pointer drags exercise the real inline handlers. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
if (!process.env.CAP_PLAYWRIGHT_PATH) {
  console.log("SKIP: calendar navigation needs CAP_PLAYWRIGHT_PATH");
  process.exit(0);
}
const { chromium } = require(process.env.CAP_PLAYWRIGHT_PATH),
  root = path.resolve(__dirname, ".."),
  shots = path.join(process.env.LOCALAPPDATA || process.env.TEMP, "Temp", "opencode", "calendar-review");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
};
let browser, server, passed = 0, external = 0;
const pause = p => p.waitForTimeout(320);
async function test(name, fn) {
  await fn();
  passed++;
  console.log("PASS " + name);
}
async function boot(context, origin) {
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => window.CapOverlays && window.CapProductionSync && !window.capLaunchActive);
  await page.evaluate(() => {
    localStorage.setItem("cap_whats_new_seen_version", APP_VERSION);
    if (document.querySelector(".whats-new-overlay")) closeWhatsNew();
    document.querySelector("#cap-auth")?.remove();
    const base = new Date(today + "T12:00:00"),
      y = base.getFullYear(),
      m = base.getMonth(),
      iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const firstDow = (want, from) => {
      const d = new Date(y, m, from);
      while (d.getDay() !== want) d.setDate(d.getDate() + 1);
      return d;
    };
    const sat = firstDow(6, 1),
      sun = firstDow(0, 1);
    S.accts = [
      { id: 100, name: "Fixture Debit", bank: "Fixture", type: "debit", bal: 5000, img: "cash", g: ["#234567", "#123456"] },
      { id: 101, name: "Fixture Wallet", bank: "Fixture", type: "ewallet", bal: 1000, g: ["#234567", "#123456"] },
    ];
    S.tx = [
      { id: 501, d: iso(sat), amt: -12.5, cat: "Food", acct: 100, note: "Saturday expense" },
      { id: 502, d: iso(sun), amt: 1100, cat: "Salary", acct: 100, note: "Sunday income" },
    ];
    S.pend = [{ id: 601, d: iso(firstDow(6, 8)), amt: -7, cat: "Food", acct: 100, note: "Upcoming" }];
    S.xfer = [];
    S.bills = [{ id: 701, name: "Weekend bill", amt: 15, due: sat.getDate(), start: `${y}-${String(m + 1).padStart(2, "0")}-01`, freq: "monthly", acct: 100, paid: "" }];
    localStorage.setItem("cap-appearance-theme", "apple");
    tab = "Activity";
    scopeClear();
    filt = "All";
    render();
  });
  await pause(page);
  return page;
}
(function () {
  (async () => {
    fs.mkdirSync(shots, { recursive: true });
    server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://fixture.invalid");
      if (["/supabase-config.js", "/supabase-config.local.js"].includes(u.pathname)) {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        return res.end("window.CAP_SUPABASE_CONFIG={};");
      }
      if (u.pathname.startsWith("/rest/") || u.pathname.startsWith("/auth/")) {
        external++;
        res.writeHead(403);
        return res.end();
      }
      const file = path.resolve(root, "." + decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname));
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403);
        return res.end();
      }
      fs.readFile(file, (e, b) => {
        res.writeHead(e ? 404 : 200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(e ? "Missing" : b);
      });
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const origin = "http://127.0.0.1:" + server.address().port;
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.route("**/*", r => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
    const page = await boot(context, origin);
    await test("calendar weekday headers use three-letter names", async () => {
      assert.deepEqual(await page.locator("#calwrap .cal-weekdays span").allTextContents(),
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    });
    await test("first ellipsis click creates and opens the menu; repeat clicks toggle it", async () => {
      assert.equal(await page.locator("#activity-options-menu").count(), 0);
      const button = page.locator("#activity-options-button");
      await button.click();
      await page.locator("#activity-options-menu").waitFor({ state: "visible" });
      assert.equal(await button.getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator("body > #activity-options-menu").count(), 1);
      await button.click();
      assert.equal(await page.locator("#activity-options-menu").isHidden(), true);
      await button.click();
      assert.equal(await page.locator("#activity-options-menu").isVisible(), true);
      assert.equal(await page.locator("#activity-options-menu").count(), 1);
      await page.keyboard.press("Escape");
      assert.equal(await button.getAttribute("aria-expanded"), "false");
    });
    const snapshot = () =>
      page.evaluate(async () =>
        JSON.stringify({
          S,
          baseline: (await CapOff.productionSyncSnapshot()).baseline,
          outbox: (await CapOff.productionSyncSnapshot()).outbox,
          hold: localStorage.getItem(CapProductionSync.recoveryKey),
        }),
      );
    const before = await snapshot();
    const calendarBox = async () => {
      await page.evaluate(() => document.getElementById("calwrap").scrollIntoView({ block: "center" }));
      await page.waitForTimeout(80);
      return page.locator("#calwrap").boundingBox();
    };
    const quickDrag = async (dy, hold) => {
      const b = await page.locator("#calwrap, .cal-vstage").first().boundingBox(),
        x = Math.floor(b.x + b.width / 2),
        y = Math.floor(b.y + b.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(x, y + (dy * i) / 6, { steps: 1 });
      if (hold) await hold();
      await page.mouse.up();
    };
    const drag = async (dy, hold) => {
      await calendarBox();
      await quickDrag(dy, hold);
    };

    await test("swipe up prepares the adjacent month and advances exactly one", async () => {
      const start = await page.evaluate(() => cm);
      let stage = null;
      await drag(-140, async () => {
        stage = await page.evaluate(() => {
          const s = document.querySelector(".cal-vstage");
          if (!s) return null;
          const pages = [...s.querySelectorAll(".cal-vpage")].map(p => {
            const r = p.getBoundingClientRect();
            return { top: r.top, text: p.innerText.slice(0, 24) };
          });
          return { pages, transform: getComputedStyle(s).transform };
        });
      });
      assert.ok(stage && stage.pages.length === 2, "adjacent month was not prepared");
      assert.notEqual(stage.pages[0].top, stage.pages[1].top);
      await page.waitForTimeout(360);
      assert.equal(await page.evaluate(() => document.querySelectorAll(".cal-vstage").length), 0);
      assert.equal(await page.evaluate(() => cm), start + 1);
      assert.equal(await page.locator("#calwrap").count(), 1);
      await page.screenshot({ path: path.join(shots, "swipe-next.png") });
    });

    await test("gesture lock blocks an immediate second month change", async () => {
      const start = await page.evaluate(() => cm);
      await quickDrag(-140);
      await page.waitForTimeout(330);
      const first = await page.evaluate(() => cm);
      assert.equal(first, start + 1);
      await quickDrag(-140); /* starts inside the settle lock */
      await page.waitForTimeout(360);
      assert.equal(await page.evaluate(() => cm), first, "lock did not hold the month");
      assert.equal(await page.evaluate(() => document.querySelectorAll(".cal-vstage").length), 0);
      await page.waitForTimeout(500);
      await quickDrag(-140);
      await page.waitForTimeout(360);
      assert.equal(await page.evaluate(() => cm), first + 1);
    });

    await test("swipe down goes to the previous month", async () => {
      const start = await page.evaluate(() => cm);
      await page.waitForTimeout(460);
      await drag(140);
      await page.waitForTimeout(360);
      assert.equal(await page.evaluate(() => cm), start - 1);
    });

    await test("rapid flicks cannot leave a stage, duplicate calendar or corrupt the list", async () => {
      await page.waitForTimeout(460);
      await drag(-120);
      await quickDrag(-120);
      await quickDrag(-120);
      await page.waitForTimeout(420);
      const a = await page.evaluate(() => ({
        stages: document.querySelectorAll(".cal-vstage").length,
        cals: document.querySelectorAll("#calwrap").length,
        id: document.getElementById("calwrap")?.id,
        rows: document.querySelectorAll("#app .row").length,
      }));
      assert.equal(a.stages, 0);
      assert.equal(a.cals, 1);
      assert.equal(a.id, "calwrap");
      assert.ok(a.rows >= 2);
    });

    await test("previous, next and Today controls share the canonical month state", async () => {
      const start = await page.evaluate(() => cm);
      await page.locator('#calwrap button[onclick="calGo(1)"]').click();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => cm), start + 1);
      await page.locator('#calwrap button[onclick="calGo(-1)"]').click();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => cm), start);
      await page.evaluate(() => (cm = 3, render()));
      await page.locator('#calwrap button[onclick="calToday()"]').click();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => cm), 0);
    });

    await test("December steps to January and January back to December across the year boundary", async () => {
      await page.evaluate(() => {
        cm = (2026 - T.getFullYear()) * 12 + (11 - T.getMonth());
        render();
      });
      await page.waitForTimeout(120);
      await drag(-140);
      await page.waitForTimeout(360);
      const jan = await page.evaluate(() => ({
        cm,
        month: document.querySelector("#calwrap > div:first-child > div:first-child").firstChild.textContent.trim(),
      }));
      assert.equal(jan.month, "January 2027");
      await page.waitForTimeout(460);
      await drag(140);
      await page.waitForTimeout(360);
      const dec = await page.evaluate(() => ({
        cm,
        month: document.querySelector("#calwrap > div:first-child > div:first-child").firstChild.textContent.trim(),
      }));
      assert.equal(dec.month, "December 2026");
    });

    await test("wheel/trackpad vertical scrolling advances one month after a threshold", async () => {
      await page.evaluate(() => (cm = 0, render()));
      const b = await calendarBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.wheel(0, -90);
      await page.waitForTimeout(420);
      assert.equal(await page.evaluate(() => cm), 1);
      await page.waitForTimeout(460);
      await page.mouse.wheel(0, 90);
      await page.waitForTimeout(420);
      assert.equal(await page.evaluate(() => cm), 0);
    });

    for (const scheme of ["light", "dark"]) {
      await test(scheme + " weekend columns differ from weekdays without hiding markers", async () => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate(() => {
          setTheme("apple");
          /* setTheme parks the Appearance page in the sheet; return to the grid. */
          closeS();
          tab = "Activity";
          cm = 0;
          filt = "All";
          render();
        });
        await page.waitForTimeout(120);
        const a = await page.evaluate(() => {
          const cells = [...document.querySelectorAll(".acal > div")];
          const bg = c => getComputedStyle(c).backgroundColor;
          return cells.map((c, i) => ({
            i,
            weekend: i % 7 === 0 || i % 7 === 6,
            bg: bg(c),
            ap: [...c.querySelectorAll(".ap")].map(x => ({ text: x.textContent, opacity: getComputedStyle(x).opacity, bg: getComputedStyle(x).backgroundColor })),
            today: c.querySelector(".n.t span") ? { bg: getComputedStyle(c.querySelector(".n.t span")).backgroundColor, color: getComputedStyle(c.querySelector(".n.t span")).color } : null,
          }));
        });
        const weekend = a.filter(x => x.weekend), weekdays = a.filter(x => !x.weekend);
        const tone = weekend[0].bg;
        assert.ok(tone !== "rgba(0, 0, 0, 0)", "weekend should be shaded");
        assert.ok(weekend.every(x => x.bg === tone), "Saturday and Sunday should match");
        assert.ok(weekdays.every(x => x.bg === "rgba(0, 0, 0, 0)"), "weekday must stay unshaded");
        const marked = weekend.filter(x => x.ap.length);
        assert.ok(marked.length, "weekend markers must stay visible");
        assert.ok(marked.every(x => x.ap.every(m => m.opacity === "1" && m.bg !== "rgba(0, 0, 0, 0)")), "weekend markers must stay visible");
        const bill = await page.locator(".acal .ap.u").count();
        assert.ok(bill >= 1, "weekend bill/due marker missing");
        const today = a.find(x => x.today);
        if (today) {
          assert.notEqual(today.today.bg, "rgba(0, 0, 0, 0)");
          assert.notEqual(today.today.bg, today.bg);
        }
        await page.screenshot({ path: path.join(shots, `weekend-${scheme}.png`) });
      });
    }

    await test("ellipsis opens immediately after selecting a date without a scroll jump", async () => {
      await page.locator("#activity-options-button").scrollIntoViewIfNeeded();
      const a = await page.evaluate(() => {
        scopeDay(today);
        const scroll = scrollY;
        document.getElementById("activity-options-button").click();
        const b = document.getElementById("activity-options-button").getBoundingClientRect(),
          m = document.getElementById("activity-options-menu");
        return { visible: !m.hidden, scroll, after: scrollY, b: b.toJSON(), m: m.getBoundingClientRect().toJSON() };
      });
      assert.equal(a.visible, true);
      assert.equal(a.after, a.scroll);
      // Opening is immediate; measure the final gap after the menu's own entrance transform.
      await pause(page);
      const placed = await page.evaluate(() => ({
        b: document.getElementById("activity-options-button").getBoundingClientRect().toJSON(),
        m: document.getElementById("activity-options-menu").getBoundingClientRect().toJSON(),
      }));
      const gap = placed.m.top >= placed.b.bottom ? placed.m.top - placed.b.bottom : placed.b.top - placed.m.bottom;
      assert.ok(gap >= 4 && gap <= 10, "immediate menu gap " + gap);
      await page.keyboard.press("Escape");
      await page.evaluate(() => scopeClear());
    });

    await test("Date range popover is anchored below/right of the ••• trigger", async () => {
      await page.evaluate(() => {
        closeS();
        tab = "Activity";
        cm = 0;
        filt = "All";
        render();
      });
      await page.waitForTimeout(120);
      await page.locator("#activity-options-button").click();
      await page.waitForTimeout(120);
      const a = await page.evaluate(() => {
        const b = document.getElementById("activity-options-button").getBoundingClientRect(),
          m = document.getElementById("activity-options-menu").getBoundingClientRect(),
          c = getComputedStyle(document.getElementById("activity-options-menu"));
        return { b: b.toJSON(), m: m.toJSON(), vw: innerWidth, vh: innerHeight, position: c.position, z: +c.zIndex, navZ: +(getComputedStyle(document.querySelector("nav")).zIndex || 0) };
      });
      assert.equal(a.position, "fixed");
      /* Below is preferred; above is the collision fallback. Either way the
         popover must hug the trigger with a small gap. */
      const gap = a.m.top >= a.b.bottom ? a.m.top - a.b.bottom : a.b.top - a.m.bottom;
      assert.ok(gap >= 4 && gap <= 10, "vertical gap " + gap);
      assert.ok(Math.abs(a.m.right - a.b.right) <= 2 || a.m.right <= a.vw - 8, "not right aligned");
      assert.ok(a.m.left >= 8 && a.m.right <= a.vw - 8 && a.m.top >= 8 && a.m.bottom <= a.vh - 8);
      assert.ok(a.z > a.navZ, "popover must sit above navigation");
    });

    await test("popover stays inside the viewport and re-anchors on resize", async () => {
      const before = await page.evaluate(() => document.getElementById("activity-options-menu").getBoundingClientRect().toJSON());
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => {
        const b = document.getElementById("activity-options-button").getBoundingClientRect(),
          m = document.getElementById("activity-options-menu").getBoundingClientRect();
        return { b: b.toJSON(), m: m.toJSON(), vw: innerWidth, vh: innerHeight };
      });
      assert.ok(after.m.left >= 8 && after.m.right <= after.vw - 8 && after.m.top >= 8 && after.m.bottom <= after.vh - 8);
      const gap = after.m.top >= after.b.bottom ? after.m.top - after.b.bottom : after.b.top - after.m.bottom;
      assert.ok(gap >= 4 && gap <= 10, "vertical gap " + gap);
      assert.notEqual(JSON.stringify(before), JSON.stringify(after.m));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(120);
    });

    await test("popover flips above when there is no room below", async () => {
      /* Shrink the viewport and park the trigger at the bottom edge. */
      await page.setViewportSize({ width: 390, height: 560 });
      await page.evaluate(() => document.getElementById("activity-options-button").scrollIntoView({ block: "end" }));
      await page.waitForTimeout(120);
      await page.evaluate(() => window.positionScopeMenu());
      await page.waitForTimeout(80);
      const a = await page.evaluate(() => {
        const b = document.getElementById("activity-options-button").getBoundingClientRect(),
          m = document.getElementById("activity-options-menu").getBoundingClientRect();
        return { b: b.toJSON(), m: m.toJSON() };
      });
      assert.ok(a.m.bottom <= a.b.top + 1, "menu did not flip above");
      assert.ok(a.m.top >= 8, "flipped menu clipped at the top");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(120);
      await page.evaluate(() => window.positionScopeMenu());
    });

    await test("Day, Week, Month and Year submenus open inside the viewport", async () => {
      for (const label of ["Day", "Week", "Month", "Year"]) {
        await page.getByRole("menuitemradio", { name: label, exact: true }).click();
        await page.waitForTimeout(80);
        const a = await page.evaluate(() => {
          const m = document.getElementById("activity-options-menu").getBoundingClientRect();
          return { m: m.toJSON(), vw: innerWidth, vh: innerHeight, back: !!document.querySelector("#activity-options-menu .ao-back") };
        });
        assert.equal(a.back, true, label + " submenu missing");
        assert.ok(a.m.left >= 8 && a.m.right <= a.vw - 8 && a.m.top >= 8 && a.m.bottom <= a.vh - 8, label + " clipped");
        await page.locator("#activity-options-menu .ao-back").click();
        await page.waitForTimeout(60);
      }
    });

    await test("Apple Theme popover uses the shared glass material", async () => {
      const a = await page.evaluate(() => {
        const c = getComputedStyle(document.getElementById("activity-options-menu"));
        return { bg: c.backgroundColor, blur: c.backdropFilter, border: c.borderTopColor, shadow: c.boxShadow };
      });
      assert.match(a.bg, /rgba\(/);
      assert.match(a.blur, /blur\(18px\).*saturate/);
      assert.notEqual(a.border, "rgba(0, 0, 0, 0)");
      assert.notEqual(a.shadow, "none");
      await page.screenshot({ path: path.join(shots, "date-range-popover.png") });
    });

    for (const [w, h] of [[320, 740], [360, 780], [390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
      for (const scheme of ["light", "dark"]) {
        await test(`${w}x${h} ${scheme}: weekend shading and anchored Date range menu`, async () => {
          await page.setViewportSize({ width: w, height: h });
          await page.emulateMedia({ colorScheme: scheme });
          await page.evaluate(() => document.getElementById("activity-options-button").scrollIntoView({ block: "center" }));
          await page.waitForTimeout(120);
          if (await page.evaluate(() => document.getElementById("activity-options-menu").hidden)) {
            await page.evaluate(() => toggleScopeMenu());
          }
          await page.waitForTimeout(100);
          const a = await page.evaluate(() => {
            const cells = [...document.querySelectorAll(".acal > div")];
            const weekend = cells.filter((_, i) => i % 7 === 0 || i % 7 === 6);
            const week = cells.filter((_, i) => i % 7 !== 0 && i % 7 !== 6);
            const tone = getComputedStyle(weekend[0]).backgroundColor;
            const b = document.getElementById("activity-options-button").getBoundingClientRect(),
              m = document.getElementById("activity-options-menu").getBoundingClientRect();
            return {
              tone,
              allWeekend: weekend.every(c => getComputedStyle(c).backgroundColor === tone),
              weekClean: week.every(c => getComputedStyle(c).backgroundColor === "rgba(0, 0, 0, 0)"),
              markers: document.querySelectorAll(".acal .ap").length,
              b: b.toJSON(),
              m: m.toJSON(),
              vw: innerWidth,
              vh: innerHeight,
            };
          });
          assert.notEqual(a.tone, "rgba(0, 0, 0, 0)", "weekend tint missing");
          assert.ok(a.allWeekend, "weekend columns disagree");
          assert.ok(a.weekClean, "weekday tinted");
          assert.ok(a.markers >= 1, "markers missing");
          assert.ok(
            a.m.left >= 8 && a.m.right <= a.vw - 8 && a.m.top >= 8 && a.m.bottom <= a.vh - 8,
            "menu outside viewport: " + JSON.stringify(a.m),
          );
          const gap = a.m.top >= a.b.bottom ? a.m.top - a.b.bottom : a.b.top - a.m.bottom;
          assert.ok(gap >= 4 && gap <= 10, "menu gap " + gap);
          assert.ok(Math.abs(a.m.right - a.b.right) <= 2 || a.m.right <= a.vw - 8, "menu not right aligned");
          if (w === 320 || w === 1440) {
            await page.screenshot({ path: path.join(shots, `responsive-${w}x${h}-${scheme}.png`) });
          }
        });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => document.getElementById("activity-options-button").scrollIntoView({ block: "center" }));
    await page.waitForTimeout(100);

    await test("outside click and Escape dismiss the anchored popover", async () => {
      await page.mouse.click(10, 600);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.getElementById("activity-options-menu").hidden), true);
      await page.locator("#activity-options-button").click();
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => document.getElementById("activity-options-menu").hidden), false);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => document.getElementById("activity-options-menu").hidden), true);
    });

    await test("calendar navigation never mutates records, balances, sync or theme preference", async () => {
      assert.equal(await snapshot(), before);
      assert.equal(external, 0);
    });

    await test("reduced motion still changes months without a sliding stage", async () => {
      const reduced = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
      await reduced.route("**/*", r => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
      const rp = await boot(reduced, origin);
      const start = await rp.evaluate(() => cm);
      await rp.evaluate(() => document.getElementById("calwrap").scrollIntoView({ block: "center" }));
      const b = await rp.locator("#calwrap").boundingBox(),
        x = Math.floor(b.x + b.width / 2),
        y = Math.floor(b.y + b.height / 2);
      await rp.mouse.move(x, y);
      await rp.mouse.down();
      for (let i = 1; i <= 6; i++) await rp.mouse.move(x, y - (140 * i) / 6);
      const during = await rp.evaluate(() => document.querySelectorAll(".cal-vstage").length);
      await rp.mouse.up();
      await rp.waitForTimeout(120);
      assert.equal(during, 0);
      assert.equal(await rp.evaluate(() => cm), start + 1);
      assert.equal(await rp.evaluate(() => document.querySelectorAll(".cal-vstage").length), 0);
      await reduced.close();
    });

    await context.close();
    console.log("Screenshots: " + shots);
    console.log(`PASS: ${passed} calendar navigation / weekend / popover checks`);
  })().catch(e => {
    console.error(e);
    process.exitCode = 1;
  }).finally(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(r => server.close(r));
  });
})();
