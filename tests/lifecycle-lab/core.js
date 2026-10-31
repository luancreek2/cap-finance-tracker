/* Pure diagnostic protocol. No browser state, enrollment, or delivery authority. */
(function (root) {
  'use strict';
  const CAPABILITIES = Object.freeze([
    'cap.notify.atomic-fence/1', 'cap.notify.disable-first/1',
    'cap.notify.shared-lock/1', 'cap.notify.revocation-epoch/1',
    'cap.notify.activation-instance/1', 'cap.notify.no-auto-promotion/1',
    'cap.notify.stale-response-rejection/1'
  ]);
  const ECHO = ['worker_instance_id', 'activation_id', 'barrier_id', 'challenge_nonce', 'epoch', 'intent_id'];
  const FIELDS = ['type', 'protocol', ...ECHO, 'client_contract', 'capabilities', 'status'];
  const exact = (value, fields) => !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
  function response(challenge) {
    return { type: 'CAP_NOTIFICATION_COMPAT_RESPONSE', protocol: 1,
      ...Object.fromEntries(ECHO.map(k => [k, challenge[k]])),
      client_contract: 'diagnostic-fixture-only/1', capabilities: [...CAPABILITIES], status: 'compatible' };
  }
  class Attempt {
    constructor(challenge, clients, start) {
      this.challenge = challenge;
      this.clients = new Map(clients.map(c => [c.id, c.url]));
      this.start = start;
      this.results = new Map();
      this.failures = [];
    }
    receive(id, value, monotonicNow) {
      if (!this.clients.has(id)) { this.failures.push('unknown-client'); return; }
      if (this.results.has(id)) { this.failures.push('duplicate:' + id); return; }
      let result = 'compatible';
      if (monotonicNow < this.start || monotonicNow - this.start > 2000) result = 'late';
      else if (!exact(value, FIELDS) || value.type !== 'CAP_NOTIFICATION_COMPAT_RESPONSE' || value.protocol !== 1) result = 'malformed';
      else if (ECHO.some(k => value[k] !== this.challenge[k])) result = 'identity-mismatch';
      else if (value.client_contract !== 'diagnostic-fixture-only/1' || value.status !== 'compatible') result = 'incompatible';
      else if (!Array.isArray(value.capabilities) || value.capabilities.length !== CAPABILITIES.length ||
        new Set(value.capabilities).size !== CAPABILITIES.length || CAPABILITIES.some(c => !value.capabilities.includes(c))) result = 'missing-capability';
      this.results.set(id, result);
    }
    finish(clients, monotonicNow) {
      const failures = [...this.failures];
      if (monotonicNow < this.start || monotonicNow - this.start > 5000) failures.push('attempt-deadline');
      const final = new Map(clients.map(c => [c.id, c.url]));
      if (!this.clients.size) failures.push('empty-census');
      for (const [id, url] of this.clients) {
        if (final.get(id) !== url) failures.push('disappeared-or-navigated:' + id);
        if (this.results.get(id) !== 'compatible') failures.push((this.results.get(id) || 'timeout') + ':' + id);
      }
      for (const id of final.keys()) if (!this.clients.has(id)) failures.push('new-client:' + id);
      return { diagnosticCompatibility: failures.length === 0, failures,
        responses: [...this.results].map(([client_id, result]) => ({ client_id, result })),
        promotionAllowed: false, lifecycleInvariantEstablished: false };
    }
  }
  const api = Object.freeze({ CAPABILITIES, response, Attempt });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.defineProperty(root, 'LifecycleProtocol', { value: api });
})(globalThis);
