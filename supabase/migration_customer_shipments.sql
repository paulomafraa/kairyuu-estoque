-- Pacotes de envio por cliente (agrupa itens/eventos enviados no mesmo dia).
-- Rodar no SQL Editor do Supabase.

create table if not exists public.customer_shipments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  shipped_on date not null,
  label text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create index if not exists customer_shipments_customer_idx
  on public.customer_shipments (customer_id, shipped_on desc);

alter table public.customer_garage_items
  add column if not exists shipment_id uuid
    references public.customer_shipments (id) on delete set null;

alter table public.customer_garage_items
  add column if not exists shipped_on date;

create index if not exists garage_shipment_idx
  on public.customer_garage_items (shipment_id);

alter table public.customer_shipments enable row level security;

drop policy if exists "staff all shipments" on public.customer_shipments;
create policy "staff all shipments" on public.customer_shipments
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.customer_shipments to authenticated;
