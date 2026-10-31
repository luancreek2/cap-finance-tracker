/* Phase 2C local editor adapter. No financial writes, network or publisher calls.
   Identity is owned exclusively by Phase 2B; every association needs explicit
   review in this session. Persisted source IDs/dates are never continuity proof. */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./notification-schedule.js'):root.CapNotificationSchedule);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.CapReminderEditor=api;
})(typeof window==='undefined'?globalThis:window,function(foundation){
  'use strict';
  const schedule=foundation;
  const error=code=>Object.assign(Error(code),{code});
  const clone=value=>JSON.parse(JSON.stringify(value));
  const key=owner=>'scheduling.editor:'+owner;
  function storage(mode,key,value){
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open(schedule.DB_NAME,schedule.DB_VERSION);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(schedule.STORE))request.result.createObjectStore(schedule.STORE);};
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result,tx=db.transaction(schedule.STORE,mode==='get'?'readonly':'readwrite'),store=tx.objectStore(schedule.STORE);
        const r=mode==='get'?store.get(key):store.put(value,key);let result;
        r.onsuccess=()=>{result=r.result;};
        tx.oncomplete=()=>{db.close();resolve(result??null);};
        tx.onerror=tx.onabort=()=>{db.close();reject(tx.error||error('STORAGE_UNAVAILABLE'));};
      };
      request.onblocked=()=>reject(error('STORAGE_UNAVAILABLE'));
    });
  }
  const leadLabel=(days,category)=>days===0?({renew:'Renewal day',trial:'Trial ends',card:'Due day',bills:'Due day'}[category]||'On the day'):days===1?'1 day before':days+' days before';
  const urgency=days=>!Number.isFinite(days)?'neutral':days<0?'overdue':days===0?'today':days===1?'tomorrow':days<=3?'soon':days<=7?'week':days<=14?'early':'neutral';
  function friendlyTime(value,locale){
    if(!schedule.validLocalTime(value))return 'Choose a time';
    return new Date('2026-01-01T'+value+':00').toLocaleTimeString(locale,{hour:'numeric',minute:'2-digit'});
  }
  function copy(category,name,days,proven=false){
    const verb=category==='renew'?'renews':category==='trial'?'ends':'is due';
    const when=days<0?(proven?'is overdue':'may be overdue'):verb+' '+(days===0?'today':days===1?'tomorrow':days===14?'in 2 weeks':days===7?'next week':'in '+days+' days');
    const body=days<0?'Check its status in Cap.':days===0?'Review it before the day ends.':days===1?"Don’t let this one sneak past you.":days===14?'No rush — Cap has it on your radar.':days===7?'Plan ahead with Cap.':'Make sure your payment account is ready.';
    return {title:name+' '+when,body};
  }
  function create(options={}){
    const schedule=options.schedule||foundation;
    const read=options.read||((k)=>storage('get',k)),write=options.write||((k,v)=>storage('put',k,v));
    const now=options.now||(()=>Date.now()),zone=options.zone||(()=>Intl.DateTimeFormat().resolvedOptions().timeZone);
    const lock=options.lock||((owner,fn)=>{
      if(!navigator.locks?.request)throw error('COORDINATION_UNAVAILABLE');
      return navigator.locks.request('cap-reminder-editor:'+owner,fn);
    });
    const reviewed=new Map();
    const signature=d=>JSON.stringify([d.source,d.id,d.due_date,d.cycle_context||'']);
    function proof(owner,item,descriptor){
      const evidence=reviewed.get(owner+':'+item.obligation_id);
      return evidence?.signature===signature(descriptor)&&evidence.incarnation===descriptor.incarnation;
    }
    async function load(owner){
      const data=await read(key(owner));
      if(data&&(data.version!==1||!Array.isArray(data.items)||data.items.some(i=>!i||!Array.isArray(i.reminders)||typeof i.obligation_id!=='string'||typeof i.source_handle!=='string'||!schedule.validDateKey(i.due_date))))throw error('EDITOR_STATE_INVALID');
      return data||{version:1,items:[]};
    }
    async function checked(owner,id,descriptor){
      const data=await load(owner),item=data.items.find(i=>i.obligation_id===id&&!i.closed);
      if(!item||!proof(owner,item,descriptor))throw error('REVIEW_REQUIRED');
      const mapping=await schedule.loadIdentities(owner);
      const occurrence=mapping?.occurrences.find(o=>o.obligation_id===id&&o.state==='open');
      if(!occurrence||!mapping.sources.some(s=>s.source_handle===item.source_handle&&s.state==='open'))throw error('REVIEW_REQUIRED');
      return {data,item,mapping,occurrence};
    }
    async function review(owner,descriptor,mode,preferences={}){
      if(!descriptor||!schedule.validDateKey(descriptor.due_date)||!['bill','subscription','trial','statement'].includes(descriptor.source))throw error('SOURCE_UNAVAILABLE');
      return lock(owner,async()=>{
        const data=await load(owner),existing=data.items.find(i=>!i.closed&&i.source===descriptor.source&&String(i.id)===String(descriptor.id));
        let source_handle=existing?.source_handle,obligation_id=existing?.obligation_id;
        if(!['same','cycle','source'].includes(mode))throw error('REVIEW_REQUIRED');
        if(mode==='same'){
          if(!existing)throw error('REVIEW_REQUIRED');
          const mapping=await schedule.loadIdentities(owner);
          if(!mapping?.occurrences.some(o=>o.obligation_id===obligation_id&&o.state==='open')||!mapping.sources.some(s=>s.source_handle===source_handle&&s.state==='open'))throw error('REVIEW_REQUIRED');
        }else{
          if(existing){
            const current=await schedule.loadIdentities(owner),sourceOpen=current?.sources.some(s=>s.source_handle===source_handle&&s.state==='open');
            if(!sourceOpen&&mode==='cycle')throw error('REVIEW_REQUIRED');
            if(sourceOpen&&(mode==='source'||current.occurrences.some(o=>o.obligation_id===obligation_id&&o.state==='open')))await schedule.mutateIdentities(owner,{type:mode==='source'?'close_source':'close_occurrence',source_handle,obligation_id});
            for(const old of data.items)if(old.obligation_id===obligation_id||mode==='source'&&old.source_handle===source_handle)old.closed=true;
            if(!sourceOpen)source_handle=null;
          }
          if(mode==='source'){
            // An earlier failed editor write can leave an orphan mapping. This
            // explicit recreated-item action may close it, never reuse its IDs.
            const current=await schedule.loadIdentities(owner);
            for(const source of current?.sources.filter(s=>s.state==='open'&&s.source===descriptor.source&&s.local_id===String(descriptor.id))||[])await schedule.mutateIdentities(owner,{type:'close_source',source_handle:source.source_handle});
          }
          if(!source_handle||mode==='source')source_handle=(await schedule.mutateIdentities(owner,{type:'create_source',source:descriptor.source,local_id:String(descriptor.id),creation_token:crypto.randomUUID()})).record.source_handle;
          obligation_id=(await schedule.mutateIdentities(owner,{type:'ensure_occurrence',source_handle,cycle_token:crypto.randomUUID()})).record.obligation_id;
        }
        let item=mode==='same'?existing:null;
        if(!item){
          item={source:descriptor.source,id:String(descriptor.id),source_handle,obligation_id,category:descriptor.category,due_date:descriptor.due_date,uses_defaults:true,reminders:[],closed:false};
          const {policy}=await schedule.ensurePolicy(preferences);
          const stages=policy.category_stages[descriptor.category]||policy.default_stages;
          for(const days of stages){
            const reminder=(await schedule.mutateIdentities(owner,{type:'ensure_reminder',source_handle,obligation_id,rule_token:crypto.randomUUID()})).record;
            item.reminders.push({reminder_id:reminder.reminder_id,kind:'relative',days_before:days,time_source:'inherit'});
          }
          data.items.push(item);
        }
        item.due_date=descriptor.due_date;item.category=descriptor.category;
        await write(key(owner),data);reviewed.set(owner+':'+obligation_id,{signature:signature(descriptor),incarnation:descriptor.incarnation});
        return clone(item);
      });
    }
    async function compile(owner,item,policy,reference=now(),mapping){
      mapping=mapping||await schedule.loadIdentities(owner);
      const active=mapping?.occurrences.find(o=>o.obligation_id===item.obligation_id&&o.state==='open');
      const reminders=item.reminders.filter(r=>active?.reminders.some(m=>m.reminder_id===r.reminder_id&&m.state==='open'));
      const timezone=zone();
      if(!schedule.validTimezone(timezone))throw error('TIMEZONE_UNAVAILABLE');
      return schedule.compile({owner,reference,timezone,policy,identities:mapping,
        obligations:reminders.some(r=>r.kind==='relative')?[{id:item.id,source:item.source,category:item.category,occurrences:[{obligation_id:item.obligation_id,due_date:item.due_date,reminders:reminders.filter(r=>r.kind==='relative')}]}]:[],
        absolute:reminders.filter(r=>r.kind==='absolute').map(r=>({...r,id:item.id,source:item.source,obligation_id:item.obligation_id}))});
    }
    async function saveReminder(owner,id,descriptor,raw,reminderId){
      return lock(owner,async()=>{
        const {data,item}=await checked(owner,id,descriptor);
        const policy=await schedule.loadPolicy();if(!policy)throw error('EDITOR_STATE_INVALID');
        const existing=reminderId&&item.reminders.find(r=>r.reminder_id===reminderId);
        if(reminderId&&!existing||existing?.deleted)throw error('REVIEW_REQUIRED');
        let reminder;
        if(raw.kind==='relative'){
          if(!schedule.LEAD_DAYS.includes(raw.days_before)||!['inherit','override'].includes(raw.time_source)||raw.time_source==='override'&&!schedule.validLocalTime(raw.override_local_time))throw error('REMINDER_INVALID');
          reminder={kind:'relative',days_before:raw.days_before,time_source:raw.time_source,...(raw.time_source==='override'?{override_local_time:raw.override_local_time}:{})};
        }else if(raw.kind==='absolute'){
          if(!schedule.validDateKey(raw.local_date)||!schedule.validLocalTime(raw.local_time))throw error('REMINDER_INVALID');
          const timezone=existing?.kind==='absolute'?existing.timezone:zone(),resolved=schedule.resolveWall(raw.local_date,raw.local_time,timezone);
          if(!resolved.ok)throw error(resolved.reason);
          if(resolved.ms<=now())throw error('REMINDER_PAST');
          reminder={kind:'absolute',local_date:raw.local_date,local_time:raw.local_time,timezone,send_after:schedule.isoSeconds(resolved.ms)};
        }else throw error('REMINDER_INVALID');
        // Validate with the real compiler BEFORE allocating a creation identity.
        // A temporary candidate uses the existing identity only for validation;
        // the final creation always receives its own durable Phase 2B record.
        const mapping=await schedule.loadIdentities(owner);
        const live=mapping.occurrences.find(o=>o.obligation_id===id);
        const probeId=reminderId||crypto.randomUUID();
        const probeMapping=clone(mapping);
        if(!reminderId)probeMapping.occurrences.find(o=>o.obligation_id===id).reminders.push({reminder_id:probeId,state:'open'});
        else if(!live.reminders.some(r=>r.reminder_id===reminderId&&r.state==='open'))throw error('REVIEW_REQUIRED');
        const probe={...item,reminders:item.reminders.filter(r=>r.reminder_id!==reminderId&&!r.deleted).concat({...reminder,reminder_id:probeId})};
        // Validate even a past relative instant for collision/DST, without changing
        // the stored clock/reference of the actual schedule.
        const earliest=Date.parse((reminder.kind==='absolute'?reminder.local_date:schedule.shiftDateKey(item.due_date,-14))+'T00:00:00Z')-2*864e5;
        const plan=await compile(owner,probe,policy,Math.min(now(),earliest),probeMapping);
        if(plan.identity_blocked)throw error('REVIEW_REQUIRED');
        if(plan.issues.length)throw error('NOTIFICATION_LOCAL_TIME_GAP');
        const collision=plan.collisions.find(c=>c.winner===probeId||c.loser===probeId);
        if(collision){
          if(reminder.kind!=='absolute'||collision.winner!==probeId||collision.loser_kind==='absolute')throw error('REMINDER_DUPLICATE');
          // Explicit custom wins: durably delete the colliding relative reminder.
          await schedule.mutateIdentities(owner,{type:'delete_reminder',source_handle:item.source_handle,obligation_id:id,reminder_id:collision.loser});
          const loser=item.reminders.find(r=>r.reminder_id===collision.loser);if(loser)loser.deleted=true;
        }
        if(!reminderId)reminderId=(await schedule.mutateIdentities(owner,{type:'ensure_reminder',source_handle:item.source_handle,obligation_id:id,rule_token:crypto.randomUUID()})).record.reminder_id;
        const index=item.reminders.findIndex(r=>r.reminder_id===reminderId);
        const record={...reminder,reminder_id:reminderId};if(index<0)item.reminders.push(record);else item.reminders[index]=record;
        item.uses_defaults=false;await write(key(owner),data);
        return {reminder:record,custom_won:!!collision};
      });
    }
    async function remove(owner,id,descriptor,reminderId){
      return lock(owner,async()=>{
        const {data,item}=await checked(owner,id,descriptor);
        await schedule.mutateIdentities(owner,{type:'delete_reminder',source_handle:item.source_handle,obligation_id:id,reminder_id:reminderId});
        const reminder=item.reminders.find(r=>r.reminder_id===reminderId);if(reminder)reminder.deleted=true;
        item.uses_defaults=false;await write(key(owner),data);
      });
    }
    async function items(owner,descriptors){
      const data=await load(owner),policy=await schedule.loadPolicy(),mapping=await schedule.loadIdentities(owner);
      const result=[];
      for(const item of data.items.filter(i=>!i.closed)){
        const matches=descriptors.filter(d=>d.source===item.source&&String(d.id)===item.id),descriptor=matches.length===1?matches[0]:null;
        const occurrence=mapping?.occurrences.find(o=>o.obligation_id===item.obligation_id&&o.state==='open');
        const safe=descriptor&&proof(owner,item,descriptor)&&occurrence&&mapping.sources.some(s=>s.source_handle===item.source_handle&&s.state==='open');
        const reminders=item.reminders.filter(r=>!r.deleted&&occurrence?.reminders.some(m=>m.reminder_id===r.reminder_id&&m.state==='open'));
        result.push({...item,reminders,review_required:!safe,plan:safe&&policy?await compile(owner,{...item,reminders},policy):null});
      }
      return result;
    }
    async function defaults(owner,category,stages){
      if(!schedule.CATEGORIES.includes(category)||!Array.isArray(stages)||stages.some(d=>!schedule.LEAD_DAYS.includes(d)))throw error('REMINDER_INVALID');
      return lock(owner,async()=>{
        const policy=await schedule.loadPolicy(),data=await load(owner);
        if(!policy)throw error('EDITOR_STATE_INVALID');
        // This is an explicit defaults edit. Retain unchanged rules; removed rules
        // get tombstones and newly selected rules get new creation identities.
        for(const item of data.items.filter(i=>!i.closed&&i.uses_defaults&&i.category===category)){
          for(const r of item.reminders.filter(r=>!r.deleted&&!stages.includes(r.days_before))){
            await schedule.mutateIdentities(owner,{type:'delete_reminder',source_handle:item.source_handle,obligation_id:item.obligation_id,reminder_id:r.reminder_id});r.deleted=true;
          }
          for(const days of stages)if(!item.reminders.some(r=>!r.deleted&&r.days_before===days)){
            const record=(await schedule.mutateIdentities(owner,{type:'ensure_reminder',source_handle:item.source_handle,obligation_id:item.obligation_id,rule_token:crypto.randomUUID()})).record;
            item.reminders.push({kind:'relative',days_before:days,time_source:'inherit',reminder_id:record.reminder_id});
          }
        }
        await write(key(owner),data);
        return schedule.savePolicy({...policy,category_stages:{...policy.category_stages,[category]:[...new Set(stages)].sort((a,b)=>b-a)}});
      });
    }
    async function defaultTime(owner,time){
      if(!schedule.validLocalTime(time))throw error('REMINDER_INVALID');
      return lock(owner,async()=>{
        const policy=await schedule.loadPolicy();if(!policy)throw error('EDITOR_STATE_INVALID');
        return schedule.savePolicy({...policy,default_local_time:time});
      });
    }
    return Object.freeze({load,review,saveReminder,remove,items,compile,defaults,defaultTime,forget:()=>reviewed.clear()});
  }
  return Object.freeze({create,storage,leadLabel,friendlyTime,copy,urgency});
});
