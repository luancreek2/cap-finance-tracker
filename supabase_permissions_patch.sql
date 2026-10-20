-- Cap Phase 2 permissions patch for an existing Supabase database.
-- Idempotent: safe to run more than once. It changes privileges only and does
-- not alter, migrate, delete, or update any Cap data. RLS remains enabled.

grant usage on schema public to authenticated;

revoke all on table public.profiles, public.user_preferences, public.categories, public.accounts,
  public.goals, public.debts, public.bills, public.account_statements, public.transactions,
  public.transfers, public.bill_payments, public.budgets, public.notes from anon, public;

grant select, insert, update, delete on table public.profiles, public.user_preferences, public.categories,
  public.accounts, public.goals, public.debts, public.bills, public.account_statements, public.transactions,
  public.transfers, public.bill_payments, public.budgets, public.notes to authenticated;
