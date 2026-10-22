/* Guard tests only; real races require the separately opted-in Docker harness. */
const assert=require('node:assert/strict'),fs=require('node:fs');
const {validateInvocation,validName}=require('./manual/transaction-create-races.cjs');
const ack='CREATE_DISPOSABLE_DOCKER_ONLY';let passed=0;
for(const env of [{},{CAP_TRANSACTION_RACE_ACK:'wrong'},
  {CAP_TRANSACTION_RACE_ACK:ack,CAP_TRANSACTION_RACE_URL:'postgresql://example.com/postgres'},
  {CAP_TRANSACTION_RACE_ACK:ack,CAP_TRANSACTION_RACE_CONTAINER:'existing-lab'}]){
  assert.throws(()=>validateInvocation(env),/FRESH_DISPOSABLE_DOCKER_ONLY/);passed++;
}
assert.doesNotThrow(()=>validateInvocation({CAP_TRANSACTION_RACE_ACK:ack}));passed++;
assert.equal(validName('cap-tx-create-lab-012345abcdef'),true);passed++;
for(const name of ['postgres','existing-lab','cap-notes-race-lab-012345abcdef','cap-tx-create-lab-other']){assert.equal(validName(name),false);passed++;}
const source=fs.readFileSync(`${__dirname}/manual/transaction-create-races.cjs`,'utf8');
for(const required of ["'--network','none'","'--tmpfs'",'pg_blocking_pids','new Set(pids).size,3',"inspection.Config.Labels['cap.transaction-create-test']!==suffix"]){assert.ok(source.includes(required));passed++;}
assert.ok(!/supabase\.co|localhost:5432|CAP_NOTES_RACE_URL/.test(source));passed++;
console.log(`PASS: ${passed} disposable transaction-race target guards; no database connection`);
