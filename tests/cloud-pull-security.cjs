/* Fresh, scoped pre-release checks. No credentials or matching values printed. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const allowed=['index.html','js/cloud-to-local.js','js/cloud-bootstrap.js','js/sync-production.js','service-worker.js',
  'tests/cloud-bootstrap.cjs','tests/cloud-pull.cjs','tests/cloud-pull-shell.cjs','tests/cloud-pull-security.cjs','docs/phase6n.md'];
const git=(...args)=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/).filter(Boolean);
const changed=[...new Set([...git('diff','--name-only','HEAD'),...git('ls-files','--others','--exclude-standard')])];
assert.ok(changed.every(f=>allowed.includes(f)),'Unexpected files in proposed release');
assert.ok(changed.every(f=>!/(^|\/)(\.env(?:\.|$)|.*\.(?:dump|bak|sql|pem|key)$)|backup|snapshot.*\.json$/i.test(f)),'Sensitive/artifact filename');
const patterns=[/sb_secret_[A-Za-z0-9_-]{12,}/,/\b(?:ghp_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/,
  /(?:database_password|db_password|service_role_key|access_token|supabase_secret)\s*[:=]\s*["'][^"']{8,}["']/i];
for(const file of changed){
  const text=fs.readFileSync(path.join(root,file),'utf8');
  assert.ok(!patterns.some(p=>p.test(text)),'Credential-pattern match in '+file);
  for(const jwt of text.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)){
    const payload=JSON.parse(Buffer.from(jwt[0].split('.')[1],'base64url').toString());
    assert.notEqual(payload.role,'service_role','Privileged JWT in '+file);
  }
}
const sync=fs.readFileSync(path.join(root,'js/sync-production.js'),'utf8');
assert.deepEqual([...sync.matchAll(/\brpc\('(cap_[a-z0-9_]+)'/g)].map(m=>m[1]).sort(),
  ['cap_sync_snapshot_v1','cap_verify_production_sync_v1','cap_sync_transaction_create','cap_notes_change'].sort());
const financial=sync.slice(sync.indexOf('    async function financialPull('),sync.indexOf('    async function pull('));
assert.ok(!/io\.write\(|\brpc\(/.test(financial));
console.log('PASS: 4 fresh Phase 6N release security checks; scoped files, credential patterns, unchanged RPC allowlist, read-only financial pull');
