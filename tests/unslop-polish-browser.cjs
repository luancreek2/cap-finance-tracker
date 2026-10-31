/* Selected C1/C2/H1/H2 presentation regressions. Isolated synthetic data only;
   no real configuration, authentication, external IO, or service-worker writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
if (!process.env.CAP_PLAYWRIGHT_PATH) {
  console.log('SKIP polish browser: set CAP_PLAYWRIGHT_PATH');
  process.exit(0);
}
const { chromium } = require(process.env.CAP_PLAYWRIGHT_PATH);
const root = path.resolve(__dirname, '..');
const shots = path.join(process.env.TEMP, 'opencode', 'cap-unslop-polish');
let server, browser, passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
const luminance = rgb => {
  const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
    v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  });
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
};
const contrast = (a, b) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};
(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (['/supabase-config.js', '/supabase-config.local.js'].includes(url.pathname)) {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end('window.CAP_SUPABASE_CONFIG={};');
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
      res.writeHead(err ? 404 : 200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(err ? 'Missing' : data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const external = [], errors = [];
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.CapFinancialHealth && !window.capLaunchActive);
  await page.evaluate(() => {
    localStorage.setItem('cap_whats_new_seen_version', APP_VERSION);
    if (document.querySelector('.whats-new-overlay')) closeWhatsNew();
    document.querySelector('#cap-auth')?.remove();
    const date = CapSmartLogParser.localDate(new Date());
    const long = 'Household essentials and exceptionally long category names';
    CATS[long] = '•';
    S.accts = [{ id: 1, name: 'Polish fixture cash', bank: 'Fixture', type: 'debit', bal: 18000, img: 'cash', g: ['#123456', '#234567'] }];
    S.tx = ['Food', long, 'Shopping', 'Transport', 'Bills', 'Salary'].map((cat, i) => ({ id: i + 1, d: date, amt: i === 5 ? 12000 : -(1250 + i * 200), cat, acct: 1, note: cat }));
    S.tx.push({ id: 7, d: CapFinancialSearchParser.shift(date, -35), amt: -100, cat: 'Food', acct: 1, note: 'Prior month fixture' });
    S.cats = Object.keys(CATS).map((n, i) => ({ id: i + 1, n, i: '•' }));
    S.budgets = { Food: 2000 }; S.bills = []; S.pend = []; S.xfer = []; S.goals = []; S.debts = []; S.hide = 0;
    tab = 'Home'; render();
    window.__polishFinancial = JSON.stringify(S);
  });
  const finish = () => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
  const health = page.locator('#cap-financial-health');
  for (const width of [375, 390, 430, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const theme of ['light', 'dark', 'auto', 'apple', 'bluish-white']) {
        const label = `${width}px ${theme} / OS ${scheme}`;
        await page.evaluate(t => { localStorage.setItem('cap-appearance-theme', t); applyTheme(); }, theme);
        await finish();
        await test(label + ': category, percentage and exact amount fit without clipping', async () => {
          const rows = await page.locator('.spend-legend-row').evaluateAll(elements => elements.map(e => {
            const name = e.querySelector('.spend-legend-name'), amount = e.querySelector('.spend-legend-amt'), pct = e.querySelector('.spend-legend-pct');
            const r = e.getBoundingClientRect(), n = name.getBoundingClientRect(), a = amount.getBoundingClientRect();
            return { display: getComputedStyle(amount).display, name: name.textContent, amount: amount.textContent, pct: pct.textContent,
              fits: n.right <= a.left + 1 && a.right <= r.right + 1 && amount.scrollWidth <= amount.clientWidth + 1 && (name.scrollWidth <= name.clientWidth + 1 || (innerWidth > 430 && getComputedStyle(name).textOverflow === 'ellipsis')),
              grid: getComputedStyle(e.parentElement).gridTemplateColumns.split(' ').length };
          }));
          assert.equal(rows.length, 5);
          for (const row of rows) { assert.notEqual(row.display, 'none'); assert.match(row.amount, /₱[\d,]+\.\d{2}/); assert.match(row.pct, /\d+%/); assert.ok(row.fits, JSON.stringify(row)); if (width <= 430) assert.equal(row.grid, 1); }
          assert.ok(rows.some(r => r.name.includes('exceptionally long')));
        });
        await test(label + ': selection is theme-aware, readable, without glow; green remains financial', async () => {
          const colors = await page.evaluate(() => {
            const s = getComputedStyle(document.querySelector('.spend-month-tab.on'));
            const probe = document.createElement('span'); document.body.append(probe);
            const resolve = token => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
            const result = { fg: s.color, bg: s.backgroundColor, ac: resolve('--selection-fill'), green: resolve('--g'), shadow: s.boxShadow, ink: getComputedStyle(document.querySelector('.spend-months-ink')).visibility, scheme: getComputedStyle(document.documentElement).colorScheme };
            probe.remove(); return result;
          });
          assert.equal(colors.bg, colors.ac); assert.notEqual(colors.ac, colors.green);
          assert.equal(colors.shadow, 'none'); assert.equal(colors.ink, 'hidden');
          assert.ok(contrast(colors.fg, colors.bg) >= 4.5, JSON.stringify(colors));
          assert.equal(colors.scheme, theme === 'dark' || (['auto', 'apple'].includes(theme) && scheme === 'dark') ? 'dark' : 'light');
        });
        await test(label + ': privacy mask hides legend digits without layout movement', async () => {
          const before = await page.locator('.spend-legend-row').first().boundingBox();
          await page.evaluate(() => bvToggle()); await finish();
          const masked = await page.locator('.spend-legend-amt').first().evaluate(e => ({ ink: getComputedStyle(e).webkitTextFillColor, dots: getComputedStyle(e, '::after').content, opacity: getComputedStyle(e, '::after').opacity }));
          assert.equal(masked.ink, 'rgba(0, 0, 0, 0)'); assert.equal(masked.dots, '"••••••"'); assert.equal(masked.opacity, '1');
          const after = await page.locator('.spend-legend-row').first().boundingBox();
          assert.equal(after.width, before.width); assert.equal(after.height, before.height);
          await page.evaluate(() => bvToggle()); await finish();
        });
        await test(label + ': Health geometry, gauge hierarchy and metadata fit', async () => {
          await page.evaluate(() => CapFinancialHealth.open()); await health.waitFor({ state: 'visible' }); await finish();
          const layout = await health.evaluate(e => {
            const css = sel => getComputedStyle(e.querySelector(sel));
            return { fits: e.querySelector('.fh-body').scrollWidth <= e.querySelector('.fh-body').clientWidth,
              radius: css('.fh-overall').borderRadius, circles: getComputedStyle(e.querySelector('.fh-overall'), '::before').content,
              wash: getComputedStyle(e).backgroundImage, title: parseFloat(css('.fh-header h2').fontSize), score: parseFloat(css('.fh-gauge b').fontSize),
              period: parseFloat(css('.fh-period').fontSize), factor: parseFloat(css('.fh-factor-description').fontSize), centerShadow: css('.fh-gauge-center').boxShadow };
          });
          assert.equal(layout.fits, true); assert.equal(layout.radius, '20px'); assert.equal(layout.circles, 'none');
          assert.equal(layout.wash, 'none'); assert.equal(layout.centerShadow, 'none'); assert.ok(layout.score > layout.title * 2);
          assert.ok(layout.period >= 11 && layout.factor >= 11);
          await page.getByRole('button', { name: 'Close Financial Health', exact: true }).click();
        });
      }
    }
  }
  await test('Light semantic green and small muted labels meet 4.5:1 on card surfaces', async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    const colors = await page.evaluate(() => {
      localStorage.setItem('cap-appearance-theme', 'light'); applyTheme();
      const e = document.createElement('span'); document.body.append(e);
      const resolve = t => { e.style.color = `var(${t})`; return getComputedStyle(e).color; };
      const result = ['--g', '--mut', '--card'].map(resolve); e.remove(); return result;
    });
    assert.ok(contrast(colors[0], colors[2]) >= 4.5); assert.ok(contrast(colors[1], colors[2]) >= 4.5);
  });
  await test('legend keyboard activation still spotlights the matching donut arc', async () => {
    const row = page.locator('.spend-legend-row').first(); await row.focus(); await row.press('Enter');
    assert.equal(await row.getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('.spend-arc.on').count(), 1);
    assert.equal(await row.evaluate(e => getComputedStyle(e).outlineStyle), 'solid'); await row.press('Enter');
    assert.equal(await row.getAttribute('aria-pressed'), 'false');
  });
  await test('reel arrow navigation, year menu and focus indicator retain their behavior', async () => {
    const selected = page.locator('.spend-month-tab.on'); const month = await selected.getAttribute('data-m');
    await selected.focus(); await selected.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelectorAll('.spend-legend-row').length === 1); await finish();
    assert.notEqual(await selected.getAttribute('data-m'), month);
    assert.equal(await selected.evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
    await page.locator('#sp-year-btn').click(); assert.equal(await page.locator('#sp-year-btn').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#sp-year-btn').evaluate(e => getComputedStyle(e).boxShadow), 'none');
    await page.keyboard.press('Escape'); await page.evaluate(() => { spendReset(); render(); }); await finish();
  });
  await test('Activity events and Search metadata are readable; scope controls retain focus', async () => {
    await page.evaluate(() => { tab = 'Activity'; render(); }); await page.setViewportSize({ width: 375, height: 900 }); await finish();
    const trigger = page.locator('.as-pills .account-options-button'); await trigger.focus();
    assert.equal(await trigger.evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
    await trigger.click(); await page.locator('#activity-options-menu').waitFor({ state: 'visible' });
    const events = await page.locator('.acal .ap').evaluateAll(es => es.map(e => parseFloat(getComputedStyle(e).fontSize)));
    assert.ok(events.length > 0); assert.ok(events.every(n => n >= 11));
    await page.keyboard.press('Escape');
    await page.evaluate(() => { tab = 'Home'; render(); CapCommandBar.open(); CapCommandBar.setMode('search'); });
    const input = page.locator('#cap-command-input'); await input.fill('Food this month'); await input.press('Enter');
    await page.locator('.fs-results').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.fs-row-main small').first().evaluate(e => getComputedStyle(e).fontSize), '12px');
    assert.equal(await page.locator('.fs-note').first().evaluate(e => getComputedStyle(e).fontSize), '11px');
    await page.evaluate(() => CapCommandBar.close());
  });
  await test('OS and Cap reduced-motion modes retain visible masked values and Health content', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => CapFinancialHealth.open());
    assert.equal(await health.evaluate(e => getComputedStyle(e).animationName), 'none');
    assert.equal(await page.locator('.fh-factor').count(), 6);
    await page.getByRole('button', { name: 'Close Financial Health', exact: true }).click();
    for (const mode of ['rm', 'noanim']) {
      await page.evaluate(m => { document.documentElement.classList.add(m); bvToggle(); }, mode);
      assert.ok(parseFloat(await page.locator('.spend-legend-amt').first().evaluate(e => getComputedStyle(e, '::after').transitionDuration)) <= .001);
      await page.evaluate(m => { bvToggle(); document.documentElement.classList.remove(m); }, mode);
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await test('all presentation interactions preserve synthetic financial state with no external IO', async () => {
    const state = await page.evaluate(() => ({ actual: JSON.parse(JSON.stringify(S)), expected: JSON.parse(__polishFinancial) }));
    // The existing bvToggle() persists the device preference through save(),
    // advancing only the root save timestamp. Record timestamps must not change.
    assert.ok(state.actual._mt >= state.expected._mt);
    state.actual._mt = state.expected._mt;
    assert.deepEqual(state.actual, state.expected);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
  fs.mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => { tab = 'Home'; render(); }); await finish();
  await page.locator('.spend-card').screenshot({ path: path.join(shots, 'spending-390-light.png') });
  await page.evaluate(() => CapFinancialHealth.open()); await finish();
  await page.screenshot({ path: path.join(shots, 'health-390-light.png') });
  await page.getByRole('button', { name: 'Close Financial Health', exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.evaluate(() => { localStorage.setItem('cap-appearance-theme', 'dark'); applyTheme(); CapFinancialHealth.open(); }); await finish();
  await page.screenshot({ path: path.join(shots, 'health-1024-dark.png') });
  console.log(`PASS: ${passed} selected polish browser checks; screenshots: ${shots}`);
  await context.close();
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
