-- Garagem do cliente: itens, notas, fotos
-- Rodar no SQL Editor do Supabase.

-- Itens associados ao cliente (não depende do estoque livre da loja)
create table if not exists public.customer_garage_items (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  title text not null,
  category text not null default 'outro'
    check (category in ('carta', 'caixa', 'deck', 'sleeve', 'acessorio', 'outro')),
  qty integer not null check (qty > 0),
  qty_with_store integer not null default 0 check (qty_with_store >= 0),
  qty_sent integer not null default 0 check (qty_sent >= 0),
  qty_delivered integer not null default 0 check (qty_delivered >= 0),
  status text not null default 'in_garage'
    check (status in ('reserved', 'in_garage', 'shipped', 'delivered', 'cancelled')),
  reserved_until date,
  origin text not null default 'compra_direta'
    check (origin in ('leilao', 'encomenda', 'compra_direta', 'evento', 'outro')),
  event_name text not null default '',
  event_date date,
  unit_price numeric(12, 2),
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id),
  cancel_reason text not null default '',
  constraint garage_qty_parts check (
    qty_with_store + qty_sent + qty_delivered = qty
  )
);

create index if not exists garage_customer_idx
  on public.customer_garage_items (customer_id);
create index if not exists garage_status_idx
  on public.customer_garage_items (status);

create table if not exists public.customer_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create index if not exists customer_notes_customer_idx
  on public.customer_notes (customer_id, created_at desc);

create table if not exists public.customer_photos (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  storage_path text not null,
  public_url text not null default '',
  caption text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create index if not exists customer_photos_customer_idx
  on public.customer_photos (customer_id, created_at desc);

-- Log simples de ações na garagem
create table if not exists public.customer_garage_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  item_id uuid references public.customer_garage_items (id) on delete set null,
  action text not null,
  detail text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create or replace function public.touch_garage_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists garage_touch on public.customer_garage_items;
create trigger garage_touch
  before update on public.customer_garage_items
  for each row execute function public.touch_garage_updated_at();

alter table public.customer_garage_items enable row level security;
alter table public.customer_notes enable row level security;
alter table public.customer_photos enable row level security;
alter table public.customer_garage_events enable row level security;

drop policy if exists "staff all garage" on public.customer_garage_items;
create policy "staff all garage" on public.customer_garage_items
  for all to authenticated using (true) with check (true);

drop policy if exists "staff all notes" on public.customer_notes;
create policy "staff all notes" on public.customer_notes
  for all to authenticated using (true) with check (true);

drop policy if exists "staff all photos" on public.customer_photos;
create policy "staff all photos" on public.customer_photos
  for all to authenticated using (true) with check (true);

drop policy if exists "staff all garage events" on public.customer_garage_events;
create policy "staff all garage events" on public.customer_garage_events
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.customer_garage_items to authenticated;
grant select, insert, update, delete on public.customer_notes to authenticated;
grant select, insert, update, delete on public.customer_photos to authenticated;
grant select, insert, update, delete on public.customer_garage_events to authenticated;

-- Bucket de fotos (rode no SQL; se falhar, crie o bucket "customer-photos" no painel Storage)
insert into storage.buckets (id, name, public)
values ('customer-photos', 'customer-photos', true)
on conflict (id) do nothing;

drop policy if exists "staff read customer photos" on storage.objects;
create policy "staff read customer photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'customer-photos');

drop policy if exists "staff upload customer photos" on storage.objects;
create policy "staff upload customer photos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'customer-photos');

drop policy if exists "staff update customer photos" on storage.objects;
create policy "staff update customer photos"
  on storage.objects for update to authenticated
  using (bucket_id = 'customer-photos');

drop policy if exists "staff delete customer photos" on storage.objects;
create policy "staff delete customer photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'customer-photos');

-- Leitura pública das URLs (bucket public)
drop policy if exists "public read customer photos" on storage.objects;
create policy "public read customer photos"
  on storage.objects for select to public
  using (bucket_id = 'customer-photos');
