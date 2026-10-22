-- Vincula só as 78 caixinhas já confirmadas.
-- Casa pelo telefone da ficha. Não move quem já está em outra caixinha.
-- Rodar no SQL Editor do Supabase. Pode rodar de novo.

begin;

create temp table box_pairs (
  label text not null,
  phone text not null
);

insert into box_pairs (label, phone) values
  ('adriano de Maciel', '555191190404'),
  ('agnaldo jr', '556198503377'),
  ('amanda rodrigues', '5511976760920'),
  ('amandinha', '553498664976'),
  ('amaria', '5521994593737'),
  ('ana luiza alves', '553291992940'),
  ('Arthur (14) 996172888', '5514996172888'),
  ('beatriz martins', '5521972100202'),
  ('camila', '5511991211973'),
  ('camila steiner', '553194224326'),
  ('carolina Abranches', '5521998503005'),
  ('claudio recine', '5511993537237'),
  ('Daniel Andrade', '5521976350320'),
  ('Daniel martinez', '555199193322'),
  ('dart', '5511932179766'),
  ('dayana r Fernandes', '553388275247'),
  ('douglas m', '554199809735'),
  ('douglas menochelli', '5511987574456'),
  ('douglas R.', '5511983525342'),
  ('dr bernardo', '553198266589'),
  ('dra bianca wanderley', '558398467306'),
  ('Eduardo wolf', '554199000162'),
  ('emanuele ramos', '554396921362'),
  ('evelynn', '5521985395381'),
  ('felipe chadud', '5521993219119'),
  ('flávia', '554191554444'),
  ('Gabriel (11) 986707494', '5511986707494'),
  ('Gabriel (21) 960154926', '5521960154926'),
  ('Gabriel ribeiro', '5521996909710'),
  ('Gilberto av junior', '557592316575'),
  ('Guilherme candido', '553291985465'),
  ('Guilherme lopes', '558398219863'),
  ('Gustavo ralha', '5521995698370'),
  ('henrrison huander', '553197611175'),
  ('higor', '553197501263'),
  ('icaro monteiro', '5512981025325'),
  ('Ivan matos', '5521991067462'),
  ('jess', '5511987644560'),
  ('jian oliveira', '556281082039'),
  ('joao Miguel', '5521980211481'),
  ('julia aimi', '559291891205'),
  ('juliana tavares', '5522992623798'),
  ('julio cesar', '553488688610'),
  ('kaique', '5511989720670'),
  ('Karina', '5511999515525'),
  ('kelly', '554791991442'),
  ('Laryssa bedin', '5512997999906'),
  ('lasb', '59169180608'),
  ('laura', '555592071507'),
  ('looh', '5521969514128'),
  ('luca', '5521971521812'),
  ('lucas gomes', '5515988103288'),
  ('Luciana santos', '5511987765678'),
  ('luis philipe', '5521979743609'),
  ('luiz edling', '554288007444'),
  ('mauricio bezerra', '5511951143414'),
  ('noob tcg', '5514999050588'),
  ('Pedro amaral', '554499500210'),
  ('Pedro felix', '5517997180793'),
  ('pedro felipe', '5511970833318'),
  ('Priscila chagas', '5521996123204'),
  ('Rafael dizero', '5511968635027'),
  ('Rafael penfold', '5521980376969'),
  ('remulo', '553184578491'),
  ('roberta santos', '556198200702'),
  ('rodrigo tenaglia', '5511976091228'),
  ('silvio filho', '554388282722'),
  ('sorin', '554792265415'),
  ('sorriso (11) 912933009', '5511912933009'),
  ('tarso', '5521986666081'),
  ('thales h piotto', '554599277870'),
  ('Thiago Albuquerque', '5521980740999'),
  ('Valmir junior', '5519982188049'),
  ('victo (62) 84852541', '556284852541'),
  ('vinicius coelho', '5511982529678'),
  ('vitor Abrantes silva', '5511996915353'),
  ('vitor hugo vidinhas', '5521979340918'),
  ('wallace', '553496665869');

create temp table box_hits as
with cust as (
  select
    id,
    name,
    physical_box_id,
    regexp_replace(coalesce(phone_digits, ''), '\D', '', 'g') as dig_idx,
    regexp_replace(coalesce(phone, ''), '\D', '', 'g') as dig_phone
  from public.customers
),
raw as (
  select
    p.label,
    p.phone,
    b.id as box_id,
    c.id as customer_id,
    c.name as customer_name,
    c.physical_box_id
  from box_pairs p
  left join public.physical_boxes b
    on lower(b.label) = lower(p.label)
  left join cust c
    on b.id is not null
   and (
     c.dig_idx = p.phone
     or c.dig_phone = p.phone
     or (
       p.phone like '55%'
       and (
         c.dig_idx = substr(p.phone, 3)
         or c.dig_phone = substr(p.phone, 3)
       )
     )
   )
)
select distinct on (label, customer_id)
  label,
  phone,
  box_id,
  customer_id,
  customer_name,
  physical_box_id
from raw
order by label, customer_id;

create temp table box_plan as
select
  h.*,
  count(h.customer_id) over (partition by h.label) as hits,
  case
    when h.box_id is null then 'caixinha nao encontrada'
    when h.customer_id is null then 'cliente nao encontrado'
    when count(h.customer_id) over (partition by h.label) > 1 then 'mais de um cliente'
    when h.physical_box_id is not null and h.physical_box_id <> h.box_id then 'ja estava em outra caixinha'
    when h.physical_box_id = h.box_id then 'ja estava nesta caixinha'
    else 'vinculado'
  end as resultado
from box_hits h;

update public.customers c
set physical_box_id = p.box_id
from box_plan p
where c.id = p.customer_id
  and p.resultado = 'vinculado';

select resultado, count(*) as qtd
from box_plan
group by resultado
order by resultado;

select label as caixinha, customer_name as cliente, phone as telefone, resultado
from box_plan
order by resultado, label;

commit;
