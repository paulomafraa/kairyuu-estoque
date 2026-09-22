-- Backup permanente de rodada (leilão/encomenda) antes de excluir o evento.
-- Rodar no SQL Editor do Supabase. Sem DELETE: o backup não pode ser apagado.

create table if not exists public.event_round_backups (
  id uuid primary key default gen_random_uuid(),
  original_event_id uuid not null,
  event_name text not null,
  event_kind text not null default 'leilao',
  opened_at timestamptz,
  deleted_at timestamptz not null default now(),
  deleted_by uuid references public.profiles (id),
  payload jsonb not null
);

create index if not exists event_round_backups_deleted_idx
  on public.event_round_backups (deleted_at desc);

create index if not exists event_round_backups_original_idx
  on public.event_round_backups (original_event_id);

alter table public.event_round_backups enable row level security;

drop policy if exists "staff read event_round_backups" on public.event_round_backups;
create policy "staff read event_round_backups" on public.event_round_backups
  for select to authenticated using (true);

drop policy if exists "staff insert event_round_backups" on public.event_round_backups;
create policy "staff insert event_round_backups" on public.event_round_backups
  for insert to authenticated with check (true);

revoke all on public.event_round_backups from authenticated;
grant select, insert on public.event_round_backups to authenticated;

create or replace function public.forbid_event_round_backup_mutate()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Backups de rodada não podem ser excluídos.';
  end if;
  raise exception 'Backups de rodada não podem ser alterados.';
end;
$$;

drop trigger if exists event_round_backups_no_update on public.event_round_backups;
create trigger event_round_backups_no_update
  before update on public.event_round_backups
  for each row execute procedure public.forbid_event_round_backup_mutate();

drop trigger if exists event_round_backups_no_delete on public.event_round_backups;
create trigger event_round_backups_no_delete
  before delete on public.event_round_backups
  for each row execute procedure public.forbid_event_round_backup_mutate();
