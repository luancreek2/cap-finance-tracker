/* Second polish pass: H3 Smart Log hierarchy, H4 44px hit areas, M2 selective
   spacing/radii, and M5 faithful Appearance previews. Isolated synthetic data
   only; no live configuration, authentication, external IO or ledger writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
if (!process.env.CAP_PLAYWRIGHT_PATH) {
  console.log('SKIP Pass 2 polish browser: set CAP_PLAYWRIGHT_PATH');
  process.exit(0);
}
const { chromium } = require(process.env.CAP_PLAYWRIGHT_PATH);
const root = path.resolve(__dirname, '..');
const shots = path.join(process.env.TEMP, 'opencode', 'cap-unslop-pass2');
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
const alpha = color => {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(Number);
    return parts.length > 3 ? parts[3] : 1;
  }
  const modern = color.match(/color\(srgb[^)]*\/\s*([\d.]+)\s*\)/);
  return modern ? Number(modern[1]) : 1;
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
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.CapFinancialHealth && window.CapCommandBar && !window.capLaunchActive);
  await page.evaluate(() => {
    localStorage.setItem('cap_whats_new_seen_version', APP_VERSION);
    if (document.querySelector('.whats-new-overlay')) closeWhatsNew();
    document.querySelector('#cap-auth')?.remove();
    const date = CapSmartLogParser.localDate(new Date());
    S.accts = [
      { id: 1, name: 'BDO Debit', bank: 'BDO', type: 'debit', bal: 18000, img: 'cash', g: ['#123456', '#234567'] },
      { id: 2, name: 'Maya Wallet', bank: 'Maya', type: 'ewallet', bal: 5000, g: ['#123456', '#234567'] }
    ];
    S.tx = ['Food', 'Groceries', 'Shopping', 'Transport', 'Bills', 'Salary'].map((cat, i) => ({
      id: i + 1, d: date, amt: i === 5 ? 12000 : -(1250 + i * 200), cat, acct: 1, note: cat
    }));
    S.cats = Object.keys(CATS).map((n, i) => ({ id: i + 1, n, i: '•' }));
    S.budgets = { Food: 2000 }; S.bills = []; S.pend = []; S.xfer = []; S.goals = []; S.debts = []; S.hide = 0;
    tab = 'Home'; render();
    window.__pass2Financial = JSON.stringify(S);
  });
  const finish = () => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
  const setEnv = async (width, theme, scheme = 'light') => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(t => {
      localStorage.setItem('cap-appearance-theme', t);
      applyTheme();
      if (document.querySelector('#sheet') && typeof closeS === 'function') closeS();
      tab = 'Home'; render();
    }, theme);
    await finish();
  };
  const openLog = async text => {
    await page.evaluate(() => { CapCommandBar.open(); CapCommandBar.setMode('log'); });
    await page.waitForFunction(() => CapCommandBar.getState().state === 'open');
    await page.locator('#cap-command-input').fill(text);
    await page.locator('#cap-command-input').press('Enter');
    await page.locator('.sl-preview').waitFor({ state: 'visible' });
    await finish();
  };
  const closeLog = async () => {
    await page.evaluate(() => CapCommandBar.close());
    await page.waitForFunction(() => CapCommandBar.getState().state === 'closed');
  };
  const openSearch = async text => {
    await page.evaluate(() => { CapCommandBar.open(); CapCommandBar.setMode('search'); });
    await page.waitForFunction(() => CapCommandBar.getState().state === 'open');
    await page.locator('#cap-command-input').fill(text);
    await page.locator('#cap-command-input').press('Enter');
    await page.locator('.fs-results').waitFor({ state: 'visible' });
    await finish();
  };
  const resolve = value => page.evaluate(v => {
    const probe = document.createElement('span');
    probe.style.color = v; document.body.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  }, value);

  await test('H3: Smart Log keeps one receipt surface and makes the amount the strongest element', async () => {
    await setEnv(390, 'light');
    await openLog('Spent 450 at Jollibee using BDO today');
    assert.equal(await page.locator('.sl-merchant').innerText(), 'Jollibee');
    assert.equal(await page.locator('.sl-detail-type b').innerText(), 'Expense');
    assert.equal(await page.locator('.sl-brand-logo').count(), 1, 'merchant artwork remains');
    assert.equal(await page.locator('.sl-account-art').count(), 1, 'account artwork remains');
    assert.match(await page.locator('.sl-amount').innerText(), /450/);
    assert.equal(await page.locator('.sl-confirm').isDisabled(), false, 'confirmation remains available');
    const style = await page.evaluate(() => {
      const read = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
      const preview = read('.sl-preview'), ticket = read('.sl-ticket'), receipt = read('.sl-receipt');
      const heading = read('.sl-heading h3'), amount = read('.sl-amount'), merchant = read('.sl-merchant');
      return {
        previewRadius: parseFloat(preview.borderTopLeftRadius), previewBorder: preview.borderTopWidth,
        ticketRadius: parseFloat(ticket.borderTopLeftRadius), ticketBorder: ticket.borderTopWidth,
        ticketImage: ticket.backgroundImage, receiptBorder: receipt.borderTopWidth,
        heading: parseFloat(heading.fontSize), amount: parseFloat(amount.fontSize), merchant: parseFloat(merchant.fontSize),
        amountColor: amount.color, typeColor: read('.sl-type-value').color,
        grid: read('.sl-grid').display, foil: read('.sl-foil').display,
        ticketAlpha: getComputedStyle(document.querySelector('.sl-ticket')).backgroundColor
      };
    });
    assert.equal(style.previewBorder, '1px', 'popup is the one outlined surface');
    assert.equal(style.ticketBorder, '0px', 'receipt has no nested border');
    assert.equal(style.receiptBorder, '0px');
    assert.equal(style.ticketImage, 'none', 'receipt has no grid, foil or gradient paint');
    assert.equal(style.grid, 'none', 'retired grid stays hidden');
    assert.equal(style.foil, 'none', 'retired foil stays hidden');
    assert.ok(style.previewRadius > style.ticketRadius, 'receipt radius is visibly smaller than the popup');
    assert.ok(alpha(style.ticketAlpha) > 0 && alpha(style.ticketAlpha) < .1, 'receipt tint stays subtle');
    assert.ok(style.amount >= style.merchant * 1.8, 'amount dominates the merchant name');
    assert.ok(style.amount >= style.heading * 2.5, 'amount dominates the quiet heading');
    assert.ok(style.merchant > style.heading, 'merchant remains stronger than the section label');
    assert.equal(style.typeColor, style.amountColor, 'semantic accent remains on the type value');
    await page.locator('.sl-preview').screenshot({ path: path.join(shots, 'smart-log-390-light.png') });
    await closeLog();
  });

  for (const theme of ['light', 'dark', 'auto', 'apple', 'bluish-white']) {
    await test('H3: ' + theme + ' Smart Log keeps hierarchy, tint and retire decoration', async () => {
      await setEnv(390, theme);
      await openLog('Spent 450 at Jollibee using BDO today');
      const a = await page.evaluate(() => {
        const read = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
        return {
          amount: parseFloat(read('.sl-amount').fontSize), merchant: parseFloat(read('.sl-merchant').fontSize),
          heading: parseFloat(read('.sl-heading h3').fontSize),
          previewRadius: parseFloat(read('.sl-preview').borderTopLeftRadius),
          ticketRadius: parseFloat(read('.sl-ticket').borderTopLeftRadius),
          ticketBorder: read('.sl-ticket').borderTopWidth, grid: read('.sl-grid').display, foil: read('.sl-foil').display,
          previewImage: read('.sl-preview').backgroundImage, ticketImage: read('.sl-ticket').backgroundImage
        };
      });
      assert.ok(a.amount >= a.merchant * 1.8, theme + ' amount is strongest');
      assert.ok(a.merchant > a.heading, theme + ' merchant outranks the label');
      assert.ok(a.previewRadius > a.ticketRadius, theme + ' radius hierarchy');
      assert.equal(a.ticketBorder, '0px');
      assert.equal(a.grid, 'none'); assert.equal(a.foil, 'none');
      assert.equal(a.previewImage, 'none', theme + ' popup has no decorative wash');
      assert.equal(a.ticketImage, 'none', theme + ' receipt has no decorative paint');
      if (theme === 'apple') await page.locator('.sl-preview').screenshot({ path: path.join(shots, 'smart-log-390-apple.png') });
      await closeLog();
    });
  }

  for (const width of [375, 390, 430, 1024]) {
    await test('H4: ' + width + 'px chart ranges keep compact labels with 44px non-overlapping hit areas', async () => {
      await setEnv(width, 'light');
      await page.locator('.rts').scrollIntoViewIfNeeded();
      const ranges = await page.locator('.rt').evaluateAll(elements => elements.map(e => {
        const r = e.getBoundingClientRect(), p = getComputedStyle(e, '::after');
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height,
          extTop: parseFloat(p.top), extBottom: parseFloat(p.bottom), content: p.content };
      }));
      assert.ok(ranges.length >= 5);
      for (const range of ranges) {
        assert.ok(range.height >= 28 && range.height <= 32, 'label stays visually compact');
        assert.equal(range.content, '""');
        const effective = range.height - range.extTop - range.extBottom;
        assert.ok(effective >= 44 && effective <= 46, JSON.stringify(range));
        assert.ok(range.extTop < 0 && range.extBottom < 0, 'invisible extension only');
      }
      for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i - 1].right <= ranges[i].left + .5, 'adjacent ranges do not overlap');
      const chartBox = await page.locator('.ch').boundingBox();
      assert.ok(ranges[0].bottom - ranges[0].extBottom <= chartBox.y + 1, 'extension does not cover the chart ' + JSON.stringify({ chartTop: chartBox.y, bottom: ranges[0].bottom, extBottom: ranges[0].extBottom }));
      const hits = await page.locator('.rt').evaluateAll(elements => elements.map(e => {
        const r = e.getBoundingClientRect();
        const above = document.elementFromPoint(r.left + r.width / 2, r.top - 4);
        const below = document.elementFromPoint(r.left + r.width / 2, Math.min(innerHeight - 1, r.bottom + 4));
        return { above: above === e || e.contains(above), below: below === e || e.contains(below) };
      }));
      assert.ok(hits.every(h => h.above && h.below), 'both invisible extensions are hit-testable');
      await page.locator('.rt').first().focus();
      const rangeFocus = await page.locator('.rt').first().evaluate(e => ({
        active: document.activeElement === e, style: getComputedStyle(e).outlineStyle, width: getComputedStyle(e).outlineWidth
      }));
      assert.equal(rangeFocus.active, true);
      assert.notEqual(rangeFocus.style, 'none'); assert.notEqual(rangeFocus.width, '0px');
      if (width === 390) await page.locator('.spend-card').screenshot({ path: path.join(shots, 'spending-390-light.png') });
    });
  }

  await test('H4: spending month and year controls keep 32px visuals with 44px non-overlapping targets', async () => {
    await setEnv(390, 'light');
    await page.evaluate(() => document.querySelector('.spend-months').scrollIntoView({ block: 'center' }));
    await finish();
    const controls = await page.evaluate(() => {
      const read = sel => {
        const e = document.querySelector(sel), r = e.getBoundingClientRect(), p = getComputedStyle(e, '::after');
        return { height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
          extTop: parseFloat(p.top), extBottom: parseFloat(p.bottom), content: p.content };
      };
      return { month: read('.spend-month-tab.on'), year: read('#sp-year-btn') };
    });
    for (const [name, c] of Object.entries(controls)) {
      assert.ok(c.height >= 30 && c.height <= 32, name + ' stays visually compact');
      assert.equal(c.content, '""');
      const effective = c.height - c.extTop - c.extBottom;
      assert.ok(effective >= 44 && effective <= 46, name + ' has a 44px target');
      const hit = await page.locator(name === 'month' ? '.spend-month-tab.on' : '#sp-year-btn').evaluate(e => {
        const r = e.getBoundingClientRect();
        const above = document.elementFromPoint(r.left + r.width / 2, r.top - 4);
        const below = document.elementFromPoint(r.left + r.width / 2, Math.min(innerHeight - 1, r.bottom + 4));
        const label = n => n ? (n.tagName + '.' + n.className) : 'null';
        return { above: above === e || e.contains(above), below: below === e || e.contains(below), aboveNode: label(above), belowNode: label(below), rect: { top: r.top, bottom: r.bottom } };
      });
      assert.ok(hit.above && hit.below, name + ' extension is hit-testable above and below ' + JSON.stringify(hit));
    }
    const months = await page.locator('.spend-month-tab').evaluateAll(elements => elements.map(e => {
      const r = e.getBoundingClientRect(); return { left: r.left, right: r.right };
    }));
    for (let i = 1; i < months.length; i++) assert.ok(months[i - 1].right <= months[i].left + .5, 'month targets do not overlap');
    await page.locator('.spend-month-tab.on').focus();
    assert.equal(await page.locator('.spend-month-tab.on').evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
    await page.locator('#sp-year-btn').click();
    await page.locator('.spend-year-menu.open').waitFor({ state: 'visible' });
    await finish();
    const options = await page.locator('.spend-year-opt').evaluateAll(es => es.map(e => e.offsetHeight));
    assert.ok(options.length > 0 && options.every(h => h >= 44), 'year options expose full-height rows ' + JSON.stringify(options));
    await page.keyboard.press('Escape');
  });

  await test('M2: Home, Search, Smart Log, Appearance and Health use intentional, nested radii and spacing', async () => {
    await setEnv(390, 'light');
    const home = await page.evaluate(() => {
      const cs = sel => getComputedStyle(document.querySelector(sel));
      return {
        padding: cs('.spend-card').padding, margin: cs('.spend-card').marginBottom, head: cs('.spend-head').marginBottom,
        row: cs('.spend-legend-row').paddingTop, insight: cs('.spend-insight').borderTopLeftRadius,
        card: cs('.card').borderTopLeftRadius
      };
    });
    assert.equal(home.padding, '16px'); assert.equal(home.margin, '12px'); assert.equal(home.head, '8px');
    assert.equal(home.row, '8px', 'mobile two-line legend keeps its existing row padding'); assert.equal(home.insight, '12px');
    assert.equal(home.card, '20px', 'unrelated generic cards keep their radius');
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.evaluate(() => render()); await finish();
    assert.equal(await page.locator('.spend-legend-row').first().evaluate(e => getComputedStyle(e).paddingTop), '6px', 'wide legend rows use the normalized spacing');
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => render()); await finish();
    await page.evaluate(() => { tab = 'Activity'; render(); });
    await finish();
    assert.equal(await page.locator('.as-pills .account-options-button').evaluate(e => getComputedStyle(e).borderTopLeftRadius), '50%', 'no global radius override');
    await page.evaluate(() => { tab = 'Home'; render(); });
    await finish();
    await openSearch('Food this month');
    const search = await page.evaluate(() => {
      const cs = sel => getComputedStyle(document.querySelector(sel));
      return { radius: cs('.fs-results').borderTopLeftRadius, padding: cs('.fs-results').padding,
        row: cs('.fs-row').paddingTop, summary: cs('.fs-summary').marginTop, gap: cs('.fs-chips').gap };
    });
    assert.equal(search.radius, '20px'); assert.equal(search.padding, '16px'); assert.equal(search.row, '12px');
    assert.equal(search.summary, '24px'); assert.equal(search.gap, '6px');
    await closeLog();
    await openLog('Spent 450 at Jollibee using BDO today');
    const log = await page.evaluate(() => {
      const cs = sel => getComputedStyle(document.querySelector(sel));
      const brand = document.querySelector('.sl-brand-logo'), art = brand && brand.firstElementChild;
      return { preview: parseFloat(cs('.sl-preview').borderTopLeftRadius), ticket: parseFloat(cs('.sl-ticket').borderTopLeftRadius),
        art: art ? parseFloat(getComputedStyle(art).borderTopLeftRadius) : 0 };
    });
    assert.ok(log.preview > log.ticket && log.ticket > log.art, 'receipt radii nest visibly smaller');
    await closeLog();
    await page.evaluate(() => stGo('appearance'));
    await page.locator('.appearance-themes').waitFor({ state: 'visible' }); await finish();
    const appearance = await page.evaluate(() => {
      const cs = sel => getComputedStyle(document.querySelector(sel));
      return { choice: parseFloat(cs('.theme-choice').borderTopLeftRadius), preview: parseFloat(cs('.theme-preview').borderTopLeftRadius),
        art: parseFloat(cs('.theme-preview>i').borderTopLeftRadius) };
    });
    assert.ok(appearance.choice > appearance.preview && appearance.preview > appearance.art, 'preview radii nest inside the choice');
    await page.evaluate(() => closeS());
    await page.waitForTimeout(350);
    await page.evaluate(() => CapFinancialHealth.open());
    await page.locator('#cap-financial-health').waitFor({ state: 'visible' }); await finish();
    const health = await page.evaluate(() => {
      const panel = document.querySelector('#cap-financial-health'), body = panel.querySelector('.fh-body');
      return { radius: getComputedStyle(panel.querySelector('.fh-overall')).borderTopLeftRadius,
        wash: getComputedStyle(panel).backgroundImage, center: getComputedStyle(panel.querySelector('.fh-gauge-center')).boxShadow,
        fits: body.scrollWidth <= body.clientWidth + 1 };
    });
    assert.equal(health.radius, '20px'); assert.equal(health.wash, 'none'); assert.equal(health.center, 'none'); assert.equal(health.fits, true);
    await page.getByRole('button', { name: 'Close Financial Health', exact: true }).click();
  });

  await test('M5: all five previews paint real theme surfaces, ink, accent and dock selection', async () => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => { localStorage.setItem('cap-appearance-theme', 'light'); applyTheme(); stGo('appearance'); });
    await page.locator('.appearance-themes').waitFor({ state: 'visible' }); await finish();
    assert.equal(await page.locator('.theme-choice .theme-preview').count(), 5);
    const expected = {
      light: { bg: '#f3f3f7', card: '#fff', ink: '#111', secondary: '#6c6c70', accent: '#111', line: '#e6e6ec', selection: '#111' },
      dark: { bg: '#0a0a0c', card: '#17171b', ink: '#f5f5f7', secondary: '#9a9aa3', accent: '#fff', line: '#26262c', selection: '#fff' },
      apple: { bg: '#f5f5f7', card: '#fff', ink: '#1c1c1e', secondary: '#606064', accent: '#005cc8', line: '#e5e5ea', selection: 'rgba(28,28,30,.94)' },
      'bluish-white': { bg: '#f5f8fc', card: '#fff', ink: '#172033', secondary: '#657287', accent: '#3977f6', line: '#e2e9f3', selection: '#e9f0ff' }
    };
    for (const [theme, roles] of Object.entries(expected)) {
      await page.evaluate(t => { localStorage.setItem('cap-appearance-theme', t); applyTheme(); }, theme);
      const preview = await page.evaluate(() => {
        const e = document.querySelector('.preview-' + (localStorage.getItem('cap-appearance-theme') === 'bluish-white' ? 'bluish-white' : localStorage.getItem('cap-appearance-theme')));
        const s = getComputedStyle(e);
        return { bg: s.getPropertyValue('--preview-bg').trim(), card: s.getPropertyValue('--preview-card').trim(),
          ink: s.getPropertyValue('--preview-ink').trim(), secondary: s.getPropertyValue('--preview-secondary').trim(),
          accent: s.getPropertyValue('--preview-accent').trim(), line: s.getPropertyValue('--preview-line').trim(),
          selection: s.getPropertyValue('--preview-selection').trim(),
          image: s.backgroundImage, shadow: s.boxShadow,
          navSelection: getComputedStyle(e.querySelector('.preview-nav b')).backgroundColor,
          row: getComputedStyle(e.querySelector('.preview-row')).backgroundColor,
          heading: getComputedStyle(e.querySelector('.preview-heading')).backgroundColor,
          balance: getComputedStyle(e.querySelector('.preview-balance')).backgroundColor
        };
      });
      assert.equal(await resolve(preview.bg), await resolve(roles.bg), theme + ' page surface');
      assert.equal(await resolve(preview.card), await resolve(roles.card), theme + ' card surface');
      assert.equal(await resolve(preview.ink), await resolve(roles.ink), theme + ' primary ink');
      assert.equal(await resolve(preview.secondary), await resolve(roles.secondary), theme + ' secondary ink');
      assert.equal(await resolve(preview.accent), await resolve(roles.accent), theme + ' accent');
      assert.equal(await resolve(preview.line), await resolve(roles.line), theme + ' divider');
      assert.equal(await resolve(preview.selection), await resolve(roles.selection), theme + ' dock selection');
      assert.equal(await resolve(preview.navSelection), await resolve(roles.selection), 'drawn dock selection matches the theme');
      assert.equal(await resolve(preview.row), await resolve(roles.accent), 'drawn accent matches the theme');
      assert.equal(await resolve(preview.heading), await resolve(roles.secondary), 'preview heading uses secondary text');
      assert.equal(await resolve(preview.balance), await resolve(roles.ink), 'preview balance uses primary text');
      assert.equal(preview.image, 'none', theme + ' has no decorative wash');
      assert.equal(preview.shadow, 'none', theme + ' has no glow');
      assert.ok(contrast(await resolve(preview.ink), await resolve(preview.card)) >= 4.5, theme + ' preview text is readable');
      if (theme === 'apple') await page.locator('.theme-choice').nth(3).screenshot({ path: path.join(shots, 'appearance-apple-390.png') });
    }
    const auto = await page.evaluate(() => {
      const e = document.querySelector('.preview-auto'), s = getComputedStyle(e);
      return { bg: s.getPropertyValue('--preview-bg'), card: s.getPropertyValue('--preview-card'),
        ink: s.getPropertyValue('--preview-ink'), selection: s.getPropertyValue('--preview-selection'),
        image: s.backgroundImage, shadow: s.boxShadow };
    });
    assert.match(auto.image, /linear-gradient/);
    assert.match(auto.bg, /#f3f3f7/); assert.match(auto.bg, /#0a0a0c/); assert.match(auto.bg, /50%/);
    assert.match(auto.card, /#fff/); assert.match(auto.card, /#17171b/);
    assert.match(auto.ink, /#111/); assert.match(auto.ink, /#f5f5f7/);
    assert.match(auto.selection, /#111/); assert.match(auto.selection, /#fff/);
    assert.equal(auto.shadow, 'none');
    await page.evaluate(() => { localStorage.setItem('cap-appearance-theme', 'light'); applyTheme(); closeS(); });
  });

  for (const width of [375, 390, 430, 1024]) {
    for (const theme of ['light', 'dark', 'auto', 'apple', 'bluish-white']) {
      for (const scheme of ['light', 'dark']) {
        if (width !== 390 && scheme === 'dark') continue;
        const label = `${width}px ${theme} / OS ${scheme}`;
        await test(label + ': Home, Appearance, Smart Log, Search and Health fit without clipping', async () => {
          await setEnv(width, theme, scheme);
          const home = await page.evaluate(() => {
            const card = document.querySelector('.spend-card').getBoundingClientRect();
            const row = document.querySelector('.spend-months').getBoundingClientRect();
            return { overflow: document.documentElement.scrollWidth - innerWidth, card: card.right <= innerWidth + 1 && card.left >= 0,
              row: row.height };
          });
          assert.ok(home.overflow <= 1, 'no horizontal page overflow'); assert.equal(home.card, true); assert.equal(home.row, 44);
          await page.evaluate(() => stGo('appearance'));
          await page.locator('.appearance-themes').waitFor({ state: 'visible' }); await finish();
          const appearance = await page.evaluate(() => ['.theme-choice'].length && [...document.querySelectorAll('.theme-choice')].every(e => {
            const r = e.getBoundingClientRect(), p = e.querySelector('.theme-preview').getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth + 1 && p.width > 0 && p.height === 64;
          }));
          assert.equal(appearance, true);
          await page.evaluate(() => closeS());
          await page.waitForTimeout(350);
          await openLog('Spent 450 at Jollibee using BDO today');
          const log = await page.evaluate(() => {
            const p = document.querySelector('.sl-preview').getBoundingClientRect(), a = document.querySelector('.sl-amount').getBoundingClientRect();
            return { fits: p.left >= 0 && p.right <= innerWidth + 1 && p.top >= 0, amount: a.right <= p.right + 1 && a.width > 0 };
          });
          assert.equal(log.fits, true); assert.equal(log.amount, true);
          await closeLog();
          await openSearch('Food this month');
          const search = await page.evaluate(() => {
            const r = document.querySelector('.fs-results').getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
          });
          assert.equal(search, true);
          await closeLog();
          await page.evaluate(() => CapFinancialHealth.open());
          await page.locator('#cap-financial-health').waitFor({ state: 'visible' }); await finish();
          const health = await page.evaluate(() => {
            const panel = document.querySelector('#cap-financial-health').getBoundingClientRect();
            const body = document.querySelector('.fh-body');
            return { fits: panel.left >= 0 && panel.right <= innerWidth + 1, body: body.scrollWidth <= body.clientWidth + 1 };
          });
          assert.equal(health.fits, true); assert.equal(health.body, true);
          await page.getByRole('button', { name: 'Close Financial Health', exact: true }).click();
        });
      }
    }
  }

  await test('Reduced motion and keyboard focus keep Smart Log, Appearance and Health readable', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await setEnv(390, 'light');
    await openLog('Spent 450 at Jollibee using BDO today');
    const log = await page.evaluate(() => {
      const p = getComputedStyle(document.querySelector('.sl-preview')), a = document.querySelector('.sl-amount');
      return { animation: p.animationName, opacity: getComputedStyle(a).opacity, text: a.textContent };
    });
    assert.ok(log.text.includes('450')); assert.equal(log.opacity, '1');
    await closeLog();
    await page.evaluate(() => stGo('appearance'));
    await page.locator('.appearance-themes').waitFor({ state: 'visible' });
    await page.locator('.theme-choice').first().focus();
    const focus = await page.locator('.theme-choice').first().evaluate(e => ({
      outline: getComputedStyle(e).outlineStyle, transition: getComputedStyle(e).transitionDuration,
      preview: getComputedStyle(e.querySelector('.theme-preview')).transitionDuration
    }));
    assert.equal(focus.outline, 'solid');
    assert.ok(parseFloat(focus.transition) <= .001 && parseFloat(focus.preview) <= .001);
    await page.evaluate(() => closeS());
    await page.waitForTimeout(350);
    await page.evaluate(() => CapFinancialHealth.open());
    await page.locator('#cap-financial-health').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#cap-financial-health').evaluate(e => getComputedStyle(e).animationName), 'none');
    await page.getByRole('button', { name: 'Close Financial Health', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  await test('all presentation checks preserve synthetic financial state with no external IO', async () => {
    const state = await page.evaluate(() => ({ actual: JSON.parse(JSON.stringify(S)), expected: JSON.parse(__pass2Financial) }));
    state.actual._mt = state.expected._mt;
    assert.deepEqual(state.actual, state.expected);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });

  fs.mkdirSync(shots, { recursive: true });
  await setEnv(390, 'light');
  await page.locator('.spend-card').screenshot({ path: path.join(shots, 'spending-controls-390-light.png') });
  await setEnv(1024, 'dark');
  await page.screenshot({ path: path.join(shots, 'home-1024-dark.png') });
  await page.evaluate(() => stGo('appearance'));
  await page.locator('.appearance-themes').waitFor({ state: 'visible' }); await finish();
  await page.locator('.appearance-themes').screenshot({ path: path.join(shots, 'appearance-1024-dark.png') });
  console.log(`PASS: ${passed} second-pass polish browser checks; screenshots: ${shots}`);
  await context.close();
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
