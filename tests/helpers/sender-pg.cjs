/* Starts/stops a new loopback-only disposable PG17 cluster. No Docker, remote
   server, password, production schema, or persisted cryptographic key. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),cp=require('node:child_process');
exports.run=async(file)=>{
 const bin=process.env.CAP_PG_BIN;if(!bin)throw Error('Set CAP_PG_BIN to a local PostgreSQL17 bin directory');
 const base=process.env.CAP_TEST_TEMP||path.join(os.tmpdir(),'opencode');fs.mkdirSync(base,{recursive:true});
 const dir=path.join(fs.mkdtempSync(path.join(base,'cap-sender-pg-')),'data');
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
 const exe=n=>path.join(bin,n+(process.platform==='win32'?'.exe':''));
 const run=(n,args)=>{const r=cp.spawnSync(exe(n),args,{encoding:'utf8',timeout:60000});if(r.status!==0)throw Error('Local PG fixture command failed: '+n+' status='+r.status+' code='+(r.error?.code||'NONE')+' '+r.stdout+' '+r.stderr)};
 run('initdb',['-D',dir,'-U','supabase_admin','-A','trust','--encoding=UTF8','--no-locale','--no-sync']);
 run('pg_ctl',['-D',dir,'-l',path.join(dir,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -c fsync=off -c full_page_writes=off -c synchronous_commit=off`,'-w','start']);
 try{
  run('createdb',['-h','127.0.0.1','-p',String(port),'-U','supabase_admin','cap_notifications_synthetic_sender']);
  const result=cp.spawnSync(process.execPath,[file],{stdio:'inherit',timeout:300000,env:{...process.env,CAP_SENDER_TEST_DATABASE_URL:`postgresql://supabase_admin@127.0.0.1:${port}/cap_notifications_synthetic_sender`}});
  if(result.status!==0)throw Error('Local sender PG suite failed');
 }finally{run('pg_ctl',['-D',dir,'-m','fast','-w','stop']);}
};
