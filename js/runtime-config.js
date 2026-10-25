/* Parser-time configuration selection. No auth, data API or credential logging.
   This script must run before supabase.js; its selected script blocks parsing. */
(function(){
  'use strict';
  const local=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  function browserConfig(){
    const c=window.CAP_SUPABASE_CONFIG;
    if(!c||typeof c.url!=='string'||typeof c.publishableKey!=='string')return {};
    const url=c.url.trim(),key=c.publishableKey.trim();
    if(!url||!key||/PASTE_|YOUR_PROJECT|xxxxxxxx/i.test(url+' '+key))return {};
    try{
      const u=new URL(url);
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)return {};
      // Legacy anon JWTs are allowed only with the anon role. No token is used
      // as an authenticated identity; normal Auth /user verification is required.
      if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)){
        const p=key.split('.');if(p.length!==3)return {};
        const payload=JSON.parse(atob(p[1].replace(/-/g,'+').replace(/_/g,'/')));
        if(payload.role!=='anon')return {};
      }
      return {url:u.href.replace(/\/$/,''),publishableKey:key};
    }catch(_){return {}}
  }
  async function prepareLocalWorker(){
    try{
      const sw=navigator.serviceWorker,script=new URL('service-worker.js',location.href).href;
      const controlled=sw?.controller?.scriptURL===script;
      if(sw){
        const registrations=await sw.getRegistrations();
        for(const r of registrations){
          if([r.active,r.waiting,r.installing].some(w=>w?.scriptURL===script)){
            if(!(await r.unregister()))throw Error('Local worker still registered');
          }
        }
      }
      if(window.caches)for(const key of await caches.keys())if(key.startsWith('cap-shell-'))await caches.delete(key);
      if(controlled){location.reload();return new Promise(()=>{})}
      return true;
    }catch(_){return false}
  }
  // A missing/invalid local file must never reuse a generated production config.
  if(local)window.CAP_SUPABASE_CONFIG={};
  window.CapEnvironment=Object.freeze({local,browserConfig,
    databaseName:local?'cap-finance-local-preview':'cap-finance',
    ready:local?prepareLocalWorker():Promise.resolve(true)});
  if(local){
    // On the first visit after an older PWA, stop the old controlled document
    // before it can start cached app/sync scripts. Cleanup then reloads from the
    // network; no config/auth or financial state is loaded in that document.
    if(navigator.serviceWorker?.controller?.scriptURL===new URL('service-worker.js',location.href).href){
      window.stop();
      CapEnvironment.ready.then(ok=>{});
      return;
    }
  }
  // Both names are constants, never derived from URL/query/user input. The
  // parser-blocking load preserves the existing classic-script initialization.
  const file=local?'supabase-config.local.js?local='+Date.now():'supabase-config.js';
  document.write('<script src="'+file+'"><\/script>');
})();