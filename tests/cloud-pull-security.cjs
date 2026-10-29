/* Fresh, scoped pre-release checks. No credentials or matching values printed. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const allowed=['index.html','js/cloud-to-local.js','js/cloud-bootstrap.js','js/production-rpc.js','js/supabase.js','js/sync-production.js','service-worker.js',
  '.gitignore','js/runtime-config.js','supabase-config.local.example.js','docs/local-development.md',
  'css/offline-auth.css','tests/local-development.cjs','tests/local-development-browser.cjs',
  'js/app.js','js/cards.js','js/animations.js','css/styles.css','css/animations.css',
  'tests/ui-presentation.cjs','tests/helpers/ui-presentation-browser.js',
  'tests/cloud-bootstrap.cjs','tests/cloud-pull.cjs','tests/cloud-pull-shell.cjs','tests/cloud-pull-security.cjs',
  'tests/client-rpc-only.cjs','tests/cloud-transaction-update-delete.cjs','tests/phase6o-sql.cjs','docs/phase6n.md','docs/phase6o.md',
  'assets/branding/chatgpt.svg','assets/branding/minecraft.svg','tests/upcoming-presentation.cjs',
  'js/supabase.js','tests/offline-auth.cjs',
  'js/command-bar.js','css/command-bar.css','tests/command-bar.cjs',
  'tests/command-bar-keyboard.cjs','tests/manual/command-bar-keyboard.md',
  'tests/calendar-inertia.cjs',
  'js/smart-log-parser.js','js/smart-log-merchants.js','js/smart-log.js','css/smart-log.css','tests/smart-log-parser.cjs','tests/smart-log-browser.cjs',
  'js/financial-search-parser.js','js/financial-search-engine.js','js/financial-search.js','css/financial-search.css','tests/financial-search.cjs','tests/financial-search-browser.cjs',
  'docs/financial-search.md',
  'css/financial-health.css','docs/financial-health.md','js/financial-health-engine.js','js/financial-health.js','tests/financial-health.cjs','tests/financial-health-browser.cjs',
  'tests/bluish-white.cjs','tests/bluish-white-browser.cjs',
  'tests/home-logo-browser.cjs',
  'js/notification-engine.js','js/notifications.js','css/notifications.css','docs/notifications.md','tests/notifications.cjs','tests/notifications-browser.cjs',
  'js/notification-enrollment.js','js/vapid-public.js','docs/notifications-phase5b2.md',
  'tests/notification-enrollment.cjs','tests/notification-enrollment-browser.cjs',
  'supabase_phase6o_transaction_update_delete.sql','tests/sync-presence-diagnostic.cjs',
  'tests/sync-presence-diagnostic-execution.cjs','tests/sync-presence-diagnostic-browser.cjs',
  'tests/sync-planner-presence-fix.cjs','tests/sync-planner-presence-execution.cjs',
  'tests/sync-recovery-hold.cjs','tests/sync-production.cjs','docs/sync-recovery-hold.md',
  'tests/apple-theme.cjs','tests/apple-theme-browser.cjs','css/activity-scope.css','tests/hero-balance-browser.cjs',
  'js/activity-scope.js','js/transactions.js','tests/apple-liquid-ui.cjs','tests/calendar-navigation.cjs',
  'tests/nav-icon-motion.cjs','css/account-options.css','js/account-options.js',
  'css/settings-shell.css','js/settings-shell.js','tests/settings-shell-browser.cjs',
  'docs/notifications-phase5b3.md','supabase/config.toml',
  'supabase/functions/cap-notification-sender/deno.json','supabase/functions/cap-notification-sender/deno.lock',
  'supabase/functions/cap-notification-sender/index.ts','supabase/functions/cap-notification-sender/results.ts',
  'supabase/functions/cap-notification-sender/runtime.ts','supabase/functions/cap-notification-sender/webpush.ts',
  'supabase_notifications_sender_5b3.sql',
  'tests/helpers/notification-sender-tests.ts','tests/helpers/sender-deno.cjs','tests/helpers/sender-pg.cjs',
  'tests/notification-sender-edge.cjs','tests/notification-sender.cjs','tests/notification-webpush.cjs','tests/notifications-sender-sql.cjs',
  'supabase_notifications_scheduling_v2.sql','docs/notification-scheduling-amendment.md','tests/notifications-scheduling-sql.cjs'];
const git=(...args)=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/).filter(Boolean);
const changed=[...new Set([...git('diff','--name-only','HEAD'),...git('ls-files','--others','--exclude-standard')])];
assert.ok(changed.every(f=>allowed.includes(f)),'Unexpected files in proposed release');
assert.ok(changed.every(f=>!/(^|\/)(\.env(?:\.|$)|.*\.dump$|.*\.bak$|.*\.pem$|.*\.key$)|backup|snapshot.*\.json$/i.test(f)),'Sensitive/artifact filename');
assert.ok(changed.every(f=>!/\.sql$/i.test(f)||/^supabase_[a-z0-9_]+\.sql$/.test(f)),'Unexpected SQL artifact');
const patterns=[/sb_secret_[A-Za-z0-9_-]{12,}/,/\b(?:ghp_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/,
  /(?:database_password|db_password|service_role_key|access_token|supabase_secret)\s*[:=]\s*["'][^"']{8,}["']/i];
/* Mocked-auth fixture: its fake token literals exist specifically to prove they
   never leak into UI or storage. Keep the JWT/service-role scan below enabled. */
const syntheticAuthFixture='tests/offline-auth.cjs';
for(const file of changed){
  const text=fs.readFileSync(path.join(root,file),'utf8');
  if(file!==syntheticAuthFixture)assert.ok(!patterns.some(p=>p.test(text)),'Credential-pattern match in '+file);
  for(const jwt of text.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)){
    const payload=JSON.parse(Buffer.from(jwt[0].split('.')[1],'base64url').toString());
    assert.notEqual(payload.role,'service_role','Privileged JWT in '+file);
  }
}
const sync=fs.readFileSync(path.join(root,'js/sync-production.js'),'utf8');
assert.deepEqual([...sync.matchAll(/\brpc\('(cap_[a-z0-9_]+)'/g)].map(m=>m[1]).sort(),
  ['cap_notes_change','cap_sync_snapshot_v1','cap_sync_transaction_create','cap_sync_transaction_delete',
    'cap_sync_transaction_update','cap_verify_production_sync_v1','cap_verify_transaction_update_delete_v1'].sort());
const financial=sync.slice(sync.indexOf('    async function financialPull('),sync.indexOf('    async function pull('));
assert.ok(!/io\.write\(|\brpc\(/.test(financial));
console.log('PASS: 4 fresh Phase 6O release security checks; scoped files, credential patterns, exact RPC allowlist, read-only financial pull');
