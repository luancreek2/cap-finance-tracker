import postgres from "postgres";

export type RecordValue = Record<string, unknown>;
export interface Runtime { call(name: Operation, args: unknown[]): Promise<RecordValue>; }
export type Operation = "begin_run_v1" | "claim_v1" | "start_dispatch_v1" | "finalize_v1" | "recover_v1" |
  "vapid_token_get_v1" | "vapid_token_put_v1";
export const DATABASE_OPTIONS = Object.freeze({ max: 1, prepare: false, max_pipeline: 1, connect_timeout: 2, idle_timeout: 10 });

export function databaseUrl(value: string): URL {
  const u = new URL(value);
  if (u.protocol !== "postgresql:" || u.port !== "6543" ||
    !/^cap_notification_sender_login\.[a-z0-9]+$/.test(decodeURIComponent(u.username)) ||
    !u.password || !/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(u.hostname) ||
    u.pathname !== "/postgres" || u.search) throw Error("SENDER_DATABASE_CONFIG_INVALID");
  return u;
}

export function createRuntime(value: string): Runtime {
  databaseUrl(value);
  // Node TLS defaults verify the peer/hostname. Do not use rejectUnauthorized:false.
  // No fallback to the platform's SUPABASE_DB_URL or Cap API credentials.
  const sql = postgres(value, { ...DATABASE_OPTIONS, ssl: { rejectUnauthorized: true },
    onnotice: () => {}, debug: false });
  // Fixed statements only; no arbitrary SQL/function name enters this interface.
  const statements: Record<Operation, string> = {
    begin_run_v1: "select cap_notifications_runtime.begin_run_v1($1::uuid) as v",
    claim_v1: "select cap_notifications_runtime.claim_v1($1::uuid) as v",
    start_dispatch_v1: "select cap_notifications_runtime.start_dispatch_v1($1::uuid,$2::uuid) as v",
    finalize_v1: "select cap_notifications_runtime.finalize_v1($1::uuid,$2::text,$3::integer) as v",
    recover_v1: "select cap_notifications_runtime.recover_v1($1::uuid) as v",
    vapid_token_get_v1: "select cap_notifications_runtime.vapid_token_get_v1($1::uuid,$2::text,$3::text) as v",
    vapid_token_put_v1: "select cap_notifications_runtime.vapid_token_put_v1($1::uuid,$2::text,$3::timestamptz) as v",
  };
  return {
    async call(name, args) {
      if (!Object.hasOwn(statements, name)) throw Error("SENDER_RUNTIME_OPERATION_INVALID");
      try {
        // begin resolves only AFTER COMMIT. Never accept start's SELECT result
        // as permission while its COMMIT is still outstanding or has failed.
        return await sql.begin(async tx => {
          await tx`set local statement_timeout = '2s'`;
          await tx`set local lock_timeout = '500ms'`;
          const rows = await tx.unsafe(statements[name], args as never[]);
          return rows[0].v as RecordValue;
        }) as RecordValue;
      } catch { throw Error("SENDER_RUNTIME_UNAVAILABLE"); }
    },
  };
}
