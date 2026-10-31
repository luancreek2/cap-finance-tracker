/* Pure, explicit lab-state admission. Names alone never establish provenance. */
(function (root) {
  'use strict';
  const PROTOCOL = 'cap-lifecycle-isolation/2';
  const KEYS = Object.freeze({ local: 'cap-lifecycle-lab:local:v2', session: 'cap-lifecycle-lab:session:v2' });
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
  function validatePolicy(policy, origin) {
    if (!policy || policy.protocol !== PROTOCOL || policy.origin !== origin || !uuid(policy.run) || !Array.isArray(policy.workers)) throw Error('LAB_PROVENANCE_STOP');
    for (const area of ['local', 'session']) {
      const marker = policy.markers?.[area];
      if (!marker || marker.key !== KEYS[area] || typeof marker.value !== 'string') throw Error('LAB_PROVENANCE_STOP');
      let value; try { value = JSON.parse(marker.value); } catch (_) { throw Error('LAB_PROVENANCE_STOP'); }
      if (!value || Object.keys(value).sort().join(',') !== 'area,origin,protocol,run,token' ||
          value.protocol !== PROTOCOL || value.origin !== origin || value.run !== policy.run || value.area !== area || !uuid(value.token)) throw Error('LAB_PROVENANCE_STOP');
    }
  }
  function validateInventory(inventory, policy, origin) {
    validatePolicy(policy, origin);
    const failures = [];
    for (const area of ['local', 'session']) {
      const expected = policy.markers[area];
      for (const entry of inventory[area]) {
        if (entry.key !== expected.key) failures.push('UNKNOWN_' + area.toUpperCase() + '_STORAGE_STOP');
        else if (entry.value !== expected.value) failures.push('LAB_MARKER_PROVENANCE_STOP');
      }
    }
    // This protocol creates no CacheStorage or IndexedDB records. None are expected.
    if (inventory.caches.length) failures.push('UNKNOWN_CACHE_STOP');
    if (!inventory.databaseInventoryAvailable) failures.push('DATABASE_INVENTORY_UNAVAILABLE_STOP');
    if (inventory.databases.length) failures.push('UNKNOWN_DATABASE_STOP');
    if (failures.length) throw Error([...new Set(failures)].join(','));
    return { protocol: PROTOCOL, expectedMarkers: inventory.local.length + inventory.session.length, promotionAllowed: false };
  }
  function validateWorker(url, proof, nonce, policy, origin) {
    validatePolicy(policy, origin);
    const parsed = new URL(url);
    if (parsed.origin !== origin || parsed.pathname !== '/lab/service-worker.js' ||
        !proof || proof.type !== 'LAB_ISOLATION_RESPONSE' || proof.protocol !== PROTOCOL || proof.nonce !== nonce ||
        proof.run !== policy.run || proof.url !== url || proof.promotionAllowed !== false ||
        !policy.workers.some(w => w.url === url && w.revision === proof.revision && w.proof === proof.proof)) throw Error('WORKER_PROVENANCE_STOP');
  }
  const api = Object.freeze({ PROTOCOL, KEYS, validatePolicy, validateInventory, validateWorker });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.defineProperty(root, 'LifecycleIsolation', { value: api });
})(globalThis);
