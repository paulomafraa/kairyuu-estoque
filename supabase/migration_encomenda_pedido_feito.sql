-- Controle de pedido JP por produto na rodada de encomenda
-- Rodar no SQL Editor do Supabase.

alter table public.event_product_stock
  add column if not exists pedido_feito boolean not null default false;

alter table public.event_product_stock
  add column if not exists pedido_feito_at timestamptz;

alter table public.event_product_stock
  add column if not exists pedido_feito_by uuid references public.profiles (id);
