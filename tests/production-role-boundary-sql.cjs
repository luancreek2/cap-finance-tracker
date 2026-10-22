/* Exact PG16+ retained creator grant, non-superuser postgres, disposable only. */
const {PGlite}=require(process.env.CAP_PGLITE_PATH||'@electric-sql/pglite');
const {run}=require('./helpers/production-role-boundary-scenarios.cjs');
(async()=>{const db=new PGlite();try{const checks=await run(db);
  console.log(`PASS: ${checks} retained creator-membership and repair checks; isolated PGlite only`);
}finally{await db.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
