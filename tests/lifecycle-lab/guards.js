/* Defense in depth. Isolation is provided by the dedicated allowlisted server. */
(function () {
  'use strict';
  const denied = [];
  const nativeStorageSet = globalThis.Storage?.prototype.setItem;
  const block = name => function () { denied.push(name); throw Error('LAB_FORBIDDEN:' + name); };
  function seal(object, key, value) {
    if (!object) return;
    Object.defineProperty(object, key, { value, writable: false, configurable: false });
  }
  if (globalThis.PushManager) seal(PushManager.prototype, 'subscribe', block('subscription'));
  if (globalThis.ServiceWorkerRegistration) seal(ServiceWorkerRegistration.prototype, 'showNotification', block('presentation'));
  if (globalThis.Notification) {
    seal(Notification, 'requestPermission', block('permission'));
    const original = Notification;
    seal(globalThis, 'Notification', new Proxy(original, { construct: block('notification-constructor'), apply: block('notification-call') }));
  }
  if (globalThis.IDBFactory) {
    seal(IDBFactory.prototype, 'open', block('indexeddb-open'));
    seal(IDBFactory.prototype, 'deleteDatabase', block('indexeddb-delete'));
  }
  if (globalThis.Storage) {
    for (const key of ['setItem', 'removeItem', 'clear']) seal(Storage.prototype, key, block('storage-' + key));
  }
  if (globalThis.CacheStorage) {
    for (const key of ['open', 'delete']) seal(CacheStorage.prototype, key, block('cache-' + key));
  }
  Object.defineProperty(globalThis, 'LifecycleSafety', { value: Object.freeze({
    promotionAllowed: false, storage: 'lab-provenance-only/2', report: () => [...denied],
    initializeMarkers(policy) {
      if (!globalThis.document || !nativeStorageSet || !globalThis.LifecycleIsolation) throw Error('LAB_MARKER_CONTEXT_STOP');
      LifecycleIsolation.validatePolicy(policy, location.origin);
      // The only retained write capability accepts exact protocol keys and server-issued values.
      // Generic Storage mutation stays sealed; never overwrite a mismatched marker.
      const targets = ['local', 'session'].map(area => ({
        storage: area === 'local' ? globalThis.localStorage : globalThis.sessionStorage, marker: policy.markers[area]
      }));
      for (const { storage, marker } of targets) {
        const existing = storage.getItem(marker.key);
        for (let i = 0; i < storage.length; i++) if (storage.key(i) !== marker.key) throw Error('UNKNOWN_STORAGE_STOP');
        if (existing !== null && existing !== marker.value) throw Error('LAB_MARKER_PROVENANCE_STOP');
      }
      for (const { storage, marker } of targets) if (storage.getItem(marker.key) === null) nativeStorageSet.call(storage, marker.key, marker.value);
    }
  }) });
})();
