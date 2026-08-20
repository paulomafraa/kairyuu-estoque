-- Kairyuu Estoque — schema inicial
-- Cole no SQL Editor do Supabase (projeto novo) e execute.

create extension if not exists "pgcrypto";

-- Perfis da staff (1:1 com auth.users)
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  set_code text not null default '',
  condition text not null default 'NM',
  qty_in_stock integer not null default 0 check (qty_in_stock >= 0),
  orderable boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cards_name_idx on public.cards (name);
create index cards_set_code_idx on public.cards (set_code);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null default '',
  phone_digits text,
  source text not null default 'manual'
    check (source in ('manual', 'whatsapp_group')),
  notes text not null default '',
  created_at timestamptz not null default now()
);

create index customers_name_idx on public.customers (name);
create unique index customers_phone_digits_uidx
  on public.customers (phone_digits);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'open'
    check (status in ('open', 'closing', 'closed')),
  owner_id uuid references public.profiles (id),
  notes text not null default '',
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create table public.event_allocations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  card_id uuid not null references public.cards (id),
  qty integer not null check (qty > 0),
  created_at timestamptz not null default now(),
  unique (event_id, card_id)
);

create table public.event_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  card_id uuid not null references public.cards (id),
  customer_id uuid not null references public.customers (id),
  qty integer not null check (qty > 0),
  unit_price numeric(12, 2),
  status text not null default 'indicated'
    check (status in ('indicated', 'confirmed')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table public.customer_items (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  card_id uuid not null references public.cards (id),
  qty integer not null check (qty > 0),
  origin_type text not null
    check (origin_type in ('event', 'direct_sale', 'encomenda')),
  event_id uuid references public.events (id),
  order_id uuid,
  unit_price numeric(12, 2),
  notes text not null default '',
  acquired_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id),
  card_id uuid references public.cards (id),
  card_name text not null,
  qty integer not null default 1 check (qty > 0),
  status text not null default 'pedido_japao'
    check (status in (
      'pedido_japao',
      'chegou_brasil',
      'sede_kairyuu',
      'enviado',
      'entregue'
    )),
  stocked boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_items
  add constraint customer_items_order_id_fkey
  foreign key (order_id) references public.orders (id);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  qty_delta integer not null,
  reason text not null check (reason in (
    'allocation',
    'return',
    'direct_sale',
    'arrival',
    'adjustment',
    'encomenda_exit'
  )),
  event_id uuid references public.events (id),
  customer_id uuid references public.customers (id),
  order_id uuid references public.orders (id),
  user_id uuid references public.profiles (id),
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- Perfil automático no signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    'staff'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at helper
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger cards_touch before update on public.cards
  for each row execute function public.touch_updated_at();

create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- Alocar carta do estoque geral para a caixa do evento
create or replace function public.allocate_to_event(
  p_event_id uuid,
  p_card_id uuid,
  p_qty integer,
  p_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_stock integer;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantidade inválida';
  end if;

  select status into v_status from events where id = p_event_id for update;
  if v_status is null then
    raise exception 'Evento não encontrado';
  end if;
  if v_status <> 'open' then
    raise exception 'Só é possível alocar em evento aberto';
  end if;

  select qty_in_stock into v_stock from cards where id = p_card_id for update;
  if v_stock is null then
    raise exception 'Carta não encontrada';
  end if;
  if v_stock < p_qty then
    raise exception 'Estoque insuficiente (% disponível)', v_stock;
  end if;

  update cards set qty_in_stock = qty_in_stock - p_qty where id = p_card_id;

  insert into event_allocations (event_id, card_id, qty)
  values (p_event_id, p_card_id, p_qty)
  on conflict (event_id, card_id)
  do update set qty = event_allocations.qty + excluded.qty;

  insert into stock_movements (card_id, qty_delta, reason, event_id, user_id, notes)
  values (p_card_id, -p_qty, 'allocation', p_event_id, p_user_id, 'Alocado para caixa do evento');
end;
$$;

-- Devolver unidades da caixa para o estoque geral
create or replace function public.return_from_event(
  p_event_id uuid,
  p_card_id uuid,
  p_qty integer,
  p_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_alloc integer;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantidade inválida';
  end if;

  select status into v_status from events where id = p_event_id for update;
  if v_status is null then
    raise exception 'Evento não encontrado';
  end if;
  if v_status = 'closed' then
    raise exception 'Evento já fechado';
  end if;

  select qty into v_alloc
  from event_allocations
  where event_id = p_event_id and card_id = p_card_id
  for update;

  if v_alloc is null or v_alloc < p_qty then
    raise exception 'Quantidade na caixa insuficiente';
  end if;

  if v_alloc = p_qty then
    delete from event_allocations
    where event_id = p_event_id and card_id = p_card_id;
  else
    update event_allocations
    set qty = qty - p_qty
    where event_id = p_event_id and card_id = p_card_id;
  end if;

  update cards set qty_in_stock = qty_in_stock + p_qty where id = p_card_id;

  insert into stock_movements (card_id, qty_delta, reason, event_id, user_id, notes)
  values (p_card_id, p_qty, 'return', p_event_id, p_user_id, 'Devolvido ao estoque geral');
end;
$$;

-- Confirmar atribuição: sai da caixa, entra no histórico do cliente
create or replace function public.confirm_assignment(
  p_assignment_id uuid,
  p_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a event_assignments%rowtype;
  v_status text;
  v_alloc integer;
begin
  select * into a from event_assignments where id = p_assignment_id for update;
  if a.id is null then
    raise exception 'Atribuição não encontrada';
  end if;
  if a.status = 'confirmed' then
    raise exception 'Já confirmada';
  end if;

  select status into v_status from events where id = a.event_id for update;
  if v_status = 'closed' then
    raise exception 'Evento já fechado';
  end if;
  if v_status = 'open' then
    update events set status = 'closing' where id = a.event_id;
  end if;

  select qty into v_alloc
  from event_allocations
  where event_id = a.event_id and card_id = a.card_id
  for update;

  if v_alloc is null or v_alloc < a.qty then
    raise exception 'Caixa não tem quantidade suficiente para confirmar';
  end if;

  if v_alloc = a.qty then
    delete from event_allocations
    where event_id = a.event_id and card_id = a.card_id;
  else
    update event_allocations
    set qty = qty - a.qty
    where event_id = a.event_id and card_id = a.card_id;
  end if;

  update event_assignments
  set status = 'confirmed', confirmed_at = now()
  where id = a.id;

  insert into customer_items (
    customer_id, card_id, qty, origin_type, event_id, unit_price, notes
  ) values (
    a.customer_id, a.card_id, a.qty, 'event', a.event_id, a.unit_price,
    'Confirmado no fechamento do evento'
  );

  insert into stock_movements (
    card_id, qty_delta, reason, event_id, customer_id, user_id, notes
  ) values (
    a.card_id, 0, 'allocation', a.event_id, a.customer_id, p_user_id,
    'Confirmado para cliente (já estava na caixa)'
  );
end;
$$;

-- Fechar evento: devolve o que sobrou na caixa e trava
create or replace function public.close_event(
  p_event_id uuid,
  p_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_status text;
  v_pending integer;
begin
  select status into v_status from events where id = p_event_id for update;
  if v_status is null then
    raise exception 'Evento não encontrado';
  end if;
  if v_status = 'closed' then
    raise exception 'Evento já fechado';
  end if;

  select count(*) into v_pending
  from event_assignments
  where event_id = p_event_id and status = 'indicated';

  if v_pending > 0 then
    raise exception 'Ainda há % atribuição(ões) só indicada(s). Confirme ou remova antes de fechar.', v_pending;
  end if;

  for r in
    select card_id, qty from event_allocations where event_id = p_event_id
  loop
    perform return_from_event(p_event_id, r.card_id, r.qty, p_user_id);
  end loop;

  update events
  set status = 'closed', closed_at = now()
  where id = p_event_id;
end;
$$;

-- Venda direta: baixa estoque + histórico do cliente
create or replace function public.direct_sale(
  p_customer_id uuid,
  p_card_id uuid,
  p_qty integer,
  p_unit_price numeric default null,
  p_notes text default '',
  p_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock integer;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantidade inválida';
  end if;

  select qty_in_stock into v_stock from cards where id = p_card_id for update;
  if v_stock is null then
    raise exception 'Carta não encontrada';
  end if;
  if v_stock < p_qty then
    raise exception 'Estoque insuficiente';
  end if;

  update cards set qty_in_stock = qty_in_stock - p_qty where id = p_card_id;

  insert into customer_items (
    customer_id, card_id, qty, origin_type, unit_price, notes
  ) values (
    p_customer_id, p_card_id, p_qty, 'direct_sale', p_unit_price, coalesce(p_notes, '')
  );

  insert into stock_movements (
    card_id, qty_delta, reason, customer_id, user_id, notes
  ) values (
    p_card_id, -p_qty, 'direct_sale', p_customer_id, p_user_id, coalesce(p_notes, '')
  );
end;
$$;

-- Chegada na sede: entra no estoque (uma vez)
create or replace function public.mark_order_arrived_hq(
  p_order_id uuid,
  p_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if o.id is null then
    raise exception 'Encomenda não encontrada';
  end if;
  if o.stocked then
    update orders set status = 'sede_kairyuu' where id = o.id;
    return;
  end if;
  if o.card_id is null then
    raise exception 'Vincule uma carta do catálogo antes de entrar no estoque';
  end if;

  update cards set qty_in_stock = qty_in_stock + o.qty where id = o.card_id;

  update orders
  set status = 'sede_kairyuu', stocked = true
  where id = o.id;

  insert into stock_movements (
    card_id, qty_delta, reason, order_id, customer_id, user_id, notes
  ) values (
    o.card_id, o.qty, 'arrival', o.id, o.customer_id, p_user_id,
    'Chegada na sede Kairyuu'
  );
end;
$$;

-- Enviar encomenda ao cliente (baixa estoque + histórico)
create or replace function public.ship_order_to_customer(
  p_order_id uuid,
  p_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o orders%rowtype;
  v_stock integer;
begin
  select * into o from orders where id = p_order_id for update;
  if o.id is null then
    raise exception 'Encomenda não encontrada';
  end if;
  if o.status not in ('sede_kairyuu', 'enviado') then
    raise exception 'Encomenda precisa estar na sede antes do envio';
  end if;
  if not o.stocked or o.card_id is null then
    raise exception 'Encomenda ainda não entrou no estoque';
  end if;

  select qty_in_stock into v_stock from cards where id = o.card_id for update;
  if v_stock < o.qty then
    raise exception 'Estoque insuficiente para envio';
  end if;

  update cards set qty_in_stock = qty_in_stock - o.qty where id = o.card_id;

  update orders set status = 'enviado' where id = o.id;

  insert into customer_items (
    customer_id, card_id, qty, origin_type, order_id, notes
  ) values (
    o.customer_id, o.card_id, o.qty, 'encomenda', o.id, 'Enviado ao cliente'
  );

  insert into stock_movements (
    card_id, qty_delta, reason, order_id, customer_id, user_id, notes
  ) values (
    o.card_id, -o.qty, 'encomenda_exit', o.id, o.customer_id, p_user_id,
    'Enviado ao cliente'
  );
end;
$$;

-- RLS
alter table public.profiles enable row level security;
alter table public.cards enable row level security;
alter table public.customers enable row level security;
alter table public.events enable row level security;
alter table public.event_allocations enable row level security;
alter table public.event_assignments enable row level security;
alter table public.customer_items enable row level security;
alter table public.orders enable row level security;
alter table public.stock_movements enable row level security;

create policy "staff read profiles" on public.profiles
  for select to authenticated using (true);
create policy "staff update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id);

create policy "staff all cards" on public.cards
  for all to authenticated using (true) with check (true);
create policy "staff all customers" on public.customers
  for all to authenticated using (true) with check (true);
create policy "staff all events" on public.events
  for all to authenticated using (true) with check (true);
create policy "staff all allocations" on public.event_allocations
  for all to authenticated using (true) with check (true);
create policy "staff all assignments" on public.event_assignments
  for all to authenticated using (true) with check (true);
create policy "staff all customer_items" on public.customer_items
  for all to authenticated using (true) with check (true);
create policy "staff all orders" on public.orders
  for all to authenticated using (true) with check (true);
create policy "staff all movements" on public.stock_movements
  for all to authenticated using (true) with check (true);

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on function public.allocate_to_event to authenticated;
grant execute on function public.return_from_event to authenticated;
grant execute on function public.confirm_assignment to authenticated;
grant execute on function public.close_event to authenticated;
grant execute on function public.direct_sale to authenticated;
grant execute on function public.mark_order_arrived_hq to authenticated;
grant execute on function public.ship_order_to_customer to authenticated;
