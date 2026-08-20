-- Rodar no SQL Editor do Supabase (depois do schema inicial).

alter table public.customers
  add column if not exists phone_digits text;

alter table public.customers
  add column if not exists source text not null default 'manual';

-- Garante o check de source (ignora se já existir)
do $$
begin
  alter table public.customers
    add constraint customers_source_check
    check (source in ('manual', 'whatsapp_group'));
exception
  when duplicate_object then null;
end $$;

update public.customers
set phone_digits = nullif(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '')
where phone_digits is null or phone_digits = '';

drop index if exists customers_phone_digits_uidx;

do $$
begin
  alter table public.customers
    add constraint customers_phone_digits_key unique (phone_digits);
exception
  when duplicate_object then null;
  when unique_violation then
    raise notice 'Há telefones duplicados — limpe antes de recriar a unique.';
end $$;

create index if not exists customers_source_idx on public.customers (source);
