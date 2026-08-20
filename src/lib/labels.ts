import type {
  EventStatus,
  GarageCategory,
  GarageOrigin,
  GarageStatus,
  OrderStatus,
  OriginType,
} from "./types";

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  open: "Aberto",
  closing: "Fechando",
  closed: "Fechado",
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pedido_japao: "Pedido no Japão",
  chegou_brasil: "Chegou ao Brasil",
  sede_kairyuu: "Na sede Kairyuu",
  enviado: "Enviado ao cliente",
  entregue: "Entregue",
};

export const ORDER_STATUS_FLOW: OrderStatus[] = [
  "pedido_japao",
  "chegou_brasil",
  "sede_kairyuu",
  "enviado",
  "entregue",
];

export const ORIGIN_LABEL: Record<OriginType, string> = {
  event: "Evento",
  direct_sale: "Venda direta",
  encomenda: "Encomenda",
};

export const GARAGE_CATEGORY_LABEL: Record<GarageCategory, string> = {
  carta: "Carta",
  caixa: "Caixa",
  deck: "Deck",
  sleeve: "Sleeve",
  acessorio: "Acessório",
  outro: "Outro",
};

export const GARAGE_STATUS_LABEL: Record<GarageStatus, string> = {
  reserved: "Reservado",
  in_garage: "Caixinha/garagem",
  shipped: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado / estorno",
};

export const GARAGE_ORIGIN_LABEL: Record<GarageOrigin, string> = {
  leilao: "Leilão",
  encomenda: "Encomenda",
  compra_direta: "Compra direta",
  evento: "Evento",
  outro: "Outro",
};

export function cardLabel(card: {
  name: string;
  set_code?: string;
  condition?: string;
}) {
  const parts = [card.name];
  if (card.set_code) parts.push(card.set_code);
  if (card.condition) parts.push(card.condition);
  return parts.join(" · ");
}

export function formatStaffName(
  profile?: { name?: string } | null,
  fallback = "Staff",
) {
  return profile?.name?.trim() || fallback;
}
