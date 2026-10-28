// Closed result vocabulary. Never retain provider response text or thrown errors.
export type Result = "accepted" | "invalid_subscription" | "configuration" |
  "temporary_rejection" | "ambiguous" | "expired" | "disabled";
export type Classification = { result: Result; stop: boolean; retryAfter: number | null };
export type Provider = "fcm" | "mozilla" | "apple" | "microsoft";

export function retryAfter(value: string | null, now: number): number | null {
  if (!value || value.length > 128) return null;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n <= 604800 ? n : null;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) && t >= now && t - now <= 604800000 ? Math.ceil((t - now) / 1000) : null;
}

async function reason(response: Response): Promise<{ reason?: string; errno?: number }> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) return {};
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    // Only these documented non-acceptance signals cross the parsing boundary.
    return {
      reason: ["ServiceUnavailable", "Shutdown"].includes(raw?.reason) ? raw.reason : undefined,
      errno: [201, 202].includes(raw?.errno) ? raw.errno : undefined,
    };
  } catch { return {}; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function classify(response: Response, provider: Provider, now = Date.now()): Promise<Classification> {
  const status = response.status;
  if (status >= 200 && status < 300) return { result: "accepted", stop: status !== 201, retryAfter: null };
  if (status === 404 || status === 410) return { result: "invalid_subscription", stop: false, retryAfter: null };
  if ([400, 401, 403, 405, 413, 415].includes(status)) return { result: "configuration", stop: true, retryAfter: null };
  if (status === 429) {
    const delay = retryAfter(response.headers.get("retry-after"), now);
    return delay === null ? { result: "ambiguous", stop: true, retryAfter: null }
      : { result: "temporary_rejection", stop: true, retryAfter: delay };
  }
  if (status === 503) {
    const code = await reason(response);
    if (provider === "mozilla" && code.errno || provider === "apple" && code.reason) {
      return { result: "temporary_rejection", stop: true, retryAfter: retryAfter(response.headers.get("retry-after"), now) ?? 60 };
    }
  }
  return { result: "ambiguous", stop: true, retryAfter: null };
}
