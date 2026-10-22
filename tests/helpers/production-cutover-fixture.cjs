/* Shared fixture for the dependency-ordered production cutover tests. It uses
   only synthetic rows from the snapshot fixture and the repository's prepared
   SQL drafts. No Supabase, app profile, baseline, outbox or production data is
   read. */
const fs = require('node:fs');
const snapshot = require('./production-snapshot-fixture.cjs');
const cutoverDraft = fs.readFileSync(
  `${__dirname}/../../supabase_production_cutover.sql`, 'utf8');
const cutoverSql = `set cap.production_cutover='reviewed-draft-only';\n${cutoverDraft}`;
module.exports = {
  ...snapshot,
  cutoverDraft,
  cutoverSql
};
