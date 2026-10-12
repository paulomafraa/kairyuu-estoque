-- Caixinhas físicas unificadas (o saco grande) como lista própria.
-- Uma caixinha pode ficar sem cliente, com um ou com vários (ex.: casal).
-- Também marca "colocado na caixa geral" por carta do evento.
-- Pode rodar mais de uma vez. Rodar no SQL Editor do Supabase.

create table if not exists public.physical_boxes (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create unique index if not exists physical_boxes_label_uidx
  on public.physical_boxes (lower(label));

alter table public.physical_boxes enable row level security;

drop policy if exists "staff all physical_boxes" on public.physical_boxes;
create policy "staff all physical_boxes" on public.physical_boxes
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.physical_boxes to authenticated;

alter table public.customers
  add column if not exists physical_box_id uuid
    references public.physical_boxes (id) on delete set null;

create index if not exists customers_physical_box_id_idx
  on public.customers (physical_box_id);

alter table public.event_sale_lines
  add column if not exists boxed boolean not null default false;
alter table public.event_sale_lines
  add column if not exists boxed_at timestamptz;
alter table public.event_sale_lines
  add column if not exists boxed_by uuid references public.profiles (id);

-- Registros feitos na versão anterior (caixinha marcada direto no cliente).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'customers' and column_name = 'physical_box'
  ) then
    insert into public.physical_boxes (label, created_at, created_by)
    select coalesce(nullif(trim(c.physical_box_label), ''), c.name),
           coalesce(c.physical_box_since, now()),
           c.physical_box_by
    from public.customers c
    where c.physical_box and c.physical_box_id is null
    on conflict (lower(label)) do nothing;

    update public.customers c
    set physical_box_id = b.id
    from public.physical_boxes b
    where c.physical_box and c.physical_box_id is null
      and lower(b.label) = lower(coalesce(nullif(trim(c.physical_box_label), ''), c.name));
  end if;
end $$;

-- Cadastro inicial (162 caixinhas, nomes exatamente como na lista).
insert into public.physical_boxes (label)
values
  ('evelynn'),
  ('jess'),
  ('Luciana santos'),
  ('sorin'),
  ('roberta santos'),
  ('ana beatriz'),
  ('vitor Abrantes silva'),
  ('henrrison huander'),
  ('kaique'),
  ('silvio filho'),
  ('Guilherme lopes'),
  ('thales h piotto'),
  ('kelly'),
  ('adriano de Maciel'),
  ('julia aimi'),
  ('dener'),
  ('Karina'),
  ('douglas m'),
  ('Priscila chagas'),
  ('lasb'),
  ('Pedro amaral'),
  ('looh'),
  ('remulo'),
  ('douglas menochelli'),
  ('claudio recine'),
  ('Ivan matos'),
  ('junior tatuador'),
  ('dra bianca wanderley'),
  ('luca'),
  ('noob tcg'),
  ('lucas (67)'),
  ('rodrigo tenaglia'),
  ('dr bernardo'),
  ('carolina Abranches'),
  ('luna'),
  ('rhaysla'),
  ('Gabriel victor bolsa'),
  ('namie'),
  ('emanuele ramos'),
  ('luis bolo (confeiteiro)'),
  ('beatriz souberc'),
  ('felipe chadud'),
  ('Rafael dizero'),
  ('Laryssa bedin'),
  ('felipe brum'),
  ('luiz edling'),
  ('adelle'),
  ('carol toledo'),
  ('Thiago Albuquerque'),
  ('lucas wendel'),
  ('luis philipe'),
  ('Pedro felix'),
  ('Daniel martinez'),
  ('geovanna morango'),
  ('jm energia solar'),
  ('Gilberto av junior'),
  ('Valmir junior'),
  ('Pedro faca pizza'),
  ('julio cesar'),
  ('igor prates'),
  ('sofia 11'),
  ('danilo franco'),
  ('ana luisa jm prata'),
  ('carla okada'),
  ('Jorge alvez'),
  ('renan troina'),
  ('vitor kenji'),
  ('welington carvalho'),
  ('amaria'),
  ('dart'),
  ('Eduardo wolf'),
  ('mauricio bezerra'),
  ('joao tcg'),
  ('amandinha'),
  ('flavio'),
  ('tiago galego'),
  ('dayana r Fernandes'),
  ('vinicius coelho'),
  ('Fabiano ddd 31'),
  ('icaro monteiro'),
  ('jian oliveira'),
  ('wiliam cardoso'),
  ('Gustavo ralha'),
  ('douglas ddd 21'),
  ('douglas R.'),
  ('wallace'),
  ('junior rocha'),
  ('higor'),
  ('Nathalia martins'),
  ('Gabriel ribeiro'),
  ('patrícia'),
  ('benvenido'),
  ('André (73)'),
  ('jean betiati'),
  ('pyetra lima'),
  ('laura'),
  ('fefe UCS'),
  ('Erick'),
  ('vinicius nascimento'),
  ('tarso'),
  ('bruno M.'),
  ('dartagnan Maciel'),
  ('maria Eduarda pires'),
  ('rhaick'),
  ('Dalila'),
  ('alif santos'),
  ('iazmin'),
  ('elle'),
  ('Henrique 1 ddd (11)'),
  ('Fernanda serradura'),
  ('pedro felipe'),
  ('luiz botelho'),
  ('vicentini ddd 14'),
  ('rafa e yuyu'),
  ('wang (musica)'),
  ('carlos segundo'),
  ('luiza moreira'),
  ('Thiago viana'),
  ('joao Miguel'),
  ('WB'),
  ('junin Camargo'),
  ('jasbin'),
  ('Rafael penfold'),
  ('Fernando ddd 21'),
  ('William mendes'),
  ('Matheus ddd (65)'),
  ('agnaldo jr'),
  ('ana luiza alves'),
  ('Gregory'),
  ('Humberto'),
  ('vitor hugo vidinhas'),
  ('Matheus bezzerra'),
  ('raphael silva'),
  ('Guilherme ddd 83'),
  ('Guilherme candido'),
  ('Gabriel (21) 960154926'),
  ('sorriso (11) 912933009'),
  ('dudinha UCS'),
  ('Arthur (14) 996172888'),
  ('lucas R'),
  ('ariel 2'),
  ('Daniel Andrade'),
  ('beatriz martins'),
  ('bianca'),
  ('Julia dias'),
  ('camila steiner'),
  ('Lucas O.'),
  ('amanda rodrigues'),
  ('camila'),
  ('victor ddd (43)'),
  ('victo (62) 84852541'),
  ('italo batista'),
  ('joão pedro ddd 62'),
  ('juliana tavares'),
  ('Henrique 2 ddd (11)'),
  ('Gabriel (11) 986707494'),
  ('juliano do kriss'),
  ('Gustavo chrysaor'),
  ('flávia'),
  ('marcela e Suzuki'),
  ('barbara moschen'),
  ('lucas gomes')
on conflict (lower(label)) do nothing;

select count(*) as total_caixinhas from public.physical_boxes;
