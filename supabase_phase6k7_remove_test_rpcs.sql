-- Phase 6K.7: retire the test-only RPCs.
-- Run this only when the controlled-write harness is no longer needed.
-- It removes the test capability; it does not touch user data.
--
-- Before running:
--   1. Confirm Cloud Sync is OFF and no controlled-write test is in progress.
--   2. Keep a copy of supabase_phase6k2_transaction_rpc.sql and
--      supabase_phase6k3_rpc_verifier.sql so the harness can be reinstalled.
--
-- After running, the app fails closed: rpcReady() becomes false and the
-- controlled-write audit reports the RPC as unavailable.

drop function if exists public.cap_test_transaction_create(
  uuid, text, uuid, uuid, uuid, numeric, date, date, text, text, text, jsonb
);

drop function if exists public.cap_verify_transaction_rpc();
