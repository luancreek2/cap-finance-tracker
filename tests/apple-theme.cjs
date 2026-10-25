/* Appearance-only contracts. Execute the actual preference functions with all
   financial writes/render-save paths forbidden. No live browser or cloud IO. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync(__dirname+'/../js/app.js','utf8'),css=fs.readFileSync(__dirname+'/../css/styles.css','utf8');
const storage=new Map(),attrs=new Map(),S={theme:'dark',accts:[{id:1,bal:100}],tx:[]};
let pages=0,passed=0;
const deny=()=>{throw Error('Appearance touched a financial/save/sync path');};
const c={S,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
  document:{documentElement:{setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)}},
  render:deny,save:deny,CapProductionSync:{request:deny},stGo:k=>{assert.equal(k,'appearance');pages++;},toast:()=>{}};
vm.createContext(c);
vm.runInContext(app.slice(app.indexOf('      function appearanceTheme()'),app.indexOf('      function openSettings()')),c);
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('legacy saved theme is read without migrating state',()=>{assert.equal(c.appearanceTheme(),'dark');assert.equal(storage.size,0);});
const before=JSON.stringify(S);
test('select Apple persists only a local presentation key',()=>{c.setTheme('apple');assert.equal(storage.get('cap-appearance-theme'),'apple');assert.equal(attrs.get('data-theme'),'apple');assert.equal(JSON.stringify(S),before);assert.equal(pages,1);});
test('Apple preference survives preference-function reload',()=>{vm.runInContext(app.slice(app.indexOf('      function appearanceTheme()'),app.indexOf('      function openSettings()')),c);c.applyTheme();assert.equal(attrs.get('data-theme'),'apple');});
test('light dark auto and Apple remain selectable',()=>{for(const t of ['light','dark','auto','apple']){c.setTheme(t);assert.equal(c.appearanceTheme(),t);}assert.equal(JSON.stringify(S),before);});
test('invalid presentation preference cannot become a theme',()=>{c.setTheme('invalid');assert.equal(c.appearanceTheme(),'apple');storage.set('cap-appearance-theme','invalid');assert.equal(c.appearanceTheme(),'dark');});
test('storage read failure falls back to existing preference',()=>{const get=c.localStorage.getItem;c.localStorage.getItem=()=>{throw Error('Unavailable');};assert.equal(c.appearanceTheme(),'dark');c.localStorage.getItem=get;});
test('storage write failure does not mutate financial state',()=>{const set=c.localStorage.setItem;c.localStorage.setItem=()=>{throw Error('Unavailable');};c.setTheme('apple');assert.equal(JSON.stringify(S),before);c.localStorage.setItem=set;});
test('all Apple palette and semantic tokens are declared',()=>{for(const token of ['apple-light-gray','apple-mid-gray','apple-dark-gray-2','apple-dark-gray','apple-blue','apple-green','apple-orange','apple-red','apple-yellow','color-primary','color-success','color-danger','color-warning','color-caution','color-text-primary','color-text-secondary','color-surface','color-surface-secondary','color-divider','color-glass','color-glass-border'])assert.ok(css.includes('--'+token+':')||css.includes('--'+token+': '),token);});
test('native font stack without downloaded font files',()=>{assert.match(css,/-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Arial, sans-serif/);assert.doesNotMatch(css,/@font-face|url\([^)]*\.(woff2?|ttf|otf)/i);assert.match(css,/font-variant-numeric:tabular-nums/);});
test('glass enhancement has an opaque fallback, safe area and reduced motion',()=>{assert.match(css,/@supports \(\(backdrop-filter/);assert.match(css,/background:var\(--nav-fallback\)/);assert.match(css,/112px \+ env\(safe-area-inset-bottom/);assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);});
console.log(`PASS: ${passed} Apple appearance contract checks`);
