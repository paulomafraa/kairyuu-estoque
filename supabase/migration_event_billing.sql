-- Eventos de cobrança (leilão/encomenda) + linhas importadas da planilha
-- Rodar no SQL Editor do Supabase.

alter table public.events
  add column if not exists payment_due_at date;

alter table public.events
  add column if not exists kind text not null default 'leilao';

do $$
begin
  alter table public.events
    add constraint events_kind_check
    check (kind in ('leilao', 'encomenda', 'outro'));
exception
  when duplicate_object then null;
end $$;

alter table public.events
  add column if not exists use_stock_box boolean not null default false;

-- Linhas do evento (import planilha ou manual)
create table if not exists public.event_sale_lines (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  phone_digits text not null default '',
  customer_name_snapshot text not null default '',
  product_title text not null,
  valor_ou_opcao text not null default '',
  unit_price numeric(12, 2),
  import_status text not null default 'manual'
    check (import_status in (
      'arrematado',
      'lance',
      'voto',
      'verificar_manual',
      'sem_voto',
      'manual'
    )),
  certainty text not null default 'certain'
    check (certainty in ('certain', 'manual_review')),
  arremate boolean not null default false,
  poll_id text not null default '',
  separated boolean not null default false,
  separated_at timestamptz,
  separated_by uuid references public.profiles (id),
  charged boolean not null default false,
  charged_at timestamptz,
  charged_by uuid references public.profiles (id),
  paid boolean not null default false,
  paid_at timestamptz,
  paid_by uuid references public.profiles (id),
  garage_item_id uuid references public.customer_garage_items (id) on delete set null,
  cancelled boolean not null default false,
  cancel_reason text not null default '',
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id),
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create index if not exists event_sale_lines_event_idx
  on public.event_sale_lines (event_id);
create index if not exists event_sale_lines_customer_idx
  on public.event_sale_lines (customer_id);
create index if not exists event_sale_lines_phone_idx
  on public.event_sale_lines (phone_digits);

-- Ligar garagem ao evento (opcional)
alter table public.customer_garage_items
  add column if not exists event_id uuid references public.events (id) on delete set null;

create index if not exists garage_event_idx
  on public.customer_garage_items (event_id);

alter table public.event_sale_lines enable row level security;

drop policy if exists "staff all event_sale_lines" on public.event_sale_lines;
create policy "staff all event_sale_lines" on public.event_sale_lines
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.event_sale_lines to authenticated;
