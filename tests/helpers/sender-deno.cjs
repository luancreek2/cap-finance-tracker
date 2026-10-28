'use strict';
const cp=require('node:child_process'),path=require('node:path');
exports.run=filter=>{
 if(!process.env.CAP_DENO_PATH)throw Error('CAP_DENO_PATH required; sender tests may not skip');
 const root=path.resolve(__dirname,'../..');
 const r=cp.spawnSync(process.env.CAP_DENO_PATH,['test','--cached-only','--frozen','--config',path.join(root,'supabase/functions/cap-notification-sender/deno.json'),
  '--allow-read='+root,'--allow-env',
  '--filter',filter,path.join(__dirname,'notification-sender-tests.ts')],{stdio:'inherit',timeout:180000});
 if(r.status!==0)process.exitCode=1;
};
