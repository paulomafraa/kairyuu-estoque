-- Arquivar linhas (💙 / resultados que não entram na cobrança)
-- Rodar no SQL Editor do Supabase (se ainda não rodou migration_encomenda_qty, rode ela antes).

alter table public.event_sale_lines
  add column if not exists archived boolean not null default false;

create index if not exists event_sale_lines_archived_idx
  on public.event_sale_lines (event_id, archived);
