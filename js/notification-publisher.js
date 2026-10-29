/* Phase 2B: client publisher for the sealed Scheduling V2 contract.
   Orchestrates only. It never derives financial truth, never reads financial
   tables remotely, never invokes the Edge sender, never creates a
   PushSubscription and never displays an OS notification.

   DARK BY DEFAULT. The shipped singleton is hard-disabled and refuses before
   making any RPC call. Tests construct an explicitly activated instance with an
   injected RPC adapter; there is no production path that enables publication in
   Phase 2B. Nothing here runs at startup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./notification-schedule.js'));
  else root.CapNotificationPublisher = factory(root.CapNotificationSchedule, root);
})(typeof window === 'undefined' ? globalThis : window, function (schedule, root) {
  'use strict';

  const PHASE = 'PHASE_2B_DARK';
  const TEST_ACTIVATION = 'isolated-test';
  const STATES = schedule.STATES;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const BUSY_STATES = ['queued', 'retry_wait'];
  const DONE_STATES = ['accepted'];
  const UNCERTAIN_STATES = ['dispatch_started', 'unknown'];
  const STOPPED_STATES = ['retired', 'suppressed'];
  const fail = reason => Object.assign(Error(reason), { code: reason });

  /* --------------------------------------------------------------- derivation */

  function indexOccurrences(ack) {
    const map = new Map();
    for (const row of (ack && Array.isArray(ack.occurrences) ? ack.occurrences : [])) {
      if (row && typeof row.candidate_digest === 'string') map.set(row.candidate_digest, row);
    }
    return map;
  }

  function unchanged(entry, remote) {
    if (!remote) return false;
    for (const field of ['send_after', 'expires_at', 'time_basis', 'timezone',
      'eligible_local_date', 'local_time']) {
      if (String(remote[field]) !== String(entry[field])) return false;
    }
    return true;
  }

  function deliveryState(value) {
    if (DONE_STATES.includes(value)) return STATES.SENT;
    if (UNCERTAIN_STATES.includes(value)) return STATES.DELIVERY_UNCERTAIN;
    if (STOPPED_STATES.includes(value)) return STATES.EXPIRED;
    if (BUSY_STATES.includes(value) || value === undefined) return STATES.SCHEDULED;
    return STATES.DELIVERY_UNCERTAIN;
  }

  /* Truthful, UI-ready state derivation. SCHEDULED requires an authoritative
     acknowledgment of the exact occurrence, time, revision and generation. */
  function deriveStates(input) {
    const plan = input && input.plan ? input.plan : null;
    const ack = input && input.ack ? input.ack : null;
    const binding = input && input.binding ? input.binding : null;
    const current = Number.isFinite(input && input.now) ? input.now : Date.now();
    const rows = [];
    if (!plan || !Array.isArray(plan.entries)) return { states: rows, counts: {}, pending: null };
    if (plan.identity_version !== 2 || plan.identity_blocked) {
      return { states: [{ state: STATES.ACTION_REQUIRED, reason: 'IDENTITY_CONTINUITY_REQUIRED' }],
        counts: { ACTION_REQUIRED: 1 }, pending: STATES.ACTION_REQUIRED };
    }

    const acked = indexOccurrences(ack);
    const bound = !!(binding && UUID_RE.test(String(binding.binding_id || '')) &&
      Number.isSafeInteger(binding.generation) && binding.generation >= 1);
    const acknowledged = !!(bound && ack && ack.binding_id === binding.binding_id &&
      Number(ack.generation) === Number(binding.generation));
    const seen = new Set();

    for (const entry of plan.entries) {
      seen.add(entry.candidate_digest);
      let state;
      let reason = null;
      const remote = acknowledged ? acked.get(entry.candidate_digest) : null;
      if (remote && [...DONE_STATES, ...UNCERTAIN_STATES, ...STOPPED_STATES].includes(remote.delivery_state)) {
        // A timing edit cannot revive a terminal candidate or erase an uncertain
        // dispatch receipt. Stable digests keep these fences across all edits.
        state = deliveryState(remote.delivery_state);
      } else if (Date.parse(entry.send_after) <= current) {
        state = STATES.EXPIRED;
        reason = 'OCCURRENCE_INSTANT_PASSED';
      } else if (!bound) {
        state = STATES.SAVED_LOCAL;
        reason = 'NO_ACTIVE_BINDING';
      } else if (!acknowledged) {
        state = STATES.PENDING_SYNC;
        reason = 'NO_REMOTE_ACKNOWLEDGMENT';
      } else {
        if (unchanged(entry, remote)) state = deliveryState(remote.delivery_state);
        else { state = STATES.CHANGE_PENDING; reason = 'REMOTE_SCHEDULE_DIFFERS'; }
      }
      rows.push({ candidate_digest: entry.candidate_digest, obligation_id: entry.obligation_id,
        reminder_id: entry.reminder_id, send_after: entry.send_after, state, reason });
    }

    if (acknowledged) {
      for (const [digest, remote] of acked) {
        if (seen.has(digest)) continue;
        rows.push({ candidate_digest: digest, obligation_id: remote.obligation_digest || null,
          reminder_id: null, send_after: remote.send_after, state: STATES.CANCELLATION_PENDING,
          reason: 'REMOTE_OCCURRENCE_NOT_IN_LOCAL_PLAN' });
      }
    }

    for (const outside of (Array.isArray(plan.outside) ? plan.outside : [])) {
      rows.push({ candidate_digest: null, obligation_id: outside.obligation_id,
        reminder_id: outside.reminder_id, send_after: outside.send_after,
        state: STATES.OUTSIDE_RANGE, reason: outside.reason || 'NOTIFICATION_OUTSIDE_HORIZON' });
    }

    const counts = {};
    for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
    let pending = null;
    for (const state of [STATES.ACTION_REQUIRED, STATES.CHANGE_PENDING, STATES.CANCELLATION_PENDING,
      STATES.PENDING_SYNC, STATES.SAVED_LOCAL]) {
      if (counts[state]) { pending = state; break; }
    }
    return { states: rows, counts, pending };
  }

  function publicationPayload(plan) {
    if (!plan || plan.identity_version !== 2 || plan.identity_blocked) throw fail('IDENTITY_CONTINUITY_REQUIRED');
    return schedule.payload(plan && plan.entries ? plan.entries : []);
  }

  /* ---------------------------------------------------------------- publisher */

  function createPublisher(config) {
    const options = config && typeof config === 'object' ? config : {};
    const enabled = options.activation === TEST_ACTIVATION;
    const rpc = options.rpc || null;
    const clock = typeof options.now === 'function' ? options.now : () => Date.now();
    const isOnline = typeof options.online === 'function' ? options.online : () => true;
    const session = typeof options.identity === 'function'
      ? options.identity
      : () => (typeof root !== 'undefined' && root && root.CapSupabase && typeof root.CapSupabase.authEvidence === 'function'
        ? root.CapSupabase.authEvidence() : { authenticated: false, userId: null });
    const activation = Object.freeze(enabled
      ? { phase: 'ISOLATED_TEST', enabled: true, reason: null }
      : { phase: PHASE, enabled: false, reason: 'PUBLICATION_NOT_ACTIVATED' });

    function status() {
      return { activation, protocol: schedule.PROTOCOL, dark: !enabled,
        returns: Object.keys(STATES).map(k => STATES[k]) };
    }

    function guard() {
      if (!enabled) throw fail('PUBLICATION_DISABLED');
      if (!rpc || typeof rpc.notificationReadinessV2 !== 'function' ||
          typeof rpc.notificationPublishV2 !== 'function' ||
          typeof rpc.notificationReadbackV2 !== 'function') throw fail('PUBLICATION_ADAPTER_UNAVAILABLE');
    }

    function validBinding(binding) {
      return !!(binding && UUID_RE.test(String(binding.binding_id || '')) &&
        Number.isSafeInteger(binding.generation) && binding.generation >= 1);
    }

    function classify(error) {
      const code = String((error && (error.code || error.message)) || 'UNKNOWN');
      if (code.includes('NOTIFICATION_STALE_REVISION')) return { state: STATES.CHANGE_PENDING, reason: 'REVISION_STALE' };
      if (code.includes('NOTIFICATION_STALE_BINDING')) return { state: STATES.ACTION_REQUIRED, reason: 'GENERATION_MISMATCH' };
      if (code.includes('NOTIFICATION_PUBLICATION_BUSY')) return { state: STATES.ACTION_REQUIRED, reason: 'PUBLICATION_BUSY' };
      if (code.includes('NOTIFICATION_LEDGER_FULL')) return { state: STATES.ACTION_REQUIRED, reason: 'CAPACITY_REJECTED' };
      if (code.includes('NOTIFICATION_ENTRIES_INVALID')) return { state: STATES.ACTION_REQUIRED, reason: 'CAPACITY_REJECTED' };
      if (code.includes('NOTIFICATION_PROTOCOL_UNSUPPORTED') || code.includes('NOTIFICATION_CONTRACT_NOT_READY') ||
          code.includes('NOTIFICATION_CONTRACT_NOT_VERIFIED')) return { state: STATES.ACTION_REQUIRED, reason: 'CONTRACT_INCOMPATIBLE' };
      if (code.includes('NOTIFICATION_TIMEZONE_MISMATCH') || code.includes('NOTIFICATION_TIMEZONE_INVALID')) {
        return { state: STATES.ACTION_REQUIRED, reason: 'TIMEZONE_MISMATCH' };
      }
      if (code.includes('NOTIFICATION_EXPECTED_UTC_MISMATCH')) return { state: STATES.ACTION_REQUIRED, reason: 'EXPECTED_UTC_MISMATCH' };
      if (code.includes('NOTIFICATION_ENTRY_WINDOW_INVALID')) return { state: STATES.ACTION_REQUIRED, reason: 'WINDOW_REJECTED' };
      if (code.includes('NOTIFICATION_DUPLICATE')) return { state: STATES.ACTION_REQUIRED, reason: 'DUPLICATE_REJECTED' };
      if (code.includes('NOTIFICATION_SUBSCRIPTION_TOO_SHORT')) return { state: STATES.ACTION_REQUIRED, reason: 'SUBSCRIPTION_TOO_SHORT' };
      return { state: STATES.DELIVERY_UNCERTAIN, reason: 'UNCERTAIN_OUTCOME' };
    }

    async function readiness() {
      if (!enabled) return { ok: false, reason: 'PUBLICATION_DISABLED', calls: 0 };
      try {
        const result = await rpc.notificationReadinessV2();
        return result && result.ok === true
          ? { ok: true, reason: null, raw: result.raw, calls: 1 }
          : { ok: false, reason: 'CONTRACT_INCOMPATIBLE', calls: 1 };
      } catch (error) {
        return { ok: false, reason: String(error && (error.code || error.message) || 'READINESS_FAILED'), calls: 1 };
      }
    }

    async function readback(binding) {
      const raw = await rpc.notificationReadbackV2({ bindingId: binding.binding_id, generation: binding.generation });
      if (!raw || raw.binding_id !== binding.binding_id || Number(raw.generation) !== Number(binding.generation)) {
        throw fail('NOTIFICATION_READBACK_INVALID');
      }
      return raw;
    }

    // Exact authoritative comparison: the acknowledged revision must be the
    // requested revision and every digest must be present at the same instant.
    function acknowledged(raw, plan, expectedRevision) {
      if (!raw || Number(raw.schedule_revision) !== Number(expectedRevision) + 1) return false;
      const map = indexOccurrences(raw);
      if (map.size !== plan.entries.length) return false;
      for (const entry of plan.entries) {
        const remote = map.get(entry.candidate_digest);
        if (!unchanged(entry, remote)) return false;
      }
      return true;
    }

    // Publish one complete snapshot. Bounded: at most two publish attempts and
    // one readback probe per attempt. An uncertain outcome is never guessed.
    async function publish(plan, context) {
      const ctx = context && typeof context === 'object' ? context : {};
      if (!enabled) return { ok: false, state: STATES.SAVED_LOCAL, reason: 'PUBLICATION_DISABLED', calls: 0 };
      let calls = 0;
      try { guard(); }
      catch (error) { return { ok: false, state: STATES.ACTION_REQUIRED, reason: error.code, calls }; }

      const identity = session();
      if (!identity || identity.authenticated !== true || !identity.userId) {
        return { ok: false, state: STATES.PENDING_SYNC, reason: 'SESSION_UNVERIFIED', calls };
      }
      if (identity.diverged === true) {
        return { ok: false, state: STATES.ACTION_REQUIRED, reason: 'SESSION_DIVERGED', calls };
      }
      if (!isOnline()) return { ok: false, state: STATES.PENDING_SYNC, reason: 'OFFLINE', calls };
      const binding = ctx.binding;
      if (!validBinding(binding)) return { ok: false, state: STATES.SAVED_LOCAL, reason: 'NO_ACTIVE_BINDING', calls };

      let entries;
      try { entries = publicationPayload(plan); }
      catch (error) {
        const reason = error.code === 'NOTIFICATION_ENTRIES_INVALID' ? 'CAPACITY_REJECTED' : error.code;
        return { ok: false, state: STATES.ACTION_REQUIRED, reason, calls };
      }
      if (!entries.length) return { ok: false, state: STATES.SAVED_LOCAL, reason: 'NOTHING_TO_PUBLISH', calls };
      if (entries.length > schedule.MAX_ENTRIES) {
        return { ok: false, state: STATES.ACTION_REQUIRED, reason: 'CAPACITY_REJECTED', calls };
      }

      calls++;
      const ready = await readiness();
      if (!ready.ok) return { ok: false, state: STATES.ACTION_REQUIRED, reason: ready.reason, calls };

      const expectedRevision = Number(ctx.ack && Number.isSafeInteger(ctx.ack.schedule_revision)
        ? ctx.ack.schedule_revision : 0);
      const timezone = plan && plan.timezone;
      if (!schedule.validTimezone(timezone)) {
        return { ok: false, state: STATES.ACTION_REQUIRED, reason: 'TIMEZONE_INVALID', calls };
      }
      const preferenceRevision = Number.isSafeInteger(plan.preference_revision) ? plan.preference_revision : 1;
      let lastAck = null;
      let attempts = 0;

      while (attempts < 2) {
        attempts++;
        calls++;
        try {
          const ack = await rpc.notificationPublishV2({
            bindingId: binding.binding_id,
            generation: binding.generation,
            expectedRevision,
            preferenceRevision,
            timezone,
            entries
          });
          lastAck = ack;
          return { ok: true, state: STATES.SCHEDULED, reason: null, ack, attempts, calls };
        } catch (error) {
          const verdict = classify(error);
          if (verdict.state !== STATES.DELIVERY_UNCERTAIN) {
            return { ok: false, state: verdict.state, reason: verdict.reason, code: String(error && (error.code || error.message)), calls };
          }
          // Uncertain transport/server outcome: ask the server what it stored.
          let raw = null;
          calls++;
          try { raw = await readback(binding); }
          catch (_) { return { ok: false, state: STATES.DELIVERY_UNCERTAIN, reason: 'READBACK_UNAVAILABLE', calls }; }
          if (acknowledged(raw, plan, expectedRevision)) {
            return { ok: true, state: STATES.SCHEDULED, reason: null, ack: raw, attempts, recovered: true, calls };
          }
          const unchangedServer = Number(raw.schedule_revision) === expectedRevision;
          if (!unchangedServer) {
            return { ok: false, state: STATES.CHANGE_PENDING, reason: 'READBACK_CONFLICT', ack: raw, calls };
          }
          // Server provably did not apply this request: one bounded retry only.
          if (attempts >= 2) {
            return { ok: false, state: STATES.PENDING_SYNC, reason: 'RETRY_EXHAUSTED', ack: raw, calls };
          }
        }
      }
      return { ok: false, state: STATES.PENDING_SYNC, reason: 'RETRY_EXHAUSTED', ack: lastAck, calls };
    }

    // Read-only reconciliation. Never publishes, never invents acknowledgment.
    async function reconcile(plan, context) {
      const ctx = context && typeof context === 'object' ? context : {};
      if (!plan || plan.identity_version !== 2 || plan.identity_blocked) return { ok: false, state: STATES.ACTION_REQUIRED,
        reason: 'IDENTITY_CONTINUITY_REQUIRED', calls: 0 };
      if (!enabled) {
        return { ok: false, reason: 'PUBLICATION_DISABLED', calls: 0,
          ...deriveStates({ plan, ack: ctx.ack, binding: ctx.binding, now: clock() }) };
      }
      if (!validBinding(ctx.binding)) {
        return { ok: false, reason: 'NO_ACTIVE_BINDING', calls: 0,
          ...deriveStates({ plan, ack: ctx.ack, binding: null, now: clock() }) };
      }
      try {
        const raw = await readback(ctx.binding);
        return { ok: true, reason: null, calls: 1, ack: raw,
          ...deriveStates({ plan, ack: raw, binding: ctx.binding, now: clock() }) };
      } catch (error) {
        return { ok: false, reason: String(error && (error.code || error.message) || 'READBACK_FAILED'), calls: 1,
          ...deriveStates({ plan, ack: ctx.ack, binding: ctx.binding, now: clock() }) };
      }
    }

    function states(plan, context) {
      const ctx = context && typeof context === 'object' ? context : {};
      return deriveStates({ plan, ack: ctx.ack, binding: ctx.binding, now: clock() });
    }

    return Object.freeze({
      PHASE, activation, status, states, deriveStates, publicationPayload,
      readiness, publish, reconcile, enabled: () => enabled
    });
  }

  const api = { PHASE, TEST_ACTIVATION, STATES, createPublisher, deriveStates, publicationPayload,
    STATUSES: Object.freeze(Object.values(STATES)) };
  // Shipped browser singleton: permanently dark in Phase 2B. It performs no RPC
  // and schedules nothing at startup.
  if (root && typeof root === 'object' && !(typeof module === 'object' && module.exports)) {
    api.singleton = createPublisher({ schedule, activation: PHASE, rpc: {
      notificationReadinessV2: () => root.CapProductionRpc.notificationReadinessV2(),
      notificationPublishV2: options => root.CapProductionRpc.notificationPublishV2(options),
      notificationReadbackV2: options => root.CapProductionRpc.notificationReadbackV2(options)
    } });
  }
  return Object.freeze(api);
});
