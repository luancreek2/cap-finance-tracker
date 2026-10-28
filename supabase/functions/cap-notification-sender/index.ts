import { createSupabaseContext } from "@supabase/server";
import { createRuntime, type Runtime } from "./runtime.ts";
import { classify } from "./results.ts";
import { authorization, endpoint, invalid, payload, request, subscription, validateIdentity, verifyAuthorization,
  type Identity, type Payload, type Subscription } from "./webpush.ts";

// DARK public manifest: no usable VAPID identity ships in 5B.3B.
export const PUBLIC_IDENTITIES: Readonly<Record<string, { publicKey: string; fingerprint: string }>> = Object.freeze({});
type Counts = { claimed: number; accepted: number; retry_wait: number; terminal: number; unknown: number };
type Dependencies = { runtime: Runtime; identities: Identity[]; fetch: typeof fetch; now: () => number;
  log: (record: { run_id: string; counts: Counts; status: string; duration_ms: number }) => void };
let configured: { runtime: Runtime; identities: Identity[] } | null = null;

async function productionConfig() {
  if (configured) return configured;
  const identities = Object.entries(PUBLIC_IDENTITIES).map(([version, pub]) => ({ version, ...pub,
    privateKey: Deno.env.get(`CAP_PUSH_VAPID_${version.toUpperCase()}_PRIVATE`) || "",
    subject: Deno.env.get("CAP_PUSH_VAPID_SUBJECT") || "" }));
  if (!identities.length) throw Error("SENDER_DARK_CONFIGURATION");
  for (const i of identities) await validateIdentity(i);
  const runtime = createRuntime(Deno.env.get("CAP_PUSH_DATABASE_URL") || "");
  return configured = { runtime, identities };
}

export async function validateRequest(req: Request): Promise<number> {
  if (req.method !== "POST") return 405;
  if (new URL(req.url).search || req.headers.has("origin") || req.headers.has("sec-fetch-mode") || req.headers.has("sec-fetch-site")) return 400;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get("content-type") || "")) return 415;
  const reader = req.body?.getReader();
  if (!reader) return 400;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read(); if (r.done) break;
      size += r.value.length; if (size > 256) return 413;
      chunks.push(r.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    const b = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return b && !Array.isArray(b) && typeof b === "object" && Object.keys(b).length === 1 &&
      b.operation === "process-due-v1" ? 0 : 400;
  } catch { return 400; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function safeInteger(value: unknown): number {
  if (typeof value === "string" && /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalid();
  return value;
}
export function constructPayload(permit: Record<string, unknown>): Payload {
  const p: Payload = { protocol: "CAP_PUSH_V1", type: "reminder", version: 1,
    installation_id: permit.installation_id as string, binding_id: permit.binding_id as string,
    generation: safeInteger(permit.generation), expires_at: safeInteger(permit.expires_at) };
  payload(p); return p;
}

// Dependency injection is local test composition, never an HTTP mode/field.
export async function processDue(d: Dependencies, runId: string): Promise<{ status: string; counts: Counts }> {
  const counts: Counts = { claimed: 0, accepted: 0, retry_wait: 0, terminal: 0, unknown: 0 };
  const started = d.now();
  for (const identity of d.identities) await validateIdentity(identity);
  if (!d.identities.length) return { status: "parked", counts };
  const run = await d.runtime.call("begin_run_v1", [runId]);
  if (run.ok !== true) return { status: ["parked", "busy", "rate_limited"].includes(String(run.status)) ? String(run.status) : "unavailable", counts };
  const token = run.run_token;
  await d.runtime.call("recover_v1", [token]);
  for (let n = 0; n < 3 && d.now() - started < 20000; n++) {
    const claim = await d.runtime.call("claim_v1", [token]);
    if (claim.ok !== true) break;
    counts.claimed++;
    // Positive transaction commit must be observed. A rejection/unknown outcome
    // here propagates WITHOUT a fetch, without replaying start for another permit.
    const permit = await d.runtime.call("start_dispatch_v1", [token, claim.claim_token]);
    if (permit.ok !== true) { counts.terminal++; continue; }
    let result: "accepted" | "invalid_subscription" | "configuration" | "temporary_rejection" | "ambiguous" | "expired" = "configuration";
    let delay: number | null = null, stop = true;
    try {
      const p = constructPayload(permit);
      const identity = d.identities.find(i => i.version === permit.vapid_key_version);
      if (!identity) throw Error("SENDER_CONFIGURATION");
      const s: Subscription = { endpoint: permit.endpoint as string, keys: { p256dh: permit.p256dh as string, auth: permit.auth as string } };
      await subscription(s);
      const { url, provider } = endpoint(s.endpoint);
      const cached = await d.runtime.call("vapid_token_get_v1", [token, url.origin, identity.version]);
      let header = cached.authorization;
      if (!header && cached.generation_token) {
        const generated = await authorization(s, identity);
        // Lost put response: only re-read, never generate a second token.
        try { await d.runtime.call("vapid_token_put_v1", [cached.generation_token, generated.authorization, generated.expires_at]); } catch { /* re-read below */ }
        header = (await d.runtime.call("vapid_token_get_v1", [token, url.origin, identity.version])).authorization;
      }
      if (typeof header !== "string") throw Error("SENDER_TOKEN_UNAVAILABLE");
      await verifyAuthorization(header, url.origin, identity, d.now());
      const ttl = Math.min(300, Math.floor(Number(permit.ttl_seconds) - 2 - (d.now() - started) / 1000), p.expires_at - Math.ceil(d.now() / 1000) - 2);
      if (ttl <= 0 || d.now() - started >= 24000) { result = "expired"; }
      else {
        const init = await request(s, p, header, ttl);
        endpoint(s.endpoint); // last-moment validation, before the only fetch
        result = "ambiguous"; // from this point exceptions must NEVER cause retry
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await d.fetch(s.endpoint, { ...init, signal: controller.signal });
          const c = await classify(response, provider, d.now());
          result = c.result as typeof result; delay = c.retryAfter; stop = c.stop;
          await response.body?.cancel().catch(() => {});
        } finally { clearTimeout(timer); }
      }
    } catch { /* fixed result only; no raw errors, payload, headers or identifiers */ }
    const finalized = await d.runtime.call("finalize_v1", [claim.claim_token, result, delay]);
    if (finalized.state === "accepted") counts.accepted++;
    else if (finalized.state === "retry_wait") counts.retry_wait++;
    else if (finalized.state === "unknown") counts.unknown++;
    else counts.terminal++;
    if (stop || d.now() - started >= 24000) break;
  }
  return { status: "completed", counts };
}

export async function handler(req: Request): Promise<Response> {
  const started = Date.now(), run_id = crypto.randomUUID();
  const counts: Counts = { claimed: 0, accepted: 0, retry_wait: 0, terminal: 0, unknown: 0 };
  const respond = (status: string, code: number, c = counts) => Response.json({ run_id, status, counts: c, duration_ms: Date.now() - started },
    { status: code, headers: { "cache-control": "no-store", ...(code === 429 ? { "retry-after": "60" } : {}) } });
  try {
    const check = await validateRequest(req); if (check) return respond("invalid_request", check);
    const { error } = await createSupabaseContext(req, { auth: "secret:cap-push-invoke" });
    if (error) return respond("unauthorized", 401);
    // No use of ctx.supabaseAdmin, ctx.postgres, Cap API keys or platform DB URL.
    const config = await productionConfig();
    const r = await processDue({ ...config, fetch, now: Date.now, log: () => {} }, run_id);
    const code = r.status === "busy" ? 409 : r.status === "rate_limited" ? 429 : r.status === "unavailable" ? 503 : 200;
    return respond(r.status, code, r.counts);
  } catch { return respond("configuration_or_runtime_unavailable", 503); }
}

if (import.meta.main) Deno.serve(handler);
export default { fetch: handler };
