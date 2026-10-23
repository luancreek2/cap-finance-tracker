# Local Cap preview with real Supabase authentication

1. Edit **`supabase-config.local.js`** at the repository root. It is ignored by
   Git. If missing on a fresh clone, copy `supabase-config.local.example.js` to
   that filename. Replace the two placeholders with your project's browser-safe
   Project URL and Publishable key (or legacy **anon** key). Never use a
   service-role key, database password, signing secret, or user session tokens.
2. Serve the root: `npx --yes serve . -l 8000`.
3. Open `http://localhost:8000/` (or `http://127.0.0.1:8000/`). Reload after editing
   the local config. Look for the small **LOCAL** marker and sign in normally.

The same Auth endpoints, server identity verification, production RPC allowlist,
and RLS protections are used. This is **not** an authentication bypass. No key
or token is displayed in the indicator or configuration error message.

## Financial and sync safety

Authentication does not fetch/upload your financial data or enable Cloud Sync.
The local-preview IndexedDB database is `cap-finance-local-preview`; the old
`cap-finance` database is left untouched. A fresh preview has no sync settings,
baseline, or queue, so automatic Cloud Sync is OFF until explicitly enabled
through the existing guarded toggle. Production browser storage/preferences are
on a different origin and are not changed. Ports, `localhost`, and `127.0.0.1`
also have separate browser storage; use one stable URL for repeat previews.

Existing localStorage financial data on your chosen local origin is preserved,
not reset or copied from production. If that origin contains old test data, use
a fresh port/profile rather than deleting data you may need.

On an empty signed-in preview, use the existing **Set Up This Device From Cloud**
action to populate local accounts/transactions for preview. Its Phase 6M guards
and read-only cloud behavior are unchanged. Do not enable Cloud Sync for UI
experiments against your production project: if explicitly enabled, the real
reviewed RPCs can write real data. Prefer a separate development Supabase project
when testing sync writes. Developer Options remains independently OFF by default;
enable it locally only when diagnostics are needed.

## Configuration and PWA behavior

- Only exact loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) load the local
  file. Missing, placeholder, invalid, or privileged local keys fail closed; Cap
  never falls back to generated production credentials on those hosts.
- Nonlocal hosts still load the existing generated `supabase-config.js`.
  Vercel's build command and environment-variable generation are unchanged.
  Production never requests or depends on the ignored local file.
- Local config URLs are cache-busted. Local previews do not register the Cap
  service worker. An older controlling Cap worker is unregistered and its
  `cap-shell-*` caches are cleared on this local origin; the controlled document
  stops and reloads before cached app scripts can boot. Financial storage and
  auth sessions are not deleted. If cleanup is blocked, use browser DevTools →
  Application → Service Workers → unregister Cap, then reload.
- Production still has its normal installable/offline shell and network-first
  navigation fallback. This release uses `cap-shell-v326`.

Do not share copies or logs of the config. `git check-ignore
supabase-config.local.js` should print only the filename; `git ls-files --
supabase-config.local.js` should print nothing. Ignoring a file protects Git-based
deployments, not a manual full-folder upload—exclude the file from such uploads.

## Verification

`tests/local-development.cjs` tests host selection, config rejection, worker
cleanup, storage separation, and unchanged production loading with synthetic
values only. `tests/local-development-browser.cjs` uses an optional external
Playwright installation (`CAP_PLAYWRIGHT_PATH`) and a disposable server/profile.
It exercises the real login/session code against a mocked HTTP Auth server—not
fake production identity—and never contacts a real Supabase project. The actual
account sign-in check requires the owner's local values and is a manual step.
