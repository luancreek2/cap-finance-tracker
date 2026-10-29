/* Phase 2B: deterministic client schedule compiler for the sealed Scheduling V2
   contract. Pure where practical: no DOM, no UI, no network, no Supabase, no
   financial writes, no push registration and no OS notification presentation.
   It projects local financial truth into notification-only V2 instructions.

   Remote shape (exactly eight string fields, never financial content):
     candidate_digest, obligation_digest, time_basis, eligible_local_date,
     local_time, timezone, send_after, expires_at

   Local-only source references stay on the in-memory/local record and are never
   part of a publication payload. Historical SQL, the worker and the Edge sender
   remain untouched. Publication itself is deliberately not wired here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CapNotificationSchedule = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const VERSION = 1;
  const POLICY_VERSION = 1;
  const PLAN_VERSION = 1;
  const ACK_VERSION = 1;
  const PROTOCOL = 'CAP_PUSH_V1';
  const ENGINE_IDENTITY = 'cap-reminder-v1';
  const DIGEST_VERSION = 'hmac-sha256-v1';
  const DEFAULT_LOCAL_TIME = '09:00';
  const LEAD_DAYS = Object.freeze([14, 7, 5, 3, 2, 1, 0]);
  const HORIZON_HOURS = 8760;
  const MAX_DELIVERY_HOURS = 24;
  const MAX_ENTRIES = 1000;
  const MAX_PAYLOAD_BYTES = 262144;
  const TIME_BASES = Object.freeze(['wall', 'absolute']);
  const TIME_SOURCES = Object.freeze(['inherit', 'override']);
  const CATEGORIES = Object.freeze(['bills', 'renew', 'trial', 'card']);
  const REMOTE_FIELDS = Object.freeze(['candidate_digest', 'obligation_digest', 'time_basis',
    'eligible_local_date', 'local_time', 'timezone', 'send_after', 'expires_at']);

  /* Truthful local/remote state names. SCHEDULED is only ever reported after an
     authoritative remote acknowledgment of the exact occurrence. */
  const STATES = Object.freeze({
    SAVED_LOCAL: 'SAVED_LOCAL',
    PENDING_SYNC: 'PENDING_SYNC',
    SCHEDULED: 'SCHEDULED',
    CHANGE_PENDING: 'CHANGE_PENDING',
    CANCELLATION_PENDING: 'CANCELLATION_PENDING',
    OUTSIDE_RANGE: 'OUTSIDE_RANGE',
    ACTION_REQUIRED: 'ACTION_REQUIRED',
    EXPIRED: 'EXPIRED',
    SENT: 'SENT',
    DELIVERY_UNCERTAIN: 'DELIVERY_UNCERTAIN'
  });

  /* Notification-only IndexedDB. Same database and store as Phase 5B.2B; a
     second notification database is deliberately not created. */
  const DB_NAME = 'cap-notifications';
  const DB_VERSION = 1;
  const STORE = 'state';
  const KEYS = Object.freeze({
    policy: 'scheduling.policy',
    plan: 'scheduling.plan',
    ack: 'scheduling.ack',
    identities: 'scheduling.identities',
    digestKey: 'scheduling.digest-key'
  });

  const HEX64 = /^[0-9a-f]{64}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const fail = reason => Object.assign(Error(reason), { code: reason });
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /* ---------------------------------------------------------------- calendar */

  function dateKey(y, m, d) { return pad(y, 4) + '-' + pad(m) + '-' + pad(d); }

  function parseDateKey(value) {
    const m = DATE_RE.exec(String(value == null ? '' : value));
    if (!m) return null;
    const y = +m[1], mo = +m[2], da = +m[3];
    const probe = new Date(Date.UTC(y, mo - 1, da, 12));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== da) return null;
    return { y, m: mo, d: da };
  }

  function validDateKey(value) { return parseDateKey(value) !== null; }

  function dayAtNoon(key) {
    const p = parseDateKey(key);
    return p ? new Date(Date.UTC(p.y, p.m - 1, p.d, 12)) : null;
  }

  // Calendar-day arithmetic. Never `days * 24 hours`, so DST cannot skew dates.
  function shiftDateKey(key, days) {
    const p = parseDateKey(key);
    if (!p) return null;
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d, 12) + Math.trunc(days) * 864e5);
    return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  function validLocalTime(value) { return typeof value === 'string' && TIME_RE.test(value); }

  function localTimeParts(value) {
    if (!validLocalTime(value)) return null;
    return { hour: Number(value.slice(0, 2)), minute: Number(value.slice(3, 5)) };
  }

  /* --------------------------------------------------------------- timezones */

  function validTimezone(zone) {
    if (typeof zone !== 'string' || !zone) return false;
    if (zone === 'UTC') return true;
    if (/^(posix|right)\//.test(zone)) return false;
    if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)+$/.test(zone)) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); return true; }
    catch (_) { return false; }
  }

  const formatters = new Map();
  function formatterFor(zone) {
    let f = formatters.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
        timeZone: zone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      formatters.set(zone, f);
    }
    return f;
  }

  function wallPartsAt(ms, zone) {
    const out = {};
    for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
      if (part.type !== 'literal') out[part.type] = part.value;
    }
    return { year: Number(out.year), month: Number(out.month), day: Number(out.day),
      hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second) };
  }

  function wallMs(y, m, d, hour, minute, second) {
    return Date.UTC(y, m - 1, d, hour, minute, second || 0, 0);
  }

  function offsetAt(ms, zone) {
    const whole = Math.floor(ms / 1000) * 1000;
    const p = wallPartsAt(whole, zone);
    return wallMs(p.year, p.month, p.day, p.hour, p.minute, p.second) - whole;
  }

  // Every UTC instant that renders as the requested wall time. Mirrors the SQL
  // resolver: sample offsets across the surrounding 48 hours, round-trip each
  // candidate and keep the exact matches.
  function wallCandidates(key, time, zone) {
    const day = parseDateKey(key), clock = localTimeParts(time);
    if (!day || !clock || !validTimezone(zone)) return null;
    const wall = wallMs(day.y, day.m, day.d, clock.hour, clock.minute, 0);
    const offsets = new Set();
    for (let t = wall - 48 * 3600e3; t <= wall + 48 * 3600e3; t += 3600e3) offsets.add(offsetAt(t, zone));
    const found = [];
    for (const offset of offsets) {
      const candidate = wall - offset;
      const p = wallPartsAt(candidate, zone);
      if (p.year === day.y && p.month === day.m && p.day === day.d &&
          p.hour === clock.hour && p.minute === clock.minute && p.second === 0) found.push(candidate);
    }
    return found.sort((a, b) => a - b);
  }

  // Approved contract: nonexistent wall time is rejected, an ambiguous fold
  // resolves to the later occurrence. The client must match the database.
  function resolveWall(key, time, zone) {
    const candidates = wallCandidates(key, time, zone);
    if (candidates === null) return { ok: false, reason: 'NOTIFICATION_LOCAL_TIME_INVALID' };
    if (!candidates.length) return { ok: false, reason: 'NOTIFICATION_LOCAL_TIME_GAP' };
    return { ok: true, ms: candidates[candidates.length - 1], candidates };
  }

  // Expiry ceiling mirrors `(date + 1) local midnight at time zone zone`, which
  // normalizes a gap instead of rejecting it, and takes the earlier fold instant.
  function resolveCeiling(key, zone) {
    const candidates = wallCandidates(key, '00:00', zone);
    if (candidates === null) return { ok: false, reason: 'NOTIFICATION_LOCAL_TIME_INVALID' };
    if (candidates.length) return { ok: true, ms: candidates[0] };
    // Gap exactly at midnight: advance to the first representable wall minute.
    for (let step = 1; step <= 180; step++) {
      const total = step;
      const time = pad(Math.floor(total / 60)) + ':' + pad(total % 60);
      if (!validLocalTime(time)) continue;
      const found = wallCandidates(key, time, zone);
      if (found && found.length) return { ok: true, ms: found[0] };
    }
    return { ok: false, reason: 'NOTIFICATION_LOCAL_TIME_GAP' };
  }

  function isoSeconds(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /* ------------------------------------------------------------------ expiry */

  function expiryFor(localDate, sendAfterMs, zone) {
    if (!validDateKey(localDate) || !Number.isFinite(sendAfterMs)) throw fail('NOTIFICATION_EXPIRY_INVALID');
    const nextDay = shiftDateKey(localDate, 1);
    const ceiling = resolveCeiling(nextDay, zone);
    if (!ceiling.ok) throw fail(ceiling.reason);
    const hard = sendAfterMs + MAX_DELIVERY_HOURS * 3600e3;
    const expires = Math.min(ceiling.ms, hard);
    if (!(expires > sendAfterMs)) throw fail('NOTIFICATION_EXPIRY_INVALID');
    return expires;
  }

  /* --------------------------------------------------------------- recurrence */

  // Local fallback mirrors CapFinancialSearchEngine.scheduled exactly. Callers
  // may inject the engine function; a parity test keeps both identical.
  function fallbackScheduled(recurrence, key) {
    const freq = recurrence.freq || 'monthly';
    const d = dayAtNoon(key);
    const start = recurrence.start && validDateKey(recurrence.start) ? dayAtNoon(recurrence.start) : null;
    if (!start) return Number(recurrence.due) === d.getUTCDate();
    if (key < recurrence.start) return false;
    if (freq === 'once') return key === recurrence.start;
    if (freq === 'weekly' || freq === 'biweekly') {
      return Math.round((d - start) / 864e5) % (freq === 'weekly' ? 7 : 14) === 0;
    }
    const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() === Math.min(start.getUTCDate(), last) &&
      (freq === 'yearly' ? months % 12 === 0 : freq === 'quarterly' ? months % 3 === 0 : true);
  }

  // Occurrence predicate is pure per date (it never depends on traversal), so a
  // bounded window is safe and cannot silently truncate a long-running series.
  // `fromKey` bounds the walk to the area that can still contribute a reminder
  // inside the horizon; `guard` is a defensive stop well above the window size.
  function projectDates(obligation, untilKey, scheduled, fromKey) {
    const recur = obligation.recurrence;
    if (!recur || !validDateKey(obligation.first_due) || !validDateKey(untilKey)) return [];
    const excluded = new Set((obligation.exclude || []).filter(validDateKey));
    const once = (recur.freq || 'monthly') === 'once';
    const dates = [];
    let key = !once && fromKey && validDateKey(fromKey) && fromKey > obligation.first_due
      ? fromKey : obligation.first_due;
    for (let guard = 0; guard < 800 && key && key <= untilKey; guard++) {
      if (scheduled(recur, key) && !excluded.has(key)) dates.push(key);
      if (once) break;
      key = shiftDateKey(key, 1);
    }
    return dates;
  }

  /* ----------------------------------------------------------------- digests */

  function subtle() {
    const api = typeof crypto !== 'undefined' ? crypto : null;
    if (!api || !api.subtle) throw fail('CRYPTO_UNAVAILABLE');
    return api.subtle;
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return Uint8Array.from(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    if (typeof value === 'string') return decodeBase64url(value);
    return null;
  }

  function hex(bytes) {
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
  }

  async function hmacHex(keyBytes, message) {
    const key = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await subtle().sign('HMAC', key, new TextEncoder().encode(message));
    return hex(new Uint8Array(signature));
  }

  const DOMAIN = Object.freeze({
    candidate: 'cap-push-digest-v1',
    obligationDigest: 'cap-push-obligation-v1'
  });

  // Random identities are allocated ONCE inside the durable mapping transaction.
  // Continuity tokens are explicit lifecycle evidence supplied by a reconciler,
  // never dates, stages, display values or guesses made by the compiler.
  function newIdentity() { return crypto.randomUUID(); }

  function emptyMapping(owner) {
    if (typeof owner !== 'string' || !owner) throw fail('IDENTITY_OWNER_REQUIRED');
    return { version: 1, owner, revision: 0, sources: [], occurrences: [] };
  }

  function activeOccurrence(mapping, id) {
    const occurrence = mapping && mapping.occurrences.find(o => o.obligation_id === id);
    return occurrence && occurrence.state === 'open' &&
      mapping.sources.some(s => s.source_handle === occurrence.source_handle && s.state === 'open')
      ? occurrence : null;
  }

  // Pure lifecycle reducer (also used by the atomic IndexedDB mutation below).
  // No inferred continuity: source_handle identifies an incarnation, cycle_token
  // identifies an explicitly established outstanding cycle, rule_token identifies
  // a reminder creation, not its scheduling parameters. Closed tokens never reopen.
  function updateMapping(previous, owner, command, allocate = newIdentity) {
    const mapping = previous ? JSON.parse(JSON.stringify(previous)) : emptyMapping(owner);
    if (mapping.version !== 1 || mapping.owner !== owner) throw fail('IDENTITY_OWNER_MISMATCH');
    const c = command || {};
    const token = value => {
      if (typeof value !== 'string' || !value || value.length > 256) throw fail('IDENTITY_CONTINUITY_REQUIRED');
      return value;
    };
    let result;
    if (c.type === 'create_source') {
      token(c.creation_token); token(c.source); token(c.local_id);
      const prior = mapping.sources.find(s => s.creation_token === c.creation_token);
      if (prior) {
        if (prior.state !== 'open' || prior.source !== c.source || prior.local_id !== c.local_id) throw fail('IDENTITY_CLOSED_OR_AMBIGUOUS');
        result = prior;
      } else {
        if (mapping.sources.some(s => s.state === 'open' && s.source === c.source && s.local_id === c.local_id)) throw fail('IDENTITY_CONTINUITY_REQUIRED');
        result = { source_handle: allocate(), source: c.source, local_id: c.local_id,
          creation_token: c.creation_token, state: 'open' };
        mapping.sources.push(result);
      }
    } else {
      const source = mapping.sources.find(s => s.source_handle === c.source_handle);
      if (!source || source.state !== 'open') throw fail('IDENTITY_SOURCE_CLOSED');
      if (c.type === 'close_source') {
        source.state = 'closed'; result = source;
        for (const o of mapping.occurrences.filter(o => o.source_handle === source.source_handle)) {
          o.state = 'closed'; for (const r of o.reminders) r.state = 'deleted';
        }
      } else if (c.type === 'ensure_occurrence') {
        token(c.cycle_token);
        result = mapping.occurrences.find(o => o.source_handle === source.source_handle && o.cycle_token === c.cycle_token);
        if (result && result.state !== 'open') throw fail('IDENTITY_OCCURRENCE_CLOSED');
        if (!result) {
          result = { obligation_id: allocate(), source_handle: source.source_handle,
            cycle_token: c.cycle_token, state: 'open', reminders: [] };
          mapping.occurrences.push(result);
        }
      } else {
        const occurrence = activeOccurrence(mapping, c.obligation_id);
        if (!occurrence || occurrence.source_handle !== source.source_handle) throw fail('IDENTITY_OCCURRENCE_CLOSED');
        if (c.type === 'close_occurrence') {
          occurrence.state = 'closed'; for (const r of occurrence.reminders) r.state = 'deleted'; result = occurrence;
        } else if (c.type === 'ensure_reminder') {
          token(c.rule_token);
          result = occurrence.reminders.find(r => r.rule_token === c.rule_token);
          if (result && result.state !== 'open') throw fail('IDENTITY_REMINDER_DELETED');
          if (!result) {
            result = { reminder_id: allocate(), rule_token: c.rule_token, state: 'open' };
            occurrence.reminders.push(result);
          }
        } else if (c.type === 'delete_reminder') {
          result = occurrence.reminders.find(r => r.reminder_id === c.reminder_id);
          if (!result) throw fail('IDENTITY_REMINDER_UNKNOWN');
          result.state = 'deleted';
        } else throw fail('IDENTITY_COMMAND_INVALID');
      }
    }
    mapping.revision++;
    return { mapping, record: JSON.parse(JSON.stringify(result)) };
  }

  // Read and mutate in ONE readwrite transaction: concurrent tabs cannot allocate
  // different IDs for the same migration/creation token. No key or enrollment IO.
  async function mutateIdentities(owner, command) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE), request = store.get(KEYS.identities + ':' + owner);
      let result, error;
      request.onsuccess = () => {
        try { result = updateMapping(request.result, owner, command); store.put(result.mapping, KEYS.identities + ':' + owner); }
        catch (e) { error = e; tx.abort(); }
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(error || tx.error || fail('IDENTITY_STORAGE_FAILED')); };
    });
  }
  function loadIdentities(owner) { return readValue(KEYS.identities + ':' + owner); }

  function digestMessage(domain, owner, installation, identity) {
    return [domain, String(owner).toLowerCase(), String(installation).toLowerCase(), String(identity)].join('\u0000');
  }

  async function candidateDigest(keyBytes, owner, installation, obligationId, reminderId) {
    if (!UUID_RE.test(obligationId) || !UUID_RE.test(reminderId)) throw fail('IDENTITY_CONTINUITY_REQUIRED');
    return hmacHex(keyBytes, digestMessage(DOMAIN.candidate, owner, installation, obligationId + '\u0000' + reminderId));
  }

  async function obligationDigest(keyBytes, owner, installation, obligationId) {
    return hmacHex(keyBytes, digestMessage(DOMAIN.obligationDigest, owner, installation, obligationId));
  }

  /* -------------------------------------------------------------- validation */

  function remoteEntry(entry) {
    const out = {};
    for (const field of REMOTE_FIELDS) {
      const value = entry && entry[field];
      if (typeof value !== 'string') throw fail('NOTIFICATION_ENTRY_INVALID');
      out[field] = value;
    }
    if (!HEX64.test(out.candidate_digest) || !HEX64.test(out.obligation_digest)) throw fail('NOTIFICATION_ENTRY_INVALID');
    if (!TIME_BASES.includes(out.time_basis)) throw fail('NOTIFICATION_ENTRY_INVALID');
    if (!validDateKey(out.eligible_local_date)) throw fail('NOTIFICATION_ENTRY_INVALID');
    if (!validLocalTime(out.local_time)) throw fail('NOTIFICATION_ENTRY_INVALID');
    if (!validTimezone(out.timezone)) throw fail('NOTIFICATION_ENTRY_INVALID');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.[0-9]{1,6})?Z$/.test(out.send_after)) throw fail('NOTIFICATION_ENTRY_INVALID');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.[0-9]{1,6})?Z$/.test(out.expires_at)) throw fail('NOTIFICATION_ENTRY_INVALID');
    if (!(Date.parse(out.expires_at) > Date.parse(out.send_after))) throw fail('NOTIFICATION_ENTRY_INVALID');
    return out;
  }

  // Publication payload: exactly the eight remote-safe fields, in a fixed order.
  function payload(entries) {
    if (!Array.isArray(entries)) throw fail('NOTIFICATION_ENTRIES_INVALID');
    if (entries.length > MAX_ENTRIES) throw fail('NOTIFICATION_ENTRIES_INVALID');
    const out = entries.map(remoteEntry);
    const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
    if (bytes > MAX_PAYLOAD_BYTES) throw fail('NOTIFICATION_ENTRIES_INVALID');
    return out;
  }

  /* ----------------------------------------------------------- policy / store */

  function normalizeStage(value, fallback) {
    const n = Number(value);
    return LEAD_DAYS.includes(n) ? n : fallback;
  }

  function normalizePolicy(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('SCHEDULING_POLICY_INVALID');
    const stages = list => {
      const seen = new Set();
      for (const stage of Array.isArray(list) ? list : []) {
        const n = Number(stage);
        if (LEAD_DAYS.includes(n)) seen.add(n);
      }
      return [...seen].sort((a, b) => b - a);
    };
    const category = raw.category_stages && typeof raw.category_stages === 'object' ? raw.category_stages : {};
    return {
      version: POLICY_VERSION,
      default_local_time: validLocalTime(raw.default_local_time) ? raw.default_local_time : DEFAULT_LOCAL_TIME,
      default_stages: stages(raw.default_stages),
      category_stages: Object.fromEntries(CATEGORIES.map(c => [c, stages(category[c])])),
      notification_timezone: validTimezone(raw.notification_timezone) ? raw.notification_timezone : null,
      acknowledged_timezone: validTimezone(raw.acknowledged_timezone) ? raw.acknowledged_timezone : null,
      plan_revision: Number.isSafeInteger(raw.plan_revision) && raw.plan_revision >= 0 ? raw.plan_revision : 0,
      preference_revision: Number.isSafeInteger(raw.preference_revision) && raw.preference_revision >= 1 ? raw.preference_revision : 1,
      migrated_from: typeof raw.migrated_from === 'string' ? raw.migrated_from : null,
      created_at: typeof raw.created_at === 'string' ? raw.created_at : null,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null
    };
  }

  // Conservative migration of Phase 5A preferences. Preserves the configured
  // lead per category, never enables extra stages, and never touches history,
  // enrollment or installation state.
  function migratePolicy(preferences) {
    const prefs = preferences && typeof preferences === 'object' ? preferences : {};
    return normalizePolicy({
      version: POLICY_VERSION,
      default_local_time: DEFAULT_LOCAL_TIME,
      default_stages: [3],
      category_stages: {
        bills: [normalizeStage(prefs.billsD, 3)],
        renew: [normalizeStage(prefs.renewD, 3)],
        trial: [normalizeStage(prefs.trialD, 3)],
        card: [normalizeStage(prefs.cardD, 5)]
      },
      notification_timezone: null,
      acknowledged_timezone: null,
      plan_revision: 0,
      preference_revision: 1,
      migrated_from: 'phase5a',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(fail('STORAGE_UNAVAILABLE'));
      let request;
      try { request = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (_) { return reject(fail('STORAGE_UNAVAILABLE')); }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { try { db.close(); } catch (_) {} };
        resolve(db);
      };
      request.onerror = () => reject(request.error || fail('STORAGE_UNAVAILABLE'));
      request.onblocked = () => reject(fail('STORAGE_BLOCKED'));
    });
  }

  function readValue(key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, 'readonly'); }
      catch (_) { db.close(); return reject(fail('STORAGE_READ_FAILED')); }
      const query = tx.objectStore(STORE).get(key);
      query.onsuccess = () => resolve(query.result == null ? null : query.result);
      query.onerror = () => reject(query.error || fail('STORAGE_READ_FAILED'));
      tx.oncomplete = () => db.close();
      tx.onerror = () => { db.close(); reject(tx.error || fail('STORAGE_READ_FAILED')); };
      tx.onabort = () => { db.close(); reject(tx.error || fail('STORAGE_READ_FAILED')); };
    }));
  }

  function writeValue(key, value) {
    return openDb().then(db => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, 'readwrite'); }
      catch (_) { db.close(); return reject(fail('STORAGE_WRITE_FAILED')); }
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error || fail('STORAGE_WRITE_FAILED')); };
      tx.onabort = () => { db.close(); reject(tx.error || fail('STORAGE_WRITE_FAILED')); };
    }));
  }

  function encodeBase64url(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeBase64url(value) {
    if (typeof value !== 'string' || !value) return null;
    let text = value.replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4) text += '=';
    try {
      const binary = atob(text);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    } catch (_) { return null; }
  }

  async function loadPolicy() {
    const stored = await readValue(KEYS.policy);
    return stored ? normalizePolicy(stored) : null;
  }

  // Idempotent: an existing policy is returned untouched. A first run derives
  // the policy from the user's current Phase 5A preferences.
  async function ensurePolicy(preferences) {
    const existing = await loadPolicy();
    if (existing) return { policy: existing, created: false };
    const policy = migratePolicy(preferences);
    await writeValue(KEYS.policy, policy);
    return { policy, created: true };
  }

  async function savePolicy(policy) {
    const next = normalizePolicy({ ...policy, updated_at: new Date().toISOString(),
      preference_revision: (Number(policy && policy.preference_revision) || 0) + 1 });
    await writeValue(KEYS.policy, next);
    return next;
  }

  async function loadPlan() {
    const stored = await readValue(KEYS.plan);
    // Pre-correction Phase 2B plans were dark/unpublished and used unsafe derived
    // IDs. They are not an external compatibility contract; require remapping.
    if (!stored || typeof stored !== 'object' || stored.version !== PLAN_VERSION || stored.identity_version !== 2) return null;
    return stored;
  }

  async function savePlan(plan) {
    if (!plan || plan.identity_version !== 2) throw fail('IDENTITY_CONTINUITY_REQUIRED');
    const record = { ...plan, version: PLAN_VERSION, revision: (Number(plan && plan.revision) || 0) + 1,
      saved_at: new Date().toISOString() };
    await writeValue(KEYS.plan, record);
    return record;
  }

  async function loadAck() {
    const stored = await readValue(KEYS.ack);
    return stored && typeof stored === 'object' && stored.version === ACK_VERSION ? stored : null;
  }

  async function saveAck(ack) {
    const record = { ...ack, version: ACK_VERSION, received_at: new Date().toISOString() };
    await writeValue(KEYS.ack, record);
    return record;
  }

  async function ensureDigestKey() {
    const stored = await readValue(KEYS.digestKey);
    if (stored && typeof stored.value === 'string') {
      const bytes = decodeBase64url(stored.value);
      if (bytes && bytes.length === 32) return bytes;
      throw fail('DIGEST_KEY_INVALID');
    }
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') throw fail('CRYPTO_UNAVAILABLE');
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    await writeValue(KEYS.digestKey, { version: 1, value: encodeBase64url(bytes), created_at: new Date().toISOString() });
    return bytes;
  }

  /* -------------------------------------------------------------- compilation */

  function policyStages(policy, category) {
    const explicit = policy.category_stages && policy.category_stages[category];
    if (Array.isArray(explicit) && explicit.length) return explicit.slice();
    return (policy.default_stages || []).slice();
  }

  function reminderSpecs(obligation, policy) {
    const list = Array.isArray(obligation.reminders) && obligation.reminders.length ? obligation.reminders : null;
    if (list) {
      return list.map(spec => {
        const kind = spec.kind === 'absolute' ? 'absolute' : 'relative';
        if (kind === 'relative') {
          const days = Number(spec.days_before);
          if (!LEAD_DAYS.includes(days)) throw fail('NOTIFICATION_STAGE_INVALID');
          const source = TIME_SOURCES.includes(spec.time_source) ? spec.time_source : 'inherit';
          if (source === 'override' && !validLocalTime(spec.override_local_time)) throw fail('NOTIFICATION_LOCAL_TIME_INVALID');
          return { reminder_id: spec.reminder_id, kind, days_before: days, time_source: source,
            override_local_time: source === 'override' ? spec.override_local_time : null };
        }
        return spec;
      });
    }
    return policyStages(policy, obligation.category).map(days => ({
      kind: 'relative', days_before: days, time_source: 'inherit', override_local_time: null
    }));
  }

  function referenceMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) throw fail('NOTIFICATION_REFERENCE_INVALID');
    return parsed;
  }

  async function compile(input) {
    if (!input || typeof input !== 'object') throw fail('NOTIFICATION_COMPILE_INPUT_INVALID');
    const reference = referenceMs(input.reference);
    const zone = input.timezone;
    if (!validTimezone(zone)) throw fail('NOTIFICATION_TIMEZONE_INVALID');
    const policy = normalizePolicy(input.policy || {});
    const scheduled = typeof input.scheduled === 'function' ? input.scheduled : fallbackScheduled;
    const keyBytes = input.digestKey ? toBytes(input.digestKey) : null;
    if (keyBytes && keyBytes.length !== 32) throw fail('DIGEST_KEY_INVALID');
    const owner = input.owner ? String(input.owner) : null;
    const installation = input.installation ? String(input.installation) : null;
    if (keyBytes && (!owner || !installation)) throw fail('DIGEST_CONTEXT_REQUIRED');

    const horizonEnd = reference + HORIZON_HOURS * 3600e3;
    const referenceDate = isoSeconds(reference).slice(0, 10);
    const maxLead = LEAD_DAYS[0];
    // Two slack days cover the local/UTC date skew at both ends. Anything that
    // still lands outside the horizon is reported instead of discarded.
    const untilKey = shiftDateKey(isoSeconds(horizonEnd).slice(0, 10), maxLead + 2);
    const fromKey = shiftDateKey(referenceDate, -(maxLead + 2));
    const entries = [];
    const outside = [];
    const past = [];
    const issues = [];
    let identityBlocked = false;
    const launched = new Set();

    function verified(obligationId, reminderId, localRef) {
      const mapping = input.identities;
      const occurrence = mapping && mapping.owner === owner && activeOccurrence(mapping, obligationId);
      const source = occurrence && mapping.sources.find(s => s.source_handle === occurrence.source_handle);
      const valid = occurrence && UUID_RE.test(obligationId) && UUID_RE.test(reminderId) &&
        (!localRef || localRef.id == null ||
          (source.source === localRef.source && source.local_id === String(localRef.id))) &&
        occurrence.reminders.some(r => r.reminder_id === reminderId && r.state === 'open');
      if (!valid) { identityBlocked = true; issues.push('IDENTITY_CONTINUITY_REQUIRED'); }
      return valid;
    }

    async function push(candidate) {
      const localDate = candidate.local_date;
      if (!validDateKey(localDate)) { issues.push('A reminder date could not be derived safely.'); return; }
      const resolved = resolveWall(localDate, candidate.local_time, candidate.timezone);
      if (!resolved.ok) {
        issues.push(candidate.time_basis === 'wall'
          ? 'A reminder falls in a nonexistent local time and was not scheduled.'
          : 'A custom reminder time does not exist in its timezone and was not scheduled.');
        return;
      }
      const sendAfter = candidate.send_after != null ? candidate.send_after : resolved.ms;
      if (!Number.isFinite(sendAfter)) { issues.push('A reminder instant could not be resolved.'); return; }
      const expires = expiryFor(localDate, sendAfter, candidate.timezone);
      if (sendAfter > horizonEnd) {
        outside.push({ obligation_id: candidate.obligation_id, reminder_id: candidate.reminder_id,
          send_after: isoSeconds(sendAfter), reason: 'NOTIFICATION_OUTSIDE_HORIZON' });
        return;
      }
      if (sendAfter <= reference) {
        past.push({ obligation_id: candidate.obligation_id, reminder_id: candidate.reminder_id,
          send_after: isoSeconds(sendAfter), reason: 'NOTIFICATION_INSTANT_PAST' });
        return;
      }
      const entry = {
        time_basis: candidate.time_basis,
        eligible_local_date: localDate,
        local_time: candidate.local_time,
        timezone: candidate.timezone,
        send_after: isoSeconds(sendAfter),
        expires_at: isoSeconds(expires),
        candidate_digest: null,
        obligation_digest: null,
        // Local-only context. Never part of a publication payload.
        obligation_id: candidate.obligation_id,
        reminder_id: candidate.reminder_id,
        kind: candidate.kind,
        days_before: candidate.days_before,
        time_source: candidate.time_source,
        local_ref: candidate.local_ref || null
      };
      if (keyBytes) {
        entry.obligation_digest = await obligationDigest(keyBytes, owner, installation, candidate.obligation_id);
        entry.candidate_digest = await candidateDigest(keyBytes, owner, installation, candidate.obligation_id, candidate.reminder_id);
      }
      const identityKey = entry.obligation_id + '\u0000' + entry.reminder_id;
      if (launched.has(identityKey)) {
        identityBlocked = true; issues.push('IDENTITY_CONTINUITY_REQUIRED');
        return;
      }
      launched.add(identityKey);
      entries.push(entry);
    }

    for (const obligation of input.obligations || []) {
      if (!obligation || !Array.isArray(obligation.occurrences)) {
        identityBlocked = true; issues.push('IDENTITY_CONTINUITY_REQUIRED'); continue;
      }
      const source = String(obligation.source || 'bill');
      const category = CATEGORIES.includes(obligation.category) ? obligation.category : 'bills';
      const localRef = { source, id: String(obligation.id) };
      // Projection dates select scheduling instructions only. They never create
      // or select a stable identity. A reconciler must explicitly map each cycle
      // first; missing/ambiguous continuity blocks the entire snapshot.
      const projected = projectDates(obligation, untilKey, scheduled, fromKey);
      if (projected.some(date => !obligation.occurrences.some(o => o.due_date === date))) {
        identityBlocked = true; issues.push('IDENTITY_CONTINUITY_REQUIRED');
      }
      for (const occurrence of obligation.occurrences) {
        const dueDate = occurrence.due_date, obligationId = occurrence.obligation_id;
        const specs = reminderSpecs({ ...obligation, ...occurrence, category }, policy);
        for (const spec of specs) {
          if (spec.kind !== 'relative') continue;
          const reminderId = spec.reminder_id;
          if (!verified(obligationId, reminderId, obligation.id == null ? null : localRef)) continue;
          const localDate = shiftDateKey(dueDate, -spec.days_before);
          const time = spec.time_source === 'override' ? spec.override_local_time : policy.default_local_time;
          await push({ obligation_id: obligationId, reminder_id: reminderId, kind: 'relative',
            days_before: spec.days_before, time_source: spec.time_source, time_basis: 'wall',
            local_date: localDate, local_time: time, timezone: zone, local_ref: localRef });
        }
      }
    }

    for (const absolute of input.absolute || []) {
      if (!absolute) { identityBlocked = true; issues.push('IDENTITY_CONTINUITY_REQUIRED'); continue; }
      const source = String(absolute.source || 'bill');
      const obligationId = absolute.obligation_id, reminderId = absolute.reminder_id;
      const localRef = { source, id: String(absolute.id) };
      if (!verified(obligationId, reminderId, absolute.id == null ? null : localRef)) continue;
      await push({ obligation_id: obligationId, reminder_id: reminderId, kind: 'absolute',
        days_before: null, time_source: 'override', time_basis: 'absolute',
        local_date: absolute.local_date, local_time: absolute.local_time,
        timezone: absolute.timezone, send_after: absolute.send_after != null ? Date.parse(absolute.send_after) : null,
        local_ref: localRef });
    }

    // Exact collision policy: same obligation + same resolved UTC minute.
    // A custom absolute reminder wins over a relative one. Remaining ties use a
    // total order (local time, then reminder id) so the outcome never depends on
    // input ordering. Exactly one entry survives and the loser is reported.
    const byMinute = new Map();
    const kept = [];
    const collisions = [];
    const rank = entry => (entry.kind === 'absolute' ? '0' : '1') +
      '|' + String(entry.local_time) + '|' + String(entry.reminder_id);
    for (const entry of entries) {
      const minute = entry.send_after.slice(0, 16);
      const bucketKey = entry.obligation_id + '|' + minute;
      const prior = byMinute.get(bucketKey);
      if (!prior) { byMinute.set(bucketKey, entry); kept.push(entry); continue; }
      const loser = rank(entry) < rank(prior) ? prior : entry;
      const winner = loser === entry ? prior : entry;
      const index = kept.indexOf(loser);
      if (index >= 0) kept.splice(index, 1);
      if (winner !== prior) kept.push(winner);
      byMinute.set(bucketKey, winner);
      collisions.push({ obligation_id: winner.obligation_id, minute,
        winner: winner.reminder_id, loser: loser.reminder_id, loser_kind: loser.kind,
        reason: 'NOTIFICATION_COLLISION_COLLAPSED' });
    }

    kept.sort((a, b) => a.send_after.localeCompare(b.send_after) ||
      a.obligation_id.localeCompare(b.obligation_id) || a.reminder_id.localeCompare(b.reminder_id));
    if (kept.length > MAX_ENTRIES) issues.push('The compiled schedule exceeds the publication capacity.');

    return {
      version: VERSION,
      identity_version: 2,
      protocol: PROTOCOL,
      engine_identity: ENGINE_IDENTITY,
      digest_version: DIGEST_VERSION,
      reference: isoSeconds(reference),
      timezone: zone,
      default_local_time: policy.default_local_time,
      preference_revision: policy.preference_revision,
      sealed: !!keyBytes,
      identity_blocked: identityBlocked,
      entries: identityBlocked ? [] : kept,
      outside,
      past,
      collisions,
      issues: [...new Set(issues)]
    };
  }

  return Object.freeze({
    VERSION, POLICY_VERSION, PLAN_VERSION, ACK_VERSION,
    PROTOCOL, ENGINE_IDENTITY, DIGEST_VERSION, DEFAULT_LOCAL_TIME,
    LEAD_DAYS, HORIZON_HOURS, MAX_DELIVERY_HOURS, MAX_ENTRIES, MAX_PAYLOAD_BYTES,
    TIME_BASES, TIME_SOURCES, CATEGORIES, REMOTE_FIELDS, STATES,
    DB_NAME, DB_VERSION, STORE, KEYS, DOMAIN,
    validDateKey, shiftDateKey, validLocalTime, validTimezone,
    resolveWall, resolveCeiling, expiryFor, isoSeconds,
    fallbackScheduled, projectDates,
    emptyMapping, updateMapping, mutateIdentities, loadIdentities,
    candidateDigest, obligationDigest, digestMessage,
    remoteEntry, payload,
    normalizePolicy, migratePolicy, ensurePolicy, savePolicy, loadPolicy,
    loadPlan, savePlan, loadAck, saveAck, ensureDigestKey,
    compile
  });
});
