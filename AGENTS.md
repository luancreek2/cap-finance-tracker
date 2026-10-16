# Repository Notes

## Structure

- This is a dependency-free static PWA: there is no package manifest, build step, test runner, linter, or formatter.
- `index.html` is structure-only; styles live in `css/`, behavior in `js/`, and extracted images plus PWA icons in `assets/`.
- `manifest.json`, `assets/icons/`, and `service-worker.js` form the installable/offline shell; `vercel.json` only supplies required service-worker headers.
- Cloud sync is optional and depends on an ambient `claude.use("user"|"db")` host API. In a normal browser the app intentionally remains local-only.

## JavaScript organization

- Script order in `index.html` is significant: `cards.js` defines the card catalog needed while `app.js` seeds state, `transactions.js` adds transaction behavior, and `animations.js` installs wrappers/interactions and boots the app last.
- Enhancement initializers in `animations.js` deliberately run in the original wrapper order. Do not reorder them without tracing replacements of globals such as `render`, `openS`, `closeS`, `Activity`, and `acctMenu`.
- `render()` replaces `#app` contents and calls `save()`. Features that must retain DOM state across filtering should follow the existing `soft()` pattern rather than blindly calling `render()`.
- User state lives in global `S`, localStorage key `pera`, and IndexedDB database `cap-finance`. Keep schema changes backward-compatible with existing saved data and with JSON/CSV import/export.
- When adding a record collection, update persistence/merge normalization, especially `LIST_KEYS`, `normalize()`, seed/default initialization, and backup import/export handling.

## Run and Verify

- Serve from the repository root with `npx --yes serve . -l 8000`, then open `http://localhost:8000/`. Do not test PWA behavior through `file://`; service workers require HTTP(S).
- There are no automated tests. After UI or state changes, manually check reload persistence, add/edit/delete flows, import/export if touched, and both light and dark themes.
- After offline-shell changes, test one online load followed by an offline reload in browser DevTools.
- Syntax-check with `Get-ChildItem js/*.js | % { node --check $_ }`, `node --check service-worker.js`, and `node -e "JSON.parse(require('fs').readFileSync('manifest.json')); JSON.parse(require('fs').readFileSync('vercel.json'))"`.

## Service Worker

- Bump `VERSION` in `service-worker.js` whenever an HTML, CSS, JavaScript, manifest, or asset shell file changes; otherwise installed clients may keep the old shell.
- Keep navigation network-first with the cached `index.html` fallback, and do not intercept cross-origin or data/API requests.
- If shell paths change, update `CORE`/`MEDIA` in `service-worker.js` and manifest paths together.
