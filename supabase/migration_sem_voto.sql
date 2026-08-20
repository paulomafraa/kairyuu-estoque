-- Status sem_voto nas linhas do evento (leilão: carta sem lances)
-- Rodar no SQL Editor do Supabase.

alter table public.event_sale_lines
  drop constraint if exists event_sale_lines_import_status_check;

alter table public.event_sale_lines
  add constraint event_sale_lines_import_status_check
  check (import_status in (
    'arrematado',
    'lance',
    'voto',
    'verificar_manual',
    'sem_voto',
    'manual'
  ));
