-- Custos / preços de preparação da rodada de encomendas (template CSV).
-- Rodar no SQL Editor do Supabase.

create table if not exists public.event_product_costs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  product_title text not null,
  cost_jp numeric(12, 2),
  price_sale numeric(12, 2),
  price_liga numeric(12, 2),
  link text not null default '',
  created_at timestamptz not null default now(),
  unique (event_id, product_title)
);

create index if not exists event_product_costs_event_idx
  on public.event_product_costs (event_id);

alter table public.event_product_costs enable row level security;

drop policy if exists "staff all event_product_costs" on public.event_product_costs;
create policy "staff all event_product_costs" on public.event_product_costs
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.event_product_costs to authenticated;
