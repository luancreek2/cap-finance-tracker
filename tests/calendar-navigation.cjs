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
      await page.evaluate(() => document.querySelector('.cal-timeline').scrollIntoView({ block: "center" }));
      await page.waitForTimeout(80);
      return page.locator('.cal-timeline').boundingBox();
    };
    const quickDrag = async (dy, hold) => {
      const b = await page.locator('.cal-timeline').boundingBox(),
        x = Math.floor(b.x + b.width / 2),
        y = Math.floor(dy < 0 ? b.y + b.height - 35 : b.y + 35);
      await page.mouse.move(x, y);
      await page.mouse.down();
      /* one protocol round trip for the whole gesture: a flick must not lose its
         velocity to test-harness latency between the last move and pointerup */
      await page.mouse.move(x, y + dy, { steps: 12 });
      if (hold) await hold();
      await page.mouse.up();
    };
    const drag = async (dy, hold) => {
      await calendarBox();
      await quickDrag(dy, hold);
    };

    const resetTimeline=async(offset=0)=>{await page.evaluate(offset=>{ASC.mode='all';cm=offset;render();window.__grid=document.querySelector('.cal-month-current .acal');window.__calendar=document.getElementById('calwrap');},offset);await calendarBox();};
    await test('slow drag is 1:1, exposes both months, and preserves the actual grid nodes',async()=>{
      await resetTimeline();const start=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);
      await drag(-280,async()=>{
        const a=await page.evaluate(()=>{const v=document.querySelector('.cal-timeline'),r=v.getBoundingClientRect();return {top:v.scrollTop,visible:[...v.querySelectorAll('.cal-month')].filter(n=>{const b=n.getBoundingClientRect();return b.bottom>r.top+15&&b.top<r.bottom-15;}).length,grid:window.__grid.isConnected,calendar:window.__calendar===document.getElementById('calwrap'),opacity:[...v.querySelectorAll('.acal')].map(e=>getComputedStyle(e).opacity),transform:getComputedStyle(v).transform};});
        assert.ok(Math.abs(a.top-start-280)<2,'not finger-linked: '+JSON.stringify({start,top:a.top,delta:a.top-start}));assert.ok(a.visible>=2);assert.equal(a.grid,true);assert.equal(a.calendar,true);assert.ok(a.opacity.every(o=>o==='1'));assert.equal(a.transform,'none');
        await page.screenshot({path:path.join(shots,'halfway-between-months.png')});await page.waitForTimeout(150);
      });
      const released=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);await page.waitForTimeout(400);assert.equal(await page.locator('.cal-timeline').evaluate(e=>e.scrollTop),released);
      assert.equal(await page.locator('.cal-vstage').count(),0);
    });
    await test('partial drags stay fractional without a commit threshold or month snap',async()=>{
      await resetTimeline();const before=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);
      await drag(-45,()=>page.waitForTimeout(150));await page.waitForTimeout(300);
      assert.ok(Math.abs(await page.locator('.cal-timeline').evaluate(e=>e.scrollTop)-before-45)<2);
    });
    await test('a short flick continues with decelerating inertia and can be interrupted immediately',async()=>{
      await resetTimeline();await drag(-90);const released=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);
      await page.waitForTimeout(100);const moving=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);assert.ok(moving>released+5);
      const b=await calendarBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
      const stopped=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);await page.waitForTimeout(150);assert.equal(await page.locator('.cal-timeline').evaluate(e=>e.scrollTop),stopped);await page.mouse.up();
    });
    await test('drag down reveals the previous month without replacing the moving grid',async()=>{
      await resetTimeline();const before=await page.evaluate(()=>window.__grid.getBoundingClientRect().top);
      await drag(240,()=>page.waitForTimeout(150));assert.ok(Math.abs(await page.evaluate(()=>window.__grid.getBoundingClientRect().top)-before-240)<2);
      assert.equal(await page.evaluate(()=>window.__grid.isConnected),true);
    });
    await test('a held pointer can reverse direction with no snap, replacement or page drift',async()=>{
      await resetTimeline();const b=await calendarBox(),x=b.x+b.width*.52,y=b.y+b.height*.7;
      const before=await page.evaluate(()=>({top:window.__grid.getBoundingClientRect().top,page:scrollY}));
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y-180,{steps:8});await page.mouse.move(x,y-65,{steps:8});
      assert.ok(Math.abs(await page.evaluate(()=>window.__grid.getBoundingClientRect().top)-before.top+65)<2);
      assert.equal(await page.evaluate(()=>scrollY),before.page);assert.equal(await page.evaluate(()=>window.__grid.isConnected),true);
      await page.waitForTimeout(150);await page.mouse.up();
    });
    await test('pointer flick velocity decays smoothly without overshooting or bouncing',async()=>{
      await resetTimeline();await drag(-100);const first=await page.evaluate(()=>window.__grid.getBoundingClientRect().top);
      await page.waitForTimeout(90);const second=await page.evaluate(()=>window.__grid.getBoundingClientRect().top);
      await page.waitForTimeout(90);const third=await page.evaluate(()=>window.__grid.getBoundingClientRect().top);
      assert.ok(first>second&&second>third,JSON.stringify({first,second,third,top:await page.locator('.cal-timeline').evaluate(e=>e.scrollTop),grid:await page.evaluate(()=>window.__grid.isConnected)}));assert.ok(first-second>second-third);
      await page.waitForTimeout(1300);const stopped=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);await page.waitForTimeout(180);assert.equal(await page.locator('.cal-timeline').evaluate(e=>e.scrollTop),stopped);
    });
    await test('month and year headings are gone from inside the scrolling strip',async()=>{
      await resetTimeline();
      const a=await page.evaluate(()=>{
        const v=document.querySelector('.cal-timeline');
        return {titles:v.querySelectorAll('.cal-month-title').length,h3:v.querySelectorAll('h3').length,
          months:v.querySelectorAll('.cal-month').length,
          labels:[...v.querySelectorAll('.cal-month')].every(m=>!!m.getAttribute('aria-label')),
          header:document.querySelector('#calwrap>.cal-timeline-header')?.innerText||'',
          expected:new Date(T.getFullYear(),T.getMonth(),1).toLocaleDateString('en-PH',{month:'long',year:'numeric'}),
          today:!!document.querySelector('#calwrap button[onclick="calToday()"]'),
          arrows:document.querySelectorAll('#calwrap button[onclick^="calGo"]').length};
      });
      assert.equal(a.titles,0,'repeated month title remains');
      assert.equal(a.h3,0,'heading remains inside the strip');
      assert.ok(a.months>=3);
      assert.equal(a.labels,true,'sections need an accessible name');
      assert.ok(a.header.includes(a.expected),'fixed month header missing');
      assert.equal(a.today,true);assert.equal(a.arrows,2);
    });
    for (const [width,height] of [[390,844],[768,1024]]) {
    await test(`${width}x${height}: selecting a date never moves the calendar, even between two months`,async()=>{
      await page.setViewportSize({width,height});
      await resetTimeline();
      // hold still before release so the strip parks at a fixed fractional offset
      await drag(-200,()=>page.waitForTimeout(380));
      await page.waitForTimeout(600); /* settle, then clear the post-drag click suppressor */
      const target=await page.evaluate(()=>{
        const v=document.querySelector('.cal-timeline'),vr=v.getBoundingClientRect();
        const second=[...v.querySelectorAll('.cal-month')].find(s=>{const r=s.getBoundingClientRect();return r.top>vr.top+24&&r.top<vr.bottom-140;});
        const cell=second&&[...second.querySelectorAll('.dc[data-k]')].find(c=>{const r=c.getBoundingClientRect();return !c.classList.contains('x')&&r.top>vr.top+20&&r.bottom<vr.bottom-4;});
        return cell?{k:cell.dataset.k,offset:+second.dataset.offset}:null;
      });
      assert.ok(target,'no partially visible second month to tap');
      const before=await page.evaluate(()=>{
        const v=document.querySelector('.cal-timeline');
        return {scrollTop:v.scrollTop,sections:[...v.querySelectorAll('.cal-month')].map(s=>({o:+s.dataset.offset,top:Math.round(s.getBoundingClientRect().top*10)/10}))};
      });
      await page.evaluate(k=>{
        const c=[...document.querySelectorAll('.cal-timeline .dc[data-k]')].find(x=>x.dataset.k===k&&!x.classList.contains('x'));
        c.click();
      },target.k);
      await page.waitForTimeout(160);
      const after=await page.evaluate(()=>{
        const v=document.querySelector('.cal-timeline');
        return {scrollTop:v.scrollTop,selected:[...v.querySelectorAll('.dc.sel')].map(c=>c.dataset.k),
          sections:[...v.querySelectorAll('.cal-month')].map(s=>({o:+s.dataset.offset,top:Math.round(s.getBoundingClientRect().top*10)/10})),
          mode:ASC.mode,grid:window.__grid.isConnected,calendar:window.__calendar===document.getElementById('calwrap')};
      });
      assert.equal(after.scrollTop,before.scrollTop,'date selection changed the scroll offset');
      assert.deepEqual(after.sections,before.sections,'visible months moved after date selection');
      assert.ok(after.selected.length&&after.selected.every(k=>k===target.k),'selected date not highlighted');
      assert.equal(after.mode,'day');assert.equal(after.grid,true);assert.equal(after.calendar,true);
      assert.ok(target.offset!==0,'the tap was not in the adjacent month');
      await page.screenshot({path:path.join(shots,`selection-between-months-${width}.png`)});
    });
    }
    await page.setViewportSize({width:390,height:844});
    await test('a small flick cannot travel through years',async()=>{
      await resetTimeline();
      const start=await page.locator('.cal-timeline').evaluate(e=>({top:e.scrollTop,height:e.clientHeight,month:cm}));
      await drag(-40);
      await page.waitForTimeout(1400);
      const after=await page.locator('.cal-timeline').evaluate(e=>({top:e.scrollTop,month:cm}));
      const travelled=after.top-start.top;
      assert.ok(travelled<start.height*1.1,'small flick travelled '+travelled+'px');
      assert.ok(Math.abs(after.month-start.month)<=1,'small flick crossed '+(after.month-start.month)+' months');
      const parked=await page.locator('.cal-month-current').evaluate(e=>e.getBoundingClientRect().top);
      await page.waitForTimeout(400);
      assert.ok(Math.abs(await page.locator('.cal-month-current').evaluate(e=>e.getBoundingClientRect().top)-parked)<0.6,'momentum never stopped');
    });
    await test('repeated swipes start from rest and do not add stale velocity',async()=>{
      await resetTimeline();
      const topOf=k=>page.evaluate(k=>{const s=document.querySelector(`.cal-month[data-offset="${k}"]`);return s?s.getBoundingClientRect().top:null;},k);
      const runs=[];
      for(let i=0;i<3;i++){
        const ref=await page.evaluate(()=>+document.querySelector('.cal-month-current').dataset.offset+1);
        await drag(-40);
        const releasedAt=await topOf(ref);
        await page.waitForTimeout(900);
        const restAt=await topOf(ref);
        assert.ok(releasedAt!=null&&restAt!=null,'flick '+(i+1)+' lost its reference month');
        assert.ok(restAt<releasedAt-30,'flick '+(i+1)+' did not move');
        await page.waitForTimeout(200);
        assert.ok(Math.abs(await topOf(ref)-restAt)<0.6,'flick '+(i+1)+' kept coasting');
        runs.push(releasedAt-restAt);
      }
      assert.ok(runs.every(d=>d<600),'a flick ran away: '+runs.join(','));
      assert.ok(Math.max(...runs)-Math.min(...runs)<200,'velocity accumulated: '+runs.join(','));
    });
    await test('a new touch cancels the previous momentum immediately',async()=>{
      await resetTimeline();
      await drag(-220);
      const b=await page.locator('.cal-timeline').boundingBox(),cdp=await context.newCDPSession(page);
      const a=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);
      await page.waitForTimeout(50);
      const moving=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);
      assert.ok(moving>a,'momentum was not running');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:b.x+b.width/2,y:b.y+b.height/2}]});
      const stoppedAt=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);
      await page.waitForTimeout(220);
      assert.equal(await page.locator('.cal-timeline').evaluate(e=>e.scrollTop),stoppedAt,'old momentum survived a touch');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForTimeout(200);
      await cdp.detach();
    });
    await test('rapid flicks do not duplicate calendars, drop input, or corrupt the list',async()=>{
      await resetTimeline();await drag(-120);await quickDrag(-120);await quickDrag(-120);await page.waitForTimeout(1500);
      assert.equal(await page.locator('.cal-vstage').count(),0);assert.equal(await page.locator('#calwrap').count(),1);assert.equal(await page.locator('.cal-timeline').count(),1);
      assert.ok(await page.locator('.cal-month').count()<=9);assert.ok(await page.locator('#app .row').count()>=2);
    });

    await test("previous, next and Today controls share the canonical month state", async () => {
      await resetTimeline();
      const start = await page.evaluate(() => cm);
      await page.locator('#calwrap button[onclick="calGo(1)"]').click();
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => cm), start + 1);
      await page.locator('#calwrap button[onclick="calGo(-1)"]').click();
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => cm), start);
      await page.evaluate(() => (cm = 3, render()));
      await page.locator('#calwrap button[onclick="calToday()"]').click();
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => cm), 0);
    });

    await test("December steps to January and January back to December across the year boundary", async () => {
      await page.evaluate(() => {
        cm = (2026 - T.getFullYear()) * 12 + (11 - T.getMonth());
        render();
      });
      await page.waitForTimeout(120);
      const b=await calendarBox();
      const step=await page.locator('.cal-month').first().evaluate(e=>e.offsetHeight);
      await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.wheel(0,step+10);
      await page.waitForTimeout(500);
      const jan = await page.evaluate(() => ({
        cm,
        month: document.querySelector("#calwrap > div:first-child > div:first-child").firstChild.textContent.trim(),
      }));
      assert.equal(jan.month, "January 2027");
      await page.waitForTimeout(460);
      await page.mouse.wheel(0,-(step+10));
      await page.waitForTimeout(500);
      const dec = await page.evaluate(() => ({
        cm,
        month: document.querySelector("#calwrap > div:first-child > div:first-child").firstChild.textContent.trim(),
      }));
      assert.equal(dec.month, "December 2026");
    });

    await test("wheel/trackpad scrolling is continuous in the native direction", async () => {
      await resetTimeline();
      const b = await calendarBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      const before=await page.evaluate(()=>window.__grid.getBoundingClientRect().top);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(420);
      const after=await page.evaluate(()=>({grid:window.__grid.getBoundingClientRect().top,scroll:document.querySelector('.cal-timeline').scrollTop,page:scrollY,month:cm}));
      assert.ok(Math.abs(after.grid-before+600)<2,JSON.stringify({before,...after}));
      assert.ok(await page.evaluate(() => cm)>0);
      await page.waitForTimeout(460);
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(420);
      assert.equal(await page.evaluate(() => cm), 0);
    });

    for (const [width,height] of [[390,844],[768,1024],[1024,768]]) for(const direction of [-1,1]) {
      await test(`${width}x${height}: real ${direction<0?'up':'down'} touch drag tracks the grid and shows both months`,async()=>{
        await page.setViewportSize({width,height});await resetTimeline();
        const b=await calendarBox(),x=b.x+b.width*.52,y=direction<0?b.y+b.height-35:b.y+35,cdp=await context.newCDPSession(page);
        const before=await page.evaluate(()=>window.__grid.getBoundingClientRect().top),pageTop=await page.evaluate(()=>scrollY);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let i=1;i<=10;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+direction*280*i/10}]});await page.waitForTimeout(25);}
        await page.waitForTimeout(180);
        const during=await page.locator('.cal-timeline').evaluate(e=>{const r=e.getBoundingClientRect();return {top:e.scrollTop,visual:window.__grid.getBoundingClientRect().top,visible:[...e.querySelectorAll('.cal-month')].filter(n=>{const b=n.getBoundingClientRect();return b.bottom>r.top+12&&b.top<r.bottom-12;}).length,opacity:[...e.querySelectorAll('.acal')].every(n=>getComputedStyle(n).opacity==='1')};});
        const displacement=await page.evaluate(()=>window.__grid.getBoundingClientRect().top)-before;
        assert.ok(Math.abs(displacement-direction*280)<22,'native touch tracking '+displacement);assert.ok(during.visible>=2);assert.equal(during.opacity,true);
        assert.equal(await page.evaluate(()=>scrollY),pageTop);assert.equal(await page.evaluate(()=>window.__grid.isConnected),true);
        await page.screenshot({path:path.join(shots,`continuous-touch-${width}-${direction<0?'next':'previous'}.png`)});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(300);
        const releasedVisual=await page.evaluate(()=>window.__grid.getBoundingClientRect().top);
        assert.ok(Math.abs(releasedVisual-during.visual)<1.5,'slow release snapped '+JSON.stringify({during:during.visual,released:releasedVisual}));assert.equal(await page.evaluate(()=>ASC.mode),'all');
        await cdp.detach();
      });
      await test(`${width}x${height}: real short ${direction<0?'up':'down'} touch flick retains native momentum`,async()=>{
        await resetTimeline();const b=await calendarBox(),x=b.x+b.width*.52,y=b.y+b.height*(direction<0?.7:.3),cdp=await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let i=1;i<=5;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+direction*110*i/5}]});await page.waitForTimeout(12);}
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        const released=await page.evaluate(()=>window.__grid.getBoundingClientRect().top);await page.waitForTimeout(160);
        assert.ok((await page.evaluate(()=>window.__grid.getBoundingClientRect().top)-released)*direction>8,'native inertia missing');
        await page.waitForTimeout(1400);const stopped=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);await page.waitForTimeout(150);assert.ok(Math.abs(await page.locator('.cal-timeline').evaluate(e=>e.scrollTop)-stopped)<2);
        assert.equal(await page.locator('.cal-vstage').count(),0);await cdp.detach();
      });
    }
    await test('scrolling outside the calendar continues to scroll the page normally',async()=>{
      await page.setViewportSize({width:390,height:844});await resetTimeline();
      await page.evaluate(()=>{const e=document.createElement('div');e.id='scroll-fixture';e.style.height='700px';document.body.append(e);window.scrollTo(0,0);});
      const before=await page.locator('.cal-timeline').evaluate(e=>e.scrollTop);
      await page.mouse.move(3,12);await page.mouse.wheel(0,150);await page.waitForTimeout(200);
      assert.ok(await page.evaluate(()=>scrollY)>0);assert.equal(await page.locator('.cal-timeline').evaluate(e=>e.scrollTop),before);
      await page.evaluate(()=>document.getElementById('scroll-fixture').remove());
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

    await test("reduced motion retains direct dragging without application inertia or a page stage", async () => {
      const reduced = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
      await reduced.route("**/*", r => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
      const rp = await boot(reduced, origin);
      await rp.evaluate(() => document.querySelector('.cal-timeline').scrollIntoView({ block: "center" }));
      const b = await rp.locator('.cal-timeline').boundingBox(),
        x = Math.floor(b.x + b.width / 2),
        y = Math.floor(b.y + b.height / 2);
      const ref = await rp.evaluate(() => +document.querySelector('.cal-month-current').dataset.offset);
      const topOf = () => rp.evaluate(o => document.querySelector(`.cal-month[data-offset="${o}"] .acal`).getBoundingClientRect().top, ref);
      const before = await topOf();
      await rp.mouse.move(x, y);
      await rp.mouse.down();
      for (let i = 1; i <= 6; i++) await rp.mouse.move(x, y - (140 * i) / 6);
      const during = await rp.evaluate(() => ({
        stage: document.querySelectorAll(".cal-vstage").length,
      }));
      const duringTop = await topOf();
      await rp.mouse.up();
      await rp.waitForTimeout(120);
      assert.equal(during.stage, 0);
      assert.ok(Math.abs(before - duringTop - 140) < 2, "direct drag did not track the pointer");
      const atRelease = await topOf();
      assert.ok(Math.abs(atRelease - duringTop) < 1.5, "reduced motion moved after release");
      await rp.waitForTimeout(320);
      const settled = await topOf();
      assert.ok(Math.abs(settled - atRelease) < 1.5, "reduced motion kept a momentum loop");
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
