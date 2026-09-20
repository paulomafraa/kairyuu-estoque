-- Evita duplicar item na caixinha quando "marcar pago" dispara mais de uma vez
-- (clique duplo / estado stale). Uma linha de venda → no máximo um item de garagem.

alter table public.customer_garage_items
  add column if not exists event_sale_line_id uuid
    references public.event_sale_lines (id) on delete set null;

create unique index if not exists garage_event_sale_line_unique
  on public.customer_garage_items (event_sale_line_id)
  where event_sale_line_id is not null;

-- Preenche vínculo em itens já ligados pela sale line (não cria novos)
update public.customer_garage_items g
set event_sale_line_id = s.id
from public.event_sale_lines s
where s.garage_item_id = g.id
  and g.event_sale_line_id is null;
