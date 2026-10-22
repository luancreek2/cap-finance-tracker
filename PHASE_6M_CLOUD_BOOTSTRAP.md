# Phase 6M — Set Up This Device From Cloud

Implementation only. No deployment, production mutation, Device A changes, or test-transaction cleanup.

## Boundary

This is explicit **initial provisioning**, not the ongoing sync pull engine. The only network operations are authenticated owner verification and the reviewed production readiness/snapshot RPCs. No cloud writer is called. Device A and its baseline are never read from browser storage or modified.

Settings → Privacy & Sync → **Set Up This Device From Cloud** is enabled only for an online, authenticated, empty device with automatic sync OFF, no baseline, no queue/conflicts, and no recovery journal. Reopening Settings refreshes availability. The operation repeats these gates; a stale button cannot bypass them.

Fresh installs now start with empty financial/user collections and built-in categories, rather than silently generating the demo dataset. Existing saved data is not replaced or cleared. An older browser already containing demo data is intentionally refused: this phase has no implicit demo detector or merge/overwrite option.

## Sequence and verification

1. Take an exact before image of IndexedDB (`kv`, `syncmeta`, outbox, conflicts), memory, localStorage `pera`, and the existing local rollback snapshot (auxiliary keys, excluding authentication secrets).
2. Refuse meaningful local data or customization, including a newer persisted financial copy. Only empty collections and exact built-in category entries/default preferences are allowed.
3. Authenticate a UUID owner; bind the operation to the current session generation. Require all production readiness checks through `CapProductionRpc.readiness()`.
4. Fetch `CapProductionRpc.snapshot(owner)`. Require the complete versioned contract, exact counts for all 13 entities, unique owned identities, one profile/preferences row, accounts present, and active valid Notes lifecycle envelopes.
5. Construct an isolated candidate. `migrationPrepare(candidate)` and `buildSupabaseMigrationPlan(report, owner, candidate)` do not swap global `S`.
6. Use the real `validateRealData` against a fresh RPC snapshot. Require 0 missing/unexpected/mismatches/FK and zero dry-run actions. Require that full snapshot's rows (including timestamps) match the original read.
7. Compare **all 13 entity fingerprints**, including Notes/profile/preferences. Require exact identity reproduction, N valid owned fingerprints and unique mappings. Run the actual Phase 6L planner with the candidate baseline; require every action list empty.
8. Re-read cloud before confirmation and immediately afterward. Any record, lifecycle, count, or timestamp change aborts. Recheck identity/session, OFF state, memory/localStorage and the complete IDB before image at commit.
9. One IDB transaction installs `kv.state`, a **v2 baseline directly**, OFF device settings, a full rollback receipt, and a pending checkpoint. It never writes outbox/conflicts. A failed request, state write or baseline write aborts the whole transaction.
10. Install memory/localStorage; re-read IDB and localStorage, not just the candidate. Require all persisted copies and baseline to agree. Re-read cloud and repeat the complete verification. Remove the pending checkpoint only after success. Retain the rollback receipt in `kv`.
11. Display **Device ready — Cloud Sync can now be enabled**. No automatic toggle, no v1 intermediate baseline, no Upgrade button needed.

The cloud cannot be locked across the network by a read-only client. Changes through the final verification are detected; later changes are handled/refused by the unchanged explicit activation preflight. Financial remote pulls remain outside this phase.

## Cloud → local mapping

| Entity | Local representation |
|---|---|
| accounts | numeric `legacy_id → id`; `account_type → type`, `balance → bal`, `network → net`, `last_four → l4`, `card_art → img`, `photo_url → photo`, `credit_limit → lim`, status/nickname/bank/name; statement/due fields; minimum-payment object, fees object, whitelisted interest settings, statement history |
| transactions | preserve original metadata first (timestamps, `_u`, fee/custom attributes); overwrite authoritative normalized columns into `id,d,amt,acct,cat,note,desc,pd,billId,parentId,statementId`; posted/pending go to `tx`/`pend` |
| categories | `legacy_id → id`, `name/emoji/logo_url/archived → n/i/l/a`; UUID/name lookup resolves references |
| bills | metadata first (including paid history); normalized fields override name, amount, kind, frequency, dates, logo, subscription status, alerts and payment account |
| goals | `legacy_id → id`, target/saved amounts, name/icon, account relation, target date and completion |
| debts | `legacy_id → id`, person/note/amount/direction/due date → `who/note/amt/dir/due` |
| budgets | category UUID → category name → amount in `S.budgets`; duplicate/unsafe names refused |
| notes | stable array `{id,t,b,d}` from legacy ID/title/body/note_date; no relative-day string conversion |
| profiles | `display_name/photo_url → S.name/S.photo` |
| user_preferences | currency, numeric format, sign/decimals, theme, animation/motion/sound/haptics, balance hiding, logo, account view/sort/order |
| transfers | metadata first; normalized account/goal/statement references, kind, amount/date/note override into `S.xfer` |
| bill_payments | verify the linked posted payment transaction and bill, restore its due-cycle field; regenerate rows via the existing `billPayments(b, candidate)` logic |
| account_statements | reconcile statement metadata with normalized dates/balances/paid/minimum values and the account history; maintain statement-ID lookup for transaction/transfer references |

Every candidate is round-tripped through the existing forward mapper. Unknown/unreconstructable content cannot silently disappear: missing identities, extra generated rows, changed canonical fields or incorrect UUID mappings abort before installation.

## Rollback and interrupted startup

The durable pending checkpoint is included in the production engine's recovery guards. It blocks activation while a bootstrap is unfinished. `CapOff.boot()` checks it **before normal rendering/persistence** and restores the before image if startup finds an interrupted operation.

On installation/verification failure, restore the original IDB state/metadata transactionally, then memory/localStorage, and verify the restoration. Retain the backup receipt for inspection. Never clear a whole store or rewrite queues/conflicts. If another tab/user changes memory, storage, settings or unrelated records during recovery, refuse to overwrite that work, retain the checkpoint, and prominently report **HARD FAILURE**. Cloud Sync must remain OFF until reviewed. Atomicity spans IDB stores, not localStorage; the checkpoint bridges that boundary and supports retrying interrupted rollback.

## Deliberate limits / latent issues

- Local UI/import conventions require positive safe-integer legacy IDs for accounts, financial records and Notes. Nonrepresentable IDs are refused, never invented.
- Gradients and other UI-only card attributes absent from cloud rows cannot be recovered exactly. Gradients use a fixed safe palette; canonical cloud fields remain identical.
- Candidate verification also runs the existing render-time GCash compatibility normalization on the candidate, not global state. A cloud account that would have its network/art/type/name changed by rendering is refused instead of producing a stale baseline on the next reload.
- Transfer-backed/unpaid or otherwise non-round-trippable bill-payment rows are refused. Empty collections and linked posted transaction payments are supported/tested.
- Statement fallback-key inconsistencies remain in legacy code. Bootstrap must round-trip all statement/history/relationship fingerprints; ambiguous representations refuse rather than re-keying cloud data.
- The old validator omits Notes content. Bootstrap supplements it with all-record canonical comparisons and the production planner; no broad validation redesign was made.
- The legacy Initialize Baseline action still creates v1. Bootstrap never calls it.
- Owner-independent deterministic UUID generation is unchanged. Bootstrap verifies every restored identity; changing production identity architecture is not Phase 6M.
- Bootstrap does not implement financial pulls, transaction edits/deletes, merge, realtime subscriptions, or automatic sync activation. Two-device ongoing transaction reception remains Phase 6N.

## Tests

No tests contact Supabase or use a personal browser profile. The fixtures have 3 accounts, 11 transactions (including the named ₱1 test), 10 categories, 4 bills, 3 goals, 3 debts, 7 budgets, 1 note, profile/preferences: **44 records**, total **₱44,169**. Additional fixtures exercise non-empty transfers, statements and bill payments, richer preferences/settings, invalid data, owner/session/local/cloud races, transaction aborts, localStorage failure, post-install failure, interrupted startup recovery and hard-failure preservation.

```powershell
$env:CAP_FAKE_IDB_PATH = '<external test dependencies>\fake-indexeddb'
node tests/cloud-bootstrap.cjs
```

Optional offline compatibility check against a previously saved complete snapshot (not committed into the repository):

```powershell
$env:CAP_BOOTSTRAP_SNAPSHOT_PATH = '<saved snapshot JSON containing snapshot.records>'
node tests/cloud-bootstrap.cjs
```

Manual controlled Device B test (only after review/deployment): use a truly fresh, separate browser context; sign in; verify empty local finances; run setup; confirm restored values and N/N baseline fingerprints; reload; recheck persistence; explicitly enable only afterward. Do not use Device A for bootstrap testing. An existing data-bearing Device B is intentionally refused.

### Local verification record (2026-10-23)

- Dedicated suite: 64 synthetic checks passed. Optional offline check of the saved 44-record production snapshot also passed (65 checks when included). No live production calls.
- All 49 existing regression suites passed (1,450 checks); together with Phase 6M: 50 suites / 1,514 checks, zero failures.
- JavaScript syntax, manifest/vercel JSON parsing, and patch whitespace checks passed.
- Isolated browser origin with Supabase configuration disabled: actual Settings action, synthetic reviewed-RPC responses, 44 records / 44 valid fingerprints, direct v2 baseline, total 44,169, outbox/conflicts zero, Sync OFF, exact success message.
- Stopped the isolated HTTP server and reloaded through the service worker: 11 transactions, 44 baseline records persisted, all 44 local-to-baseline fingerprints still equal, Notes date still 2026-10-22, Sync OFF. The new module was present in shell cache v321. Settings action also renders under light/dark themes.
- Device A, Supabase, authentication credentials and the live test transaction were not modified. Local smoke servers were stopped afterward.
