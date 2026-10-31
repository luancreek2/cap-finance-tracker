/* Phase 2C adapter tests. Real Phase 2B math/identity reducer, synthetic IO only. */
'use strict';
const assert=require('node:assert/strict'),S=require('../js/notification-schedule.js'),E=require('../js/notification-reminders.js');
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(zone='Asia/Manila'){
  let mapping=null,policy=null;const data=new Map();
  const adapter={...S,loadIdentities:async()=>copy(mapping),mutateIdentities:async(owner,command)=>{const result=S.updateMapping(mapping,owner,command);mapping=result.mapping;return result;},loadPolicy:async()=>copy(policy),ensurePolicy:async preferences=>{policy=policy||S.migratePolicy(preferences);return {policy:copy(policy)};},savePolicy:async value=>{policy=copy(value);return copy(policy);}};
  const options={schedule:adapter,read:async k=>data.has(k)?copy(data.get(k)):null,write:async(k,v)=>{data.set(k,copy(v));},lock:async(owner,fn)=>fn(),now:()=>Date.parse('2026-10-01T00:00:00Z'),zone:()=>zone};
  return {editor:E.create(options),options,adapter,data,mapping:()=>mapping};
}
const descriptor={source:'subscription',id:'spotify',category:'renew',due_date:'2026-11-04',title:'Spotify'};
(async()=>{
  const f=fixture(),owner='local';let item,relative,custom;
  await test('setup uses durable Phase 2B identities and preserves migrated category leads',async()=>{
    item=await f.editor.review(owner,descriptor,'source',{renewD:3});assert.equal(item.reminders.length,1);assert.equal(item.reminders[0].days_before,3);relative=item.reminders[0];
    assert.equal((await f.editor.items(owner,[descriptor]))[0].review_required,false);
  });
  await test('relative lead, inherited/override time edits retain reminder identity',async()=>{
    const result=await f.editor.saveReminder(owner,item.obligation_id,descriptor,{kind:'relative',days_before:7,time_source:'override',override_local_time:'19:30'},relative.reminder_id);
    assert.equal(result.reminder.reminder_id,relative.reminder_id);assert.equal(result.reminder.days_before,7);
  });
  await test('multiple relative and absolute reminders are actual mapping records',async()=>{
    await f.editor.saveReminder(owner,item.obligation_id,descriptor,{kind:'relative',days_before:14,time_source:'inherit'});
    custom=(await f.editor.saveReminder(owner,item.obligation_id,descriptor,{kind:'absolute',local_date:'2026-11-02',local_time:'19:30'})).reminder;
    const rows=await f.editor.items(owner,[descriptor]);assert.equal(rows[0].reminders.length,3);assert.equal(rows[0].plan.entries.length,3);assert.equal(f.mapping().occurrences[0].reminders.length,3);
    for(const entry of rows[0].plan.entries){const {local_ref,...remote}=entry;assert.match(JSON.stringify(local_ref),/spotify/);assert.doesNotMatch(JSON.stringify(remote),/Spotify|amount|"title"|due_date|source_id|"source"|"id"/);}
  });
  await test('custom date/time edits retain identity and use the approved wall resolver',async()=>{
    const result=await f.editor.saveReminder(owner,item.obligation_id,descriptor,{kind:'absolute',local_date:'2026-11-03',local_time:'20:00'},custom.reminder_id);
    assert.equal(result.reminder.reminder_id,custom.reminder_id);assert.equal(result.reminder.send_after,'2026-11-03T12:00:00Z');custom=result.reminder;
  });
  await test('default time changes inherited reminders only, never fixed absolute UTC',async()=>{
    let rows=await f.editor.items(owner,[descriptor]);const inherited=rows[0].reminders.find(r=>r.time_source==='inherit'),before=rows[0].plan.entries.find(e=>e.reminder_id===inherited.reminder_id).send_after;
    await f.editor.defaultTime(owner,'19:30');
    rows=await f.editor.items(owner,[descriptor]);assert.notEqual(rows[0].plan.entries.find(e=>e.reminder_id===inherited.reminder_id).send_after,before);assert.equal(rows[0].plan.entries.find(e=>e.reminder_id===custom.reminder_id).send_after,custom.send_after);
  });
  await test('delete/recreate tombstones the old reminder and allocates a new one',async()=>{
    await f.editor.remove(owner,item.obligation_id,descriptor,relative.reminder_id);
    const recreated=await f.editor.saveReminder(owner,item.obligation_id,descriptor,{kind:'relative',days_before:7,time_source:'override',override_local_time:'19:30'});
    assert.notEqual(recreated.reminder.reminder_id,relative.reminder_id);assert.equal(f.mapping().occurrences[0].reminders.find(r=>r.reminder_id===relative.reminder_id).state,'deleted');
  });
  await test('reload retains records but requires explicit review, never infers continuity',async()=>{
    const reloaded=E.create(f.options),rows=await reloaded.items(owner,[descriptor]);assert.equal(rows[0].review_required,true);assert.equal(rows[0].obligation_id,item.obligation_id);
    await assert.rejects(reloaded.saveReminder(owner,item.obligation_id,descriptor,{kind:'relative',days_before:0,time_source:'inherit'}),/REVIEW_REQUIRED/);
  });
  await test('explicit same occurrence confirms a financial date correction without moving absolute UTC',async()=>{
    const corrected={...descriptor,due_date:'2026-11-05'};
    assert.equal((await f.editor.items(owner,[corrected]))[0].review_required,true);
    const confirmed=await f.editor.review(owner,corrected,'same');assert.equal(confirmed.obligation_id,item.obligation_id);
    assert.equal((await f.editor.items(owner,[corrected]))[0].plan.entries.find(e=>e.reminder_id===custom.reminder_id).send_after,custom.send_after);
  });
  await test('next occurrence and recreated source never revive the old identities',async()=>{
    const next=await f.editor.review(owner,{...descriptor,due_date:'2026-12-05'},'cycle');assert.notEqual(next.obligation_id,item.obligation_id);assert.equal(f.mapping().occurrences[0].state,'closed');
    const recreated=await f.editor.review(owner,descriptor,'source');assert.notEqual(recreated.source_handle,next.source_handle);assert.notEqual(recreated.obligation_id,next.obligation_id);
  });
  await test('custom wins an exact relative collision; duplicate custom is rejected',async()=>{
    const x=fixture();const i=await x.editor.review(owner,descriptor,'source',{renewD:3});
    const result=await x.editor.saveReminder(owner,i.obligation_id,descriptor,{kind:'absolute',local_date:'2026-11-01',local_time:'09:00'});assert.equal(result.custom_won,true);
    assert.equal(x.mapping().occurrences[0].reminders.find(r=>r.reminder_id===i.reminders[0].reminder_id).state,'deleted');
    await assert.rejects(x.editor.saveReminder(owner,i.obligation_id,descriptor,{kind:'absolute',local_date:'2026-11-01',local_time:'09:00'}),/REMINDER_DUPLICATE/);
  });
  await test('past, malformed and unsupported values are rejected before identity allocation',async()=>{
    const x=fixture();const i=await x.editor.review(owner,descriptor,'source');const count=x.mapping().occurrences[0].reminders.length;
    for(const raw of [{kind:'absolute',local_date:'2026-09-01',local_time:'09:00'},{kind:'absolute',local_date:'bad',local_time:'09:00'},{kind:'relative',days_before:4,time_source:'inherit'},{kind:'relative',days_before:3,time_source:'override',override_local_time:'24:01'}])await assert.rejects(x.editor.saveReminder(owner,i.obligation_id,descriptor,raw));
    assert.equal(x.mapping().occurrences[0].reminders.length,count);
  });
  await test('DST gaps reject and folds choose later with the real Phase 2B resolver',async()=>{
    const x=fixture('America/New_York');x.options.now=()=>Date.parse('2024-01-01T00:00:00Z');const e=E.create(x.options);const d={...descriptor,due_date:'2024-11-15'},i=await e.review(owner,d,'source');
    await assert.rejects(e.saveReminder(owner,i.obligation_id,d,{kind:'absolute',local_date:'2024-03-10',local_time:'02:30'}),/NOTIFICATION_LOCAL_TIME_GAP/);
    const result=await e.saveReminder(owner,i.obligation_id,d,{kind:'absolute',local_date:'2024-11-03',local_time:'01:30'});assert.equal(result.reminder.send_after,'2024-11-03T06:30:00Z');
  });
  await test('default stage edits change inherited configuration, not individually edited rules',async()=>{
    const x=fixture(),i=await x.editor.review(owner,descriptor,'source',{renewD:3});await x.editor.defaults(owner,'renew',[14,7,0]);
    let rows=await x.editor.items(owner,[descriptor]);assert.deepEqual(rows[0].reminders.map(r=>r.days_before),[14,7,0]);
    await x.editor.saveReminder(owner,i.obligation_id,descriptor,{kind:'relative',days_before:5,time_source:'inherit'},rows[0].reminders[0].reminder_id);
    await x.editor.defaults(owner,'renew',[3]);rows=await x.editor.items(owner,[descriptor]);assert.equal(rows[0].reminders[0].days_before,5);
  });
  await test('copy is deterministic for all urgency tiers and never invents a payment claim',()=>{
    for(const [days,phrase] of [[14,'in 2 weeks'],[7,'next week'],[5,'in 5 days'],[3,'in 3 days'],[2,'in 2 days'],[1,'tomorrow'],[0,'today'],[-1,'may be overdue']])assert.ok(E.copy('renew','Spotify',days).title.includes(phrase));
    assert.match(E.copy('bills','Meralco',-1,true).title,/is overdue/);assert.equal(E.leadLabel(0,'trial'),'Trial ends');assert.ok(E.friendlyTime('09:00','en-US').includes('9:00'));
  });
  await test('malformed local state fails closed',async()=>{const x=fixture();x.data.set('scheduling.editor:local',{version:1,items:[null]});await assert.rejects(x.editor.load(owner),/EDITOR_STATE_INVALID/);});
  await test('in-app urgency tiers are deterministic and do not mutate source data',()=>{
    const source=JSON.stringify(descriptor);
    for(const [days,tier]of [[-7,'overdue'],[0,'today'],[1,'tomorrow'],[2,'soon'],[3,'soon'],[5,'week'],[7,'week'],[14,'early'],[30,'neutral'],[NaN,'neutral']])assert.equal(E.urgency(days),tier);
    assert.equal(JSON.stringify(descriptor),source);
  });
  await test('failed editor writes leave identities fenced; explicit recreation closes orphan mappings',async()=>{
    const x=fixture();let fail=true;
    const e=E.create({...x.options,write:async(k,v)=>{if(fail){fail=false;throw Error('storage full');}return x.options.write(k,v);}});
    await assert.rejects(e.review(owner,descriptor,'source'),/storage full/);const abandoned=x.mapping().sources[0].source_handle;
    const fresh=await e.review(owner,descriptor,'source');assert.notEqual(fresh.source_handle,abandoned);assert.equal(x.mapping().sources.find(s=>s.source_handle===abandoned).state,'closed');
  });
  console.log(`PASS: ${passed} Phase 2C local adapter checks`);
})().catch(e=>{console.error(e);process.exitCode=1;});
