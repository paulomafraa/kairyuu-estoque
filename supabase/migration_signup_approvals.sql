-- Aprovações de cadastro da staff (código enviado ao e-mail do dono).
-- Só o service role acessa (sem policies = bloqueado para anon/authenticated).

create table if not exists public.signup_approvals (
  id uuid primary key default gen_random_uuid(),
  requester_email text not null,
  requester_name text not null default '',
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  request_ip text not null default ''
);

create index if not exists signup_approvals_email_idx
  on public.signup_approvals (requester_email, created_at desc);

create index if not exists signup_approvals_open_idx
  on public.signup_approvals (requester_email)
  where consumed_at is null;

alter table public.signup_approvals enable row level security;

-- Sem policies: ninguém autenticado/anon lê ou escreve.
-- Service role (API) ignora RLS.

grant select, insert, update, delete on public.signup_approvals to service_role;
