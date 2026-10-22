-- Estoque físico: telefone, e-mail e aviso de prazo na caixinha.
-- Linha manual (o que não veio de rodada) e registro dos e-mails já enviados.
-- Rodar no SQL Editor do Supabase. Pode rodar mais de uma vez.

alter table public.physical_boxes
  add column if not exists phone text not null default '';
alter table public.physical_boxes
  add column if not exists phone_digits text not null default '';
alter table public.physical_boxes
  add column if not exists email text not null default '';
alter table public.physical_boxes
  add column if not exists reminders_enabled boolean not null default false;

create table if not exists public.physical_box_lines (
  id uuid primary key default gen_random_uuid(),
  box_id uuid not null references public.physical_boxes (id) on delete cascade,
  title text not null,
  qty integer not null default 1 check (qty > 0),
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create index if not exists physical_box_lines_box_idx
  on public.physical_box_lines (box_id);

alter table public.physical_box_lines enable row level security;
drop policy if exists "staff all physical_box_lines" on public.physical_box_lines;
create policy "staff all physical_box_lines" on public.physical_box_lines
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.physical_box_lines to authenticated;

create table if not exists public.physical_box_reminders (
  id uuid primary key default gen_random_uuid(),
  box_id uuid not null references public.physical_boxes (id) on delete cascade,
  milestone text not null check (milestone in ('14', '7', '1')),
  anchor_on date not null,
  sent_at timestamptz not null default now(),
  unique (box_id, milestone, anchor_on)
);

alter table public.physical_box_reminders enable row level security;
drop policy if exists "staff all physical_box_reminders" on public.physical_box_reminders;
create policy "staff all physical_box_reminders" on public.physical_box_reminders
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.physical_box_reminders to authenticated;
