-- Chegada por cliente/linha na encomenda (levas parciais).
-- Rodar no SQL Editor do Supabase.

alter table public.event_sale_lines
  add column if not exists qty_arrived integer not null default 0;

alter table public.event_sale_lines
  drop constraint if exists event_sale_lines_qty_arrived_check;

alter table public.event_sale_lines
  add constraint event_sale_lines_qty_arrived_check check (qty_arrived >= 0);
