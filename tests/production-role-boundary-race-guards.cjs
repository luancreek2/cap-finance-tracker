/* Static/opt-in guards: importing the real runner never starts Docker. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {validateInvocation,validName}=require('./manual/production-role-boundary-races.cjs');
const source=fs.readFileSync(`${__dirname}/manual/production-role-boundary-races.cjs`,'utf8');
const sql=fs.readFileSync(`${__dirname}/../supabase_production_role_boundary.sql`,'utf8');
let checks=0;
assert.throws(()=>validateInvocation({}),/FRESH_DISPOSABLE_DOCKER_ONLY/);checks++;
const ack={CAP_ROLE_BOUNDARY_ACK:'CREATE_DISPOSABLE_DOCKER_ONLY'};
assert.doesNotThrow(()=>validateInvocation(ack));
for(const key of ['CAP_ROLE_BOUNDARY_URL','CAP_ROLE_BOUNDARY_CONTAINER'])
  assert.throws(()=>validateInvocation({...ack,[key]:'existing'}),/FRESH_DISPOSABLE_DOCKER_ONLY/);
checks++;
assert.equal(validName('cap-role-boundary-abcdef012345'),true);
assert.equal(validName('postgres'),false);assert.equal(validName('cap-role-boundary-short'),false);checks++;
for(const token of ["'127.0.0.1::5432'","'--tmpfs'","m.Type","Config.Labels['cap.role-boundary-test']!==suffix","docker(['rm','--force',name])"])
  assert.ok(source.includes(token),token);
checks++;
for(const token of ['m.member=target',"m.member=to_regrole('postgres')::oid",'m.admin_option',
  'not m.inherit_option','not m.set_option','b.oid=10 and b.rolsuper',"'authenticated','anon','service_role'",
  'c.relowner<>m.member'])assert.ok(sql.includes(token),token);
checks++;
assert.equal(/\b(?:grant|revoke)\s+\w+\s+(?:to|from)\s+postgres/i.test(sql),false);
assert.equal(/alter role|on schema auth|auth\.uid\(/i.test(sql),false);checks++;
console.log(`PASS: ${checks} retained-membership runner/invariant guards; no database started`);
