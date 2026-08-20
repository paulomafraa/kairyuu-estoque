-- Quem criou a encomenda (staff)
-- Rodar no SQL Editor do Supabase.

alter table public.orders
  add column if not exists created_by uuid references public.profiles (id);

create index if not exists orders_created_by_idx
  on public.orders (created_by);

create index if not exists orders_created_at_idx
  on public.orders (created_at);
