-- Ordem da enquete (timestamp) e ordem da aba do encomendas.xlsx.
-- Rodar no SQL Editor do Supabase.

alter table public.event_sale_lines
  add column if not exists poll_created_at timestamptz;

alter table public.event_product_costs
  add column if not exists sort_index integer;

create index if not exists event_sale_lines_poll_created_idx
  on public.event_sale_lines (event_id, poll_created_at);
