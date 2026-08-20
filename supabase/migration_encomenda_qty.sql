-- qty por linha + chegada de produtos no evento (encomendas)
-- Rodar no SQL Editor do Supabase.

alter table public.event_sale_lines
  add column if not exists qty integer not null default 1;

alter table public.event_sale_lines
  drop constraint if exists event_sale_lines_qty_check;

alter table public.event_sale_lines
  add constraint event_sale_lines_qty_check check (qty > 0);

alter table public.event_sale_lines
  add column if not exists archived boolean not null default false;

create table if not exists public.event_product_stock (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  product_title text not null,
  qty_arrived integer not null default 0 check (qty_arrived >= 0),
  notes text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id),
  unique (event_id, product_title)
);

create index if not exists event_product_stock_event_idx
  on public.event_product_stock (event_id);

alter table public.event_product_stock enable row level security;

drop policy if exists "staff all event_product_stock" on public.event_product_stock;
create policy "staff all event_product_stock" on public.event_product_stock
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.event_product_stock to authenticated;
