-- Cobranças automáticas (lista controlada pelo estoque, enviada pelo bot).
-- Rodar no SQL Editor do Supabase.

create table if not exists public.billing_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  mode text not null default 'unificada'
    check (mode in ('unificada', 'separada', 'manual')),
  status text not null default 'draft'
    check (status in ('draft', 'running', 'paused', 'stopped', 'done')),
  is_test boolean not null default false,
  event_ids uuid[] not null default '{}',
  min_interval_s integer not null default 50 check (min_interval_s >= 30),
  max_interval_s integer not null default 75 check (max_interval_s >= min_interval_s),
  next_send_at timestamptz,
  last_sent_at timestamptz,
  fail_streak integer not null default 0,
  pause_reason text not null default '',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

create index if not exists billing_runs_status_idx
  on public.billing_runs (status, started_at);

create table if not exists public.billing_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.billing_runs (id) on delete cascade,
  position integer not null,
  customer_id uuid references public.customers (id) on delete set null,
  customer_name text not null default '',
  phone_digits text not null,
  text text not null,
  total numeric(12, 2),
  sale_line_ids uuid[] not null default '{}',
  event_ids uuid[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  edited boolean not null default false,
  claimed_at timestamptz,
  sent_at timestamptz,
  error text not null default '',
  wa_message_id text not null default '',
  reply_count integer not null default 0,
  last_reply_at timestamptz,
  payment_status text not null default 'none'
    check (payment_status in ('none', 'hint', 'confirmed')),
  payment_confirmed_at timestamptz,
  payment_confirmed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_items_run_idx
  on public.billing_items (run_id, status, position);
create index if not exists billing_items_sent_idx
  on public.billing_items (status, sent_at);
create index if not exists billing_items_phone_idx
  on public.billing_items (phone_digits);

create table if not exists public.billing_replies (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.billing_items (id) on delete cascade,
  run_id uuid not null references public.billing_runs (id) on delete cascade,
  phone_digits text not null default '',
  received_at timestamptz not null default now(),
  kind text not null default 'text'
    check (kind in ('text', 'image', 'document', 'audio', 'video', 'sticker', 'other')),
  text text not null default '',
  media_path text not null default '',
  mimetype text not null default '',
  wa_message_id text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists billing_replies_wa_msg_idx
  on public.billing_replies (wa_message_id);
create index if not exists billing_replies_item_idx
  on public.billing_replies (item_id, received_at);

alter table public.billing_runs enable row level security;
alter table public.billing_items enable row level security;
alter table public.billing_replies enable row level security;

drop policy if exists "staff all billing_runs" on public.billing_runs;
create policy "staff all billing_runs" on public.billing_runs
  for all to authenticated using (true) with check (true);

drop policy if exists "staff all billing_items" on public.billing_items;
create policy "staff all billing_items" on public.billing_items
  for all to authenticated using (true) with check (true);

drop policy if exists "staff read billing_replies" on public.billing_replies;
create policy "staff read billing_replies" on public.billing_replies
  for select to authenticated using (true);

grant select, insert, update, delete on public.billing_runs to authenticated;
grant select, insert, update, delete on public.billing_items to authenticated;
-- Respostas: escrita só via service role (API do bot).
grant select on public.billing_replies to authenticated;

-- Comprovantes / mídias das respostas (privado — só staff logado lê)
insert into storage.buckets (id, name, public)
values ('billing-replies', 'billing-replies', false)
on conflict (id) do nothing;

drop policy if exists "staff read billing-replies" on storage.objects;
create policy "staff read billing-replies" on storage.objects
  for select to authenticated
  using (bucket_id = 'billing-replies');
