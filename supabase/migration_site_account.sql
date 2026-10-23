-- Conta do site ligada ao cliente pelo celular confirmado.
-- Rode no SQL Editor do Supabase. Sem este arquivo, a garagem ainda
-- lista o que está na loja, mas o @ e o apelido não são gravados.

alter table public.customers
  add column if not exists site_user_id text,
  add column if not exists site_username text,
  add column if not exists site_display_name text,
  add column if not exists site_email text,
  add column if not exists site_linked_at timestamptz;

create unique index if not exists customers_site_user_id_key
  on public.customers (site_user_id)
  where site_user_id is not null;
