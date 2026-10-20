-- Cap Phase 1 initial schema.
-- Review and execute manually in Supabase SQL Editor. This script creates empty
-- tables only; it does not import, migrate, delete, or modify Cap data.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  currency text not null default 'PHP',
  number_format text not null default 'us',
  negative_style text not null default 'sign',
  show_decimals boolean not null default false,
  theme text not null default 'auto',
  animations_enabled boolean not null default true,
  reduce_motion boolean not null default false,
  sound_enabled boolean not null default true,
  haptics_enabled boolean not null default true,
  hide_balances boolean not null default false,
  logo_choice text not null default 'default',
  account_view text not null default 'all',
  account_sort text not null default 'manual',
  account_order jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  legacy_id text,
  name text not null,
  emoji text,
  logo_url text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, name)
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  legacy_id text,
  account_type text not null check (account_type in ('cash','savings','debit','credit','ewallet')),
  bank text,
  name text not null,
  nickname text,
  network text,
  last_four text,
  balance numeric(18,2) not null default 0,
  credit_limit numeric(18,2),
  status text not null default 'Active' check (status in ('Active','Inactive')),
  card_art text,
  photo_url text,
  statement_day integer,
  due_day integer,
  due_days integer,
  minimum_payment jsonb not null default '{}'::jsonb,
  interest_settings jsonb not null default '{}'::jsonb,
  fee_settings jsonb not null default '{}'::jsonb,
  statement_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid,
  legacy_id text,
  name text not null,
  icon text,
  target_amount numeric(18,2) not null default 0,
  saved_amount numeric(18,2) not null default 0,
  target_date date,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id) on delete set null (account_id)
);

create table public.debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  legacy_id text,
  person text not null,
  note text,
  amount numeric(18,2) not null default 0,
  direction text not null check (direction in ('in','out')),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payment_account_id uuid,
  legacy_id text,
  name text not null,
  kind text not null default 'bill' check (kind in ('bill','subscription')),
  amount numeric(18,2) not null default 0,
  frequency text not null default 'monthly' check (frequency in ('once','weekly','biweekly','monthly','quarterly','yearly')),
  start_date date,
  due_day integer,
  logo_url text,
  status text,
  cancelled_on date,
  trial_start date,
  trial_end date,
  alert_settings jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, payment_account_id) references public.accounts(user_id, id) on delete set null (payment_account_id)
);

create table public.account_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null,
  statement_start date,
  statement_end date,
  statement_date date,
  due_date date,
  opening_balance numeric(18,2) default 0,
  closing_balance numeric(18,2) default 0,
  minimum_due numeric(18,2) default 0,
  paid_amount numeric(18,2) default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id) on delete cascade
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid,
  category_id uuid,
  bill_id uuid,
  parent_transaction_id uuid,
  statement_id uuid,
  legacy_id text,
  amount numeric(18,2) not null,
  transaction_date date not null,
  posting_date date,
  status text not null default 'posted' check (status in ('posted','pending')),
  title text,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id) on delete restrict,
  foreign key (user_id, category_id) references public.categories(user_id, id) on delete set null (category_id),
  foreign key (user_id, bill_id) references public.bills(user_id, id) on delete set null (bill_id),
  foreign key (user_id, parent_transaction_id) references public.transactions(user_id, id) on delete set null (parent_transaction_id),
  foreign key (user_id, statement_id) references public.account_statements(user_id, id) on delete set null (statement_id)
);

create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_account_id uuid,
  to_account_id uuid,
  goal_id uuid,
  statement_id uuid,
  legacy_id text,
  transfer_type text not null check (transfer_type in ('account-transfer','card-payment','goal-transfer')),
  amount numeric(18,2) not null,
  transfer_date date not null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, from_account_id) references public.accounts(user_id, id) on delete restrict,
  foreign key (user_id, to_account_id) references public.accounts(user_id, id) on delete restrict,
  foreign key (user_id, goal_id) references public.goals(user_id, id) on delete set null (goal_id),
  foreign key (user_id, statement_id) references public.account_statements(user_id, id) on delete set null (statement_id)
);

create table public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bill_id uuid not null,
  transaction_id uuid,
  transfer_id uuid,
  due_date date,
  paid_date date,
  amount numeric(18,2) not null,
  status text not null default 'scheduled' check (status in ('scheduled','paid','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, bill_id) references public.bills(user_id, id) on delete cascade,
  foreign key (user_id, transaction_id) references public.transactions(user_id, id) on delete set null (transaction_id),
  foreign key (user_id, transfer_id) references public.transfers(user_id, id) on delete set null (transfer_id)
);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid,
  amount numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, category_id),
  foreign key (user_id, category_id) references public.categories(user_id, id) on delete cascade
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  legacy_id text,
  title text,
  body text,
  note_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

-- Explicitly authenticated-only RLS. Anonymous users have no policies.
alter table public.profiles enable row level security;
create policy profiles_own_rows on public.profiles
  as permissive for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

do $$ declare t text; begin
  foreach t in array array['user_preferences','categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy own_rows on public.%I as permissive for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
do $$ declare t text; begin
  foreach t in array array['user_preferences','categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'] loop
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

create index accounts_user_updated_idx on public.accounts(user_id, updated_at);
create index categories_user_idx on public.categories(user_id);
create index goals_user_account_idx on public.goals(user_id, account_id);
create index bills_user_account_idx on public.bills(user_id, payment_account_id);
create index bills_user_updated_idx on public.bills(user_id, updated_at);
create index statements_user_account_idx on public.account_statements(user_id, account_id);
create index transactions_user_date_idx on public.transactions(user_id, transaction_date);
create index transactions_user_account_idx on public.transactions(user_id, account_id);
create index transactions_user_category_idx on public.transactions(user_id, category_id);
create index transactions_user_bill_idx on public.transactions(user_id, bill_id);
create index transfers_user_date_idx on public.transfers(user_id, transfer_date);
create index transfers_user_from_idx on public.transfers(user_id, from_account_id);
create index transfers_user_to_idx on public.transfers(user_id, to_account_id);
create index transfers_user_goal_idx on public.transfers(user_id, goal_id);
create index bill_payments_user_bill_idx on public.bill_payments(user_id, bill_id);
create index bill_payments_user_transaction_idx on public.bill_payments(user_id, transaction_id);
create index bill_payments_user_transfer_idx on public.bill_payments(user_id, transfer_id);
create index budgets_user_category_idx on public.budgets(user_id, category_id);

-- PostgREST role privileges. These grants do not bypass RLS; policies above
-- still restrict every authenticated request to the caller's own rows.
grant usage on schema public to authenticated;
revoke all on table public.profiles, public.user_preferences, public.categories, public.accounts,
  public.goals, public.debts, public.bills, public.account_statements, public.transactions,
  public.transfers, public.bill_payments, public.budgets, public.notes from anon, public;
grant select, insert, update, delete on table public.profiles, public.user_preferences, public.categories,
  public.accounts, public.goals, public.debts, public.bills, public.account_statements, public.transactions,
  public.transfers, public.bill_payments, public.budgets, public.notes to authenticated;
