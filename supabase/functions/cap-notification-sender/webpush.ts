import { encryptNotification, vapidHeaders } from "@block65/webcrypto-web-push";
import type { Provider } from "./results.ts";

export const PAYLOAD_FIELDS = ["protocol", "type", "version", "installation_id", "binding_id", "generation", "expires_at"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9_-]+$/;
export type Payload = { protocol: "CAP_PUSH_V1"; type: "reminder"; version: 1;
  installation_id: string; binding_id: string; generation: number; expires_at: number };
export type Identity = { version: string; publicKey: string; privateKey: string; fingerprint: string; subject: string };
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export function invalid(): never { throw new Error("SENDER_VALIDATION_FAILED"); }
export function decode(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !B64.test(value)) return invalid();
  let raw: string;
  try { raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)); }
  catch { return invalid(); }
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (bytes.length !== length || encode(bytes) !== value) return invalid();
  return bytes;
}
export function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function fingerprint(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
export function payload(value: unknown): Uint8Array<ArrayBuffer> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const p = value as Payload;
  const bytes = new TextEncoder().encode(JSON.stringify(p));
  if (bytes.length > 512 || Object.keys(p).length !== 7 || !PAYLOAD_FIELDS.every(k => Object.hasOwn(p, k)) ||
    p.protocol !== "CAP_PUSH_V1" || p.type !== "reminder" || p.version !== 1 ||
    !UUID.test(p.installation_id) || !UUID.test(p.binding_id) ||
    !Number.isSafeInteger(p.generation) || p.generation <= 0 ||
    !Number.isSafeInteger(p.expires_at) || p.expires_at <= 0) return invalid();
  return bytes;
}
export function endpoint(value: string): { url: URL; provider: Provider } {
  // Match the frozen SQL syntax BEFORE URL normalization (including explicit :443).
  if (typeof value !== "string" || value.length > 4096 || !/^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(push\.apple\.com|notify\.windows\.com))\/([A-Za-z0-9_./~?=&+\-]|%[0-9A-Fa-f]{2})+$/.test(value)) return invalid();
  const url = new URL(value);
  const provider = url.hostname === "fcm.googleapis.com" ? "fcm" : url.hostname === "updates.push.services.mozilla.com" ? "mozilla"
    : url.hostname.endsWith(".push.apple.com") ? "apple" : "microsoft";
  return { url, provider };
}
export async function validateIdentity(i: Identity): Promise<void> {
  if (!/^v[1-9][0-9]{0,2}$/.test(i.version) || !/^[0-9a-f]{64}$/.test(i.fingerprint)) return invalid();
  const pub = decode(i.publicKey, 65); decode(i.privateKey, 32);
  const subject = new URL(i.subject);
  if (pub[0] !== 4 || subject.protocol !== "https:" || subject.username || subject.password || subject.hash ||
    !subject.hostname.includes(".") || subject.hostname === "localhost" ||
    await fingerprint(pub) !== i.fingerprint) return invalid();
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: encode(pub.slice(1, 33)), y: encode(pub.slice(33)), d: i.privateKey },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const verify = await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const challenge = new TextEncoder().encode("CAP_PUSH_V1 key correspondence");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, challenge);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verify, signature, challenge)) return invalid();
}
export async function subscription(s: Subscription): Promise<void> {
  endpoint(s.endpoint);
  const pub = decode(s.keys.p256dh, 65); decode(s.keys.auth, 16);
  if (pub[0] !== 4) return invalid();
  await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, false, []);
}
export async function authorization(s: Subscription, i: Identity): Promise<{ authorization: string; expires_at: string }> {
  const h = (await vapidHeaders({ ...s, expirationTime: null }, i)).headers.authorization;
  const claims = JSON.parse(atob(h.split("t=")[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { authorization: h, expires_at: new Date(claims.exp * 1000).toISOString() };
}
export async function verifyAuthorization(h: string, origin: string, i: Identity, now = Date.now()): Promise<void> {
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(h);
  if (!m || h.length > 2048 || m[4] !== i.publicKey) return invalid();
  const parse = (v: string) => JSON.parse(atob(v.replace(/-/g, "+").replace(/_/g, "/")));
  const header = parse(m[1]), c = parse(m[2]);
  if (header.alg !== "ES256" || c.aud !== origin || c.sub !== i.subject || !Number.isInteger(c.exp) ||
    c.exp * 1000 <= now || c.exp * 1000 > now + 86400000) return invalid();
  const key = await crypto.subtle.importKey("raw", decode(i.publicKey, 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(m[3], 64),
    new TextEncoder().encode(m[1] + "." + m[2]))) return invalid();
}
export async function request(s: Subscription, p: Payload, h: string, ttl: number): Promise<RequestInit> {
  await subscription(s);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 300) return invalid();
  return { method: "POST", redirect: "error", headers: { authorization: h, ttl: String(ttl), urgency: "normal",
    "content-encoding": "aes128gcm", "content-type": "application/octet-stream" },
    body: await encryptNotification({ ...s, expirationTime: null }, payload(p), { pad: false }) };
}
