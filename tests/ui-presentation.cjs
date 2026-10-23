/* Device-local UI regression checks. No network, credentials or financial data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=p=>fs.readFileSync(`${__dirname}/../${p}`,'utf8');
const app=read('js/app.js'),cards=read('js/cards.js'),css=read('css/styles.css'),anim=read('css/animations.css');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name)}
const stored=new Map();let denied=false,notices=0;
const localStorage={getItem:k=>{if(denied)throw Error('Storage unavailable');return stored.get(k)||null},setItem:(k,v)=>{if(denied)throw Error('Storage unavailable');stored.set(k,v)}};
const ctx=vm.createContext({localStorage,toast:()=>notices++});
const preference=app.slice(app.indexOf('function developerOptionsEnabled()'),app.indexOf('function developerSyncSettingsHtml()'));
vm.runInContext(preference,ctx);
test('Developer Options defaults OFF even with legacy developer capability present',()=>{
  ctx.CAP_DEV_TOOLS=true;assert.equal(ctx.developerOptionsEnabled(),false);
});
test('Developer Options ON persists in a separate device key',()=>{
  ctx.setDeveloperOptions({checked:true});assert.equal(stored.get('cap_developer_options'),'1');
  assert.equal(ctx.developerOptionsEnabled(),true);assert.equal(stored.size,1);
});
test('Developer Options survives a fresh execution context',()=>{
  const reload=vm.createContext({localStorage,toast:()=>{}});vm.runInContext(preference,reload);
  assert.equal(reload.developerOptionsEnabled(),true);
});
test('Developer Options OFF persists without changing backend capability flags',()=>{
  ctx.setDeveloperOptions({checked:false});assert.equal(ctx.developerOptionsEnabled(),false);assert.equal(ctx.CAP_DEV_TOOLS,true);
});
test('storage failure is fail-closed and restores the checkbox',()=>{
  denied=true;const input={checked:true};ctx.setDeveloperOptions(input);
  assert.equal(input.checked,false);assert.equal(notices,1);denied=false;
});
test('preference handlers do not touch financial state, sync gates or auth',()=>{
  assert.doesNotMatch(preference,/\bS\b|\bsave\(|CAP_DEV_TOOLS|CapSupabase|CapSync|fetch\(|setEnabled/);
  assert.match(app,/stSw\('Developer Options'/);
});
test('existing Cloud Sync diagnostics are reused, not duplicated',()=>{
  const display=app.slice(app.indexOf('function developerSyncSettingsHtml()'),app.indexOf('function stSel('));
  assert.match(display,/CapSync\.settingsHtml\(\)/);assert.match(display,/el\.remove\(\)/);
  assert.doesNotMatch(display,/\.disabled|setEnabled|syncStore|CAP_DEV_TOOLS/);
});
test('flying card is mounted before the source and destination are hidden',()=>{
  const open=cards.slice(cards.indexOf('window.acctMenu=function(id){'),cards.indexOf('function plain()'));
  assert.ok(open.indexOf('const f=flyer(card,to)')<open.indexOf("card.style.visibility='hidden'"));
  assert.ok(open.indexOf('if(busy)return;')<open.indexOf('origOpen.apply'));
  assert.ok(open.indexOf("card.style.visibility=''")<open.indexOf('f.root.remove()'));
});
test('card motion uses transform-only geometry and all motion preferences',()=>{
  assert.match(cards,/f\.root\.animate\(opening\?ends/);assert.doesNotMatch(cards,/animate\(opening\?\[px\(small\)/);
  assert.match(cards,/matches\('\.noanim,\.rm'\)/);assert.match(cards,/prefers-reduced-motion/);
  assert.match(cards,/clearHide\(\);card\.style\.visibility='';f\.root\.remove/);
});
test('shared layer hierarchy places flying cards and menus above modals, confirmations above menus',()=>{
  const layer=name=>Number(css.match(new RegExp('--layer-'+name+':(\\d+)'))[1]);
  const names=['navigation','backdrop','modal','card-transition','popover','confirmation','notice','lock'];
  names.slice(1).forEach((n,i)=>assert.ok(layer(n)>layer(names[i])));
  assert.match(css,/\.cardfx-fly\{[^}]*z-index:var\(--layer-card-transition\)/);
  assert.match(anim,/#cap-overlays\{[^}]*z-index:var\(--layer-popover\)/);
  assert.match(anim,/#cfm\{z-index:var\(--layer-confirmation\)/);
});
test('portal follows the visual viewport and uses body host, not a clipped sheet',()=>{
  const overlay=app.slice(app.indexOf('window.CapOverlays='),app.indexOf('/* ===== Floating sheet'));
  assert.match(overlay,/document\.body\.appendChild\(host\)/);assert.match(overlay,/visualViewport/);
  assert.match(overlay,/getBoundingClientRect\(\)/);assert.match(overlay,/requestAnimationFrame\(position\)/);
  assert.match(overlay,/cancelAnimationFrame\(raf\)/);assert.match(overlay,/!anchor\.isConnected/);
  assert.match(app,/detach=CapOverlays\.attach\(p,b/);assert.match(cards,/CapOverlays\.attach\(m,button\)/);
});
test('release shell version bumped and changed UI files are in offline CORE',()=>{
  const worker=read('service-worker.js');assert.match(worker,/cap-shell-v326/);
  for(const file of ['js/app.js','js/cards.js','js/animations.js','css/styles.css','css/animations.css'])assert.ok(worker.includes('./'+file),file);
});
console.log(`PASS: ${passed} UI presentation regression checks; local preferences, hand-off guards and layer contract`);
