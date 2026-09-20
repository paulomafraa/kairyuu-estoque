-- Atividade de membros do WhatsApp (sync do bot) para filtro "Inativos do grupo".
-- Rodar no SQL Editor do Supabase.

create table if not exists public.whatsapp_group_activity (
  group_alias text not null,
  phone_digits text not null,
  name text not null default '',
  message_count integer not null default 0,
  present boolean not null default true,
  last_message_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (group_alias, phone_digits)
);

create index if not exists whatsapp_group_activity_present_idx
  on public.whatsapp_group_activity (group_alias, present, message_count);

create index if not exists whatsapp_group_activity_phone_idx
  on public.whatsapp_group_activity (phone_digits);

alter table public.whatsapp_group_activity enable row level security;

drop policy if exists "staff read whatsapp_group_activity" on public.whatsapp_group_activity;
create policy "staff read whatsapp_group_activity" on public.whatsapp_group_activity
  for select to authenticated using (true);

-- Escrita só via service role (API do bot). Staff autenticado só lê.
grant select on public.whatsapp_group_activity to authenticated;
