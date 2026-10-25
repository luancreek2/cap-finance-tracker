/* Isolated typography/layout verification. Only DOM display strings change;
   no stored amounts, theme preferences, sync settings or financial IO change. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP: hero typography needs CAP_PLAYWRIGHT_PATH');process.exit(0);}
const pw=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..');
const shots=path.join(process.env.LOCALAPPDATA||process.env.TEMP,'Temp','opencode','hero-balance-review');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.mp3':'audio/mpeg'};
const samples=['₱0.00','₱1.00','₱999.99','₱14,181.20','₱18,969.00','₱999,999.99','₱1,234,567.89'];
const sizes=[[320,740],[390,844],[768,1024],[1024,768],[1440,900]];
let server,browser,passed=0,requests=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
  fs.mkdirSync(shots,{recursive:true});
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://fixture.invalid');
    if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){
      res.writeHead(200,{'Content-Type':'text/javascript'});return res.end('window.CAP_SUPABASE_CONFIG={};');
    }
    if(u.pathname.startsWith('/rest/')||u.pathname.startsWith('/auth/')){requests++;res.writeHead(403);return res.end();}
    const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
    fs.readFile(file,(e,b)=>{res.writeHead(e?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(e?'Missing':b);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const engines=[['Chrome',pw.chromium,{channel:'chrome'}]];
  if(fs.existsSync(pw.webkit.executablePath()))engines.push(['WebKit',pw.webkit,{}]);
  else console.log('SKIP: WebKit binary is not installed; no Safari/iPadOS rendering claim.');
  for(const [name,engine,opts] of engines){
    browser=await engine.launch({...opts,headless:true});
    const context=await browser.newContext({reducedMotion:'reduce',viewport:{width:768,height:1024}});
    await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
    const page=await context.newPage();await page.goto(origin);
    await page.waitForFunction(()=>document.querySelector('#chv.ch-balance')&&window.CapProductionSync&&!window.capLaunchActive);
    await page.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove();});
    await page.waitForTimeout(900);
    const before=await page.evaluate(async()=>JSON.stringify({S,snapshot:await CapOff.productionSyncSnapshot(),pera:localStorage.getItem('pera'),theme:localStorage.getItem('cap-appearance-theme'),hold:localStorage.getItem(CapProductionSync.recoveryKey)}));
    await test(name+': original Cap font and numeral behavior are restored',async()=>{
      const a=await page.evaluate(()=>{
        const s=getComputedStyle(document.body),h=getComputedStyle(document.querySelector('#chv.ch-balance'));
        return {body:s.fontFamily,hero:h.fontFamily,numeric:h.fontVariantNumeric,features:h.fontFeatureSettings};
      });
      assert.match(a.body,/-apple-system, "Segoe UI", Inter, Roboto, sans-serif/);
      assert.equal(a.body,a.hero);
      assert.equal(a.numeric,'normal');assert.equal(a.features,'normal');
      assert.equal(await page.evaluate(()=>CSS.supports('font-variant-numeric','proportional-nums')),true);
    });
    for(const colorScheme of ['light','dark'])for(const [width,height] of sizes){
      await page.setViewportSize({width,height});await page.emulateMedia({colorScheme});
      for(const theme of ['light','dark','auto','apple'])await test(`${name} ${width}x${height} OS ${colorScheme} / ${theme}: seven balances fit without clipping or eye collision`,async()=>{
        const results=await page.evaluate(({theme,samples})=>{
          if(theme==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.dataset.theme=theme;
          const e=document.querySelector('#chv.ch-balance'),row=e.parentElement,eye=row.querySelector('.bve');
          return samples.map(text=>{
            e.textContent=text;
            const style=getComputedStyle(e),r=e.getBoundingClientRect(),p=row.getBoundingClientRect(),a=eye.getBoundingClientRect();
            const range=document.createRange();range.selectNodeContents(e);const ink=range.getBoundingClientRect();
            return {text,numeric:style.fontVariantNumeric,features:style.fontFeatureSettings,spacing:style.letterSpacing,
              weight:style.fontWeight,stretch:style.fontStretch,font:style.fontFamily,size:style.fontSize,whiteSpace:style.whiteSpace,
              rect:r.toJSON(),parent:p.toJSON(),eye:a.toJSON(),ink:ink.toJSON(),lines:range.getClientRects().length,vw:innerWidth};
          });
        },{theme,samples});
        for(const r of results){
          const label=theme+' '+r.text;
          assert.equal(r.numeric,'normal',label);assert.equal(r.features,'normal',label);
          assert.equal(r.stretch,'100%',label);assert.equal(r.size,'44px',label);
          assert.equal(r.weight,'700',label);
          assert.ok(Math.abs(parseFloat(r.spacing)+.88)<.01,label+' original tracking changed');
          assert.match(r.font,/-apple-system, "Segoe UI", Inter, Roboto, sans-serif/);
          assert.equal(r.whiteSpace,'nowrap',label);assert.equal(r.lines,1,label);
          assert.ok(r.ink.right<=r.rect.right+1&&r.ink.left>=r.rect.left-1,label+' clipped amount');
          assert.ok(r.rect.right<=r.parent.right+1&&r.rect.left>=r.parent.left-1,label+' amount overflow');
          assert.ok(r.eye.right<=r.parent.right+1&&r.eye.left>=r.parent.left-1&&r.eye.right<=r.vw,label+' eye overflow');
          assert.ok(r.eye.left>=r.rect.right-1||r.eye.top>=r.rect.bottom-1,label+' eye overlaps amount');
          assert.ok(r.eye.width>=44&&r.eye.height>=44,label+' reduced touch target');
        }
        if(theme==='apple')await page.locator('.ch-balance-row').screenshot({path:path.join(shots,`${name}-${width}-${colorScheme}.png`)});
      });
    }
    await test(name+': financial numerals keep their original per-selector behavior',async()=>{
      for(const theme of ['light','dark','auto','apple']){
        const variants=await page.evaluate(theme=>{
          if(theme==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.dataset.theme=theme;
          const p=document.createElement('div');p.innerHTML='<b class="big">₱14,181.20</b><b class="amt">₱14,181.20</b><b class="amount">₱14,181.20</b><div class="cp-summary-row"><b>₱14,181.20</b></div><span id="not-the-hero" class="big ch-balance">₱14,181.20</span>';
          document.body.append(p);const result=[...p.querySelectorAll('b,span')].map(e=>getComputedStyle(e).fontVariantNumeric);p.remove();return result;
        },theme);
        /* .big/.amt/.amount were never tabular before the Apple font change;
           summary rows still opt in explicitly and must keep doing so. */
        assert.deepEqual(variants.slice(0,4),['normal','normal','normal','tabular-nums'],theme+' numeral behavior changed');
      }
    });
    await test(name+': privacy masking keeps the same amount/control geometry',async()=>{
      const same=await page.evaluate(()=>{
        const e=document.querySelector('#chv.ch-balance'),eye=e.parentElement.querySelector('.bve');
        const rect=()=>[e.getBoundingClientRect().toJSON(),eye.getBoundingClientRect().toJSON()];
        const before=JSON.stringify(rect());document.documentElement.classList.add('bvhide');
        const equal=JSON.stringify(rect())===before;document.documentElement.classList.remove('bvhide');return equal;
      });assert.equal(same,true);
    });
    await test(name+': no data, sync, recovery or theme preference mutations',async()=>{
      const after=await page.evaluate(async()=>JSON.stringify({S,snapshot:await CapOff.productionSyncSnapshot(),pera:localStorage.getItem('pera'),theme:localStorage.getItem('cap-appearance-theme'),hold:localStorage.getItem(CapProductionSync.recoveryKey)}));
      assert.equal(after,before);assert.equal(requests,0);assert.equal(await page.evaluate(()=>CapProductionSync.status().enabled),false);
    });
    await context.close();await browser.close();browser=null;
  }
  console.log('Screenshots: '+shots);console.log(`PASS: ${passed} focused hero numeral/layout browser checks`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
