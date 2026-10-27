/* Deterministic calendar momentum regression tests. Fake clock/RAF/scroller;
   execute the shipped functions without browser timing, DOM or financial IO. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../js/activity-scope.js','utf8');
const constants=source.slice(source.indexOf('  const COAST_VIEWPORTS'),source.indexOf('  function monthSection'));
const coast=source.slice(source.indexOf('  function startCoast('),source.indexOf('  const yearDown='));
function fixture(height=400){
  const f={clock:100,next:1,frames:new Map(),settled:0,scrolled:0,reduced:false,cancelled:[]};
  f.c=vm.createContext({performance:{now:()=>f.clock},RMA:()=>f.reduced,
    requestAnimationFrame:fn=>{const id=f.next++;f.frames.set(id,fn);return id},
    cancelAnimationFrame:id=>{f.cancelled.push(id);f.frames.delete(id)},
    settleTimeline:()=>f.settled++,timelineScrolled:()=>f.scrolled++,suppressCalendarClickUntil:0,pointer:null});
  vm.runInContext(constants+coast,f.c);
  let top=1000;
  f.t={w:{isConnected:true},view:{clientHeight:height,get scrollTop(){return top},set scrollTop(n){top=Math.round(n)}},raf:0,coastGen:0,coasting:false};
  f.frame=(time,id=f.frames.keys().next().value)=>{assert.ok(f.frames.has(id),'one pending frame expected');const fn=f.frames.get(id);f.frames.delete(id);f.clock=Math.max(f.clock,time);fn(time)};
  f.finish=()=>{for(let i=0;f.frames.size&&i<100;i++)f.frame(f.clock+16);assert.equal(f.frames.size,0,'momentum must terminate')};
  return f;
}
let passed=0;
function test(name,fn){fn();console.log('PASS '+name);passed++}
test('first RAF timestamp before/equal to release time waits for a real elapsed step',()=>{
  for(const time of [96,100]){
    const f=fixture();f.c.startCoast(f.t,1);f.frame(time);
    assert.equal(f.t.coasting,true,'a zero-dt frame must not terminate the flick');
    assert.equal(f.frames.size,1);assert.equal(f.t.view.scrollTop,1000);
    f.frame(116);assert.ok(f.t.view.scrollTop>1000);f.finish();
  }
});
test('a positive subpixel first frame is not mistaken for a scroll boundary',()=>{
  for(const direction of [-1,1]){
    const f=fixture();f.c.startCoast(f.t,direction*.6686626746308106);
    f.frame(100.7); // Observed browser failure: 0.7ms * 0.6687px/ms rounds to zero CSS px.
    assert.equal(f.t.view.scrollTop,1000);
    assert.equal(f.t.coasting,true,'rounding inside the scroll range must not cancel momentum');
    assert.equal(f.frames.size,1,'one live frame must remain after a subpixel step');
    f.frame(116.7);assert.ok((f.t.view.scrollTop-1000)*direction>5);f.finish();
  }
});
test('successive subpixel frames accumulate symmetrically without reversing direction',()=>{
  for(const direction of [-1,1]){
    const f=fixture();f.c.startCoast(f.t,direction*.1);
    for(let i=1;i<=20;i++){
      const before=f.t.view.scrollTop;f.frame(100+i);
      assert.ok((f.t.view.scrollTop-before)*direction>=0,'fractional carry must not reverse motion');
    }
    const travel=(f.t.view.scrollTop-1000)*direction;
    assert.ok(travel>=1&&travel<=3,'subpixel displacement must accumulate instead of disappearing');
    f.finish();
  }
});
test('a queued stale RAF cannot cancel or advance a newer gesture momentum loop',()=>{
  const f=fixture();f.c.startCoast(f.t,1);const stale=f.frames.values().next().value;
  f.c.startCoast(f.t,-1);const id=f.t.raf,gen=f.t.coastGen;stale(116);
  assert.equal(f.t.coastGen,gen);assert.equal(f.t.raf,id);assert.equal(f.frames.size,1);
  assert.equal(f.t.coasting,true);assert.equal(f.t.view.scrollTop,1000);
  f.frame(132);assert.ok(f.t.view.scrollTop<1000);f.finish();
});
test('both directions honor the same absolute viewport travel budget',()=>{
  for(const direction of [-1,1]){
    const f=fixture(100);f.c.startCoast(f.t,direction*2);f.finish();
    const travel=(f.t.view.scrollTop-1000)*direction;
    assert.ok(travel>0&&travel<=86,'budget exceeded: '+travel);
    assert.equal(f.t.coasting,false);assert.equal(f.t.raf,0);
  }
});
test('velocity decays, never reverses, and finishes with no surviving RAF',()=>{
  const f=fixture(1000),steps=[];f.c.startCoast(f.t,1.5);
  for(let i=0;i<8;i++){const before=f.t.view.scrollTop;f.frame(f.clock+16);steps.push(f.t.view.scrollTop-before)}
  assert.ok(steps.every(n=>n>0));assert.ok(steps[0]>steps.at(-1));
  f.finish();const stopped=f.t.view.scrollTop;assert.equal(f.t.coasting,false);assert.equal(f.t.raf,0);
  assert.equal(f.t.view.scrollTop,stopped);assert.ok(f.settled>0);
});
test('new gesture stop invalidates all earlier frames and resets ownership',()=>{
  const f=fixture();f.c.startCoast(f.t,2);const stale=f.frames.values().next().value;
  f.c.stopCoast(f.t);const gen=f.t.coastGen;stale(132);
  assert.equal(f.t.coastGen,gen);assert.equal(f.frames.size,0);assert.equal(f.t.coasting,false);assert.equal(f.t.view.scrollTop,1000);
});
test('release uses only the current gesture samples and discards held/stale velocity',()=>{
  const f=fixture();
  const pointer=(samples)=>({id:1,t:f.t,moved:true,samples});
  f.c.pointer=pointer([{y:900,time:50},{y:1000,time:100}]);f.c.endCalendarPointer({pointerId:1},false);
  assert.equal(f.c.pointer,null);assert.equal(f.frames.size,1);f.finish();
  f.clock+=200;f.c.pointer=pointer([{y:0,time:0},{y:500,time:50}]);f.c.endCalendarPointer({pointerId:1},false);
  assert.equal(f.frames.size,0,'a held release must not reuse the previous flick');
  f.c.pointer=pointer([{y:1000,time:f.clock-20},{y:990,time:f.clock}]);f.c.endCalendarPointer({pointerId:1},false);
  const before=f.t.view.scrollTop;f.frame(f.clock+16);assert.ok(f.t.view.scrollTop<before);f.finish();
});
test('cancelled gestures, reduced motion, blocked edges and detached scrollers terminate safely',()=>{
  for(const cancelled of [true,false]){
    const f=fixture();f.reduced=!cancelled;f.c.pointer={id:1,t:f.t,moved:true,samples:[{y:0,time:80},{y:40,time:100}]};
    f.c.endCalendarPointer({pointerId:1},cancelled);assert.equal(f.frames.size,0);
  }
  for(const kind of ['edge','detached','reduced']){
    const f=fixture();f.c.startCoast(f.t,1);
    if(kind==='edge')Object.defineProperty(f.t.view,'scrollTop',{get:()=>0,set:()=>{}});
    if(kind==='detached')f.t.w.isConnected=false;if(kind==='reduced')f.reduced=true;
    f.frame(116);assert.equal(f.frames.size,0);assert.equal(f.t.coasting,false);
  }
});
console.log(`PASS: ${passed} deterministic calendar inertia checks`);
