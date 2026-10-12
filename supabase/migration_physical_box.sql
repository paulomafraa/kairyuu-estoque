-- Caixinha física unificada (saco grande por cliente) + "colocado na caixa geral"
-- por carta do evento. Rodar no SQL Editor do Supabase.

alter table public.customers
  add column if not exists physical_box boolean not null default false;
alter table public.customers
  add column if not exists physical_box_label text not null default '';
alter table public.customers
  add column if not exists physical_box_since timestamptz;
alter table public.customers
  add column if not exists physical_box_by uuid references public.profiles (id);

alter table public.event_sale_lines
  add column if not exists boxed boolean not null default false;
alter table public.event_sale_lines
  add column if not exists boxed_at timestamptz;
alter table public.event_sale_lines
  add column if not exists boxed_by uuid references public.profiles (id);

create index if not exists customers_physical_box_idx
  on public.customers (physical_box) where physical_box;
