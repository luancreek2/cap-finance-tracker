/* Phase 5B.2B: public VAPID configuration boundary.
   DARK SHIPMENT — this module intentionally carries no version, no public key,
   no fingerprint and no createdAt. With an absent config the background
   enrollment UI stays hidden/inert and no permission or PushManager call can be
   made. Provisioning a later phase supplies the reviewed public shape:
     { version, publicKey, fingerprint, createdAt }
   The VAPID private key is never part of this file, the shell, IndexedDB,
   localStorage, logs, tests or any client configuration. Only the public key
   and its SHA-256 fingerprint belong here. */
(function () {
  'use strict';
  const VERSION_RE = /^v[1-9][0-9]{0,2}$/;
  const HEX_RE = /^[0-9a-f]{64}$/;
  const B64URL_RE = /^[A-Za-z0-9_-]+$/;
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // Dark, unconfigured public identity. Do not add placeholder keys here.
  const DARK = Object.freeze({});

  function decodeBase64url(value) {
    if (typeof value !== 'string' || !value || !B64URL_RE.test(value) || value.length % 4 === 1) return null;
    const out = [];
    let buffer = 0, bits = 0;
    for (const ch of value) {
      buffer = (buffer << 6) | ALPHABET.indexOf(ch);
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 255); }
    }
    return out.length ? Uint8Array.from(out) : null;
  }
  function toHex(bytes) {
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
  }
  function encodeBase64url(bytes) {
    if (!bytes || typeof bytes.length !== 'number') return null;
    let out = '', buffer = 0, bits = 0;
    for (const b of bytes) {
      buffer = (buffer << 8) | (b & 255);
      bits += 8;
      while (bits >= 6) { bits -= 6; out += ALPHABET[(buffer >> bits) & 63]; }
    }
    if (bits > 0) out += ALPHABET[(buffer << (6 - bits)) & 63];
    return out;
  }
  // Read the live public configuration. The shipped default is empty; an
  // injected CAP_VAPID_PUBLIC is public data only and can never carry a secret.
  function current() {
    const injected = typeof window !== 'undefined' ? window.CAP_VAPID_PUBLIC : null;
    return injected && typeof injected === 'object' && !Array.isArray(injected) ? injected : DARK;
  }
  function inspect(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { ok: false, reason: 'VAPID_CONFIG_ABSENT', dark: true };
    }
    const keys = Object.keys(config);
    if (!keys.length) return { ok: false, reason: 'VAPID_CONFIG_ABSENT', dark: true };
    if (keys.some(k => !['version', 'publicKey', 'fingerprint', 'createdAt'].includes(k))) {
      return { ok: false, reason: 'VAPID_CONFIG_UNKNOWN_FIELD' };
    }
    if (typeof config.version !== 'string' || !VERSION_RE.test(config.version)) {
      return { ok: false, reason: 'VAPID_VERSION_INVALID' };
    }
    if (typeof config.publicKey !== 'string' || !B64URL_RE.test(config.publicKey) ||
        config.publicKey.includes('=')) {
      return { ok: false, reason: 'VAPID_PUBLIC_KEY_INVALID' };
    }
    const keyBytes = decodeBase64url(config.publicKey);
    if (!keyBytes || keyBytes.length !== 65 || keyBytes[0] !== 4) {
      return { ok: false, reason: 'VAPID_PUBLIC_KEY_INVALID' };
    }
    if (typeof config.fingerprint !== 'string' || !HEX_RE.test(config.fingerprint)) {
      return { ok: false, reason: 'VAPID_FINGERPRINT_INVALID' };
    }
    if (typeof config.createdAt !== 'string' || !config.createdAt ||
        Number.isNaN(Date.parse(config.createdAt))) {
      return { ok: false, reason: 'VAPID_CREATED_AT_INVALID' };
    }
    return { ok: true, version: config.version, publicKey: config.publicKey,
      fingerprint: config.fingerprint, createdAt: config.createdAt, keyBytes };
  }
  // Async validation additionally proves the published fingerprint is the
  // SHA-256 of the exact 65 public-key bytes.
  async function validate(config) {
    const structural = inspect(config);
    if (!structural.ok) return structural;
    const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
    if (!subtle) return { ok: false, reason: 'VAPID_CRYPTO_UNAVAILABLE' };
    // Importing the raw point as a P-256 key proves it is a valid uncompressed
    // curve point; WebCrypto rejects an off-curve or degenerate coordinate.
    try {
      await subtle.importKey('raw', structural.keyBytes.slice().buffer,
        { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    } catch (_) {
      return { ok: false, reason: 'VAPID_PUBLIC_KEY_INVALID' };
    }
    try {
      const digest = new Uint8Array(await subtle.digest('SHA-256', structural.keyBytes.slice().buffer));
      if (toHex(digest) !== structural.fingerprint) return { ok: false, reason: 'VAPID_FINGERPRINT_MISMATCH' };
    } catch (_) {
      return { ok: false, reason: 'VAPID_FINGERPRINT_MISMATCH' };
    }
    return structural;
  }
  window.CapVapidPublic = Object.freeze({
    VERSION_RE, DARK, current, inspect, validate, decodeBase64url, encodeBase64url, toHex
  });
})();
