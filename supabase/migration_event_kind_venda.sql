-- Tipo de evento "venda" (além de leilão e encomenda).
-- Rodar no SQL Editor do Supabase.

alter table public.events drop constraint if exists events_kind_check;

alter table public.events
  add constraint events_kind_check
  check (kind in ('leilao', 'encomenda', 'venda', 'outro'));
