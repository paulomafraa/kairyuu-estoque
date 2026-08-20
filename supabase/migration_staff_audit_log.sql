-- Log global de ações do staff (auditoria do site)
-- Rodar no SQL Editor do Supabase.

create table if not exists public.staff_audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  detail text not null default '',
  entity_type text not null default '',
  entity_id text not null default '',
  customer_id uuid references public.customers (id) on delete set null,
  event_id uuid references public.events (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create index if not exists staff_audit_log_created_idx
  on public.staff_audit_log (created_at desc);

create index if not exists staff_audit_log_user_idx
  on public.staff_audit_log (created_by, created_at desc);

alter table public.staff_audit_log enable row level security;

drop policy if exists "staff all audit log" on public.staff_audit_log;
create policy "staff all audit log" on public.staff_audit_log
  for all to authenticated using (true) with check (true);

grant select, insert on public.staff_audit_log to authenticated;
