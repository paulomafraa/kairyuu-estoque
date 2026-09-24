/** Templates de cobrança WhatsApp (leilão / encomenda). */

const MESES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

export function formatDiaLongo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const day = String(d.getDate()).padStart(2, "0");
  return `${day} de ${MESES[d.getMonth()]}`;
}

export function formatDiaCurto(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
}

export function greetingName(
  name: string,
  phone: string,
  looksLikePhone: (n: string) => boolean,
): string {
  const n = (name || "").trim();
  const p = (phone || "").trim();
  if (n && !looksLikePhone(n)) return n;
  if (p) return `@${p.replace(/\D/g, "") || p}`;
  if (n) return `@${n}`;
  return "@cliente";
}

export type BillingLine = {
  product_title: string;
  unit_price: number | null;
  qty: number;
};

/** Tira o sufixo de preço do título da enquete (ex.: "Zorua (072/064) - R$ 12,50"). */
export function stripCardPriceSuffix(title: string): string {
  return (title || "")
    .replace(/\s*[-–—]\s*R\$\s*[\d.]+(?:,\d{1,2})?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDiaJa(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export type EncomendaPedidoItem = {
  title: string;
  qty: number;
};

/** Mensagens prontas do pedido da rodada (pt-BR e japonês). */
export function buildEncomendaPedidoMessages(opts: {
  eventDate: string | null | undefined;
  items: EncomendaPedidoItem[];
  titleJa?: (title: string) => string;
}): { pt: string; ja: string } {
  const items = opts.items
    .map((it) => ({
      title: stripCardPriceSuffix(it.title),
      qty: Number(it.qty) > 0 ? Number(it.qty) : 1,
    }))
    .filter((it) => it.title);
  const modelos = items.length;
  const unidades = items.reduce((n, it) => n + it.qty, 0);
  const toJa = opts.titleJa || ((t: string) => t);
  const rowsPt = items.map((it) => `• ${it.title} × ${it.qty}`);
  const rowsJa = items.map((it) => `• ${toJa(it.title)} × ${it.qty}`);
  const diaPt = formatDiaLongo(opts.eventDate);
  const diaJa = formatDiaJa(opts.eventDate);

  const pt = [
    `Pedido da rodada de encomendas${diaPt !== "—" ? ` — ${diaPt}` : ""}`,
    ``,
    ...rowsPt,
    ``,
    `Total: ${modelos} modelo(s) · ${unidades} unidade(s)`,
  ].join("\n");

  const ja = [
    `委託ラウンド注文${diaJa ? `（${diaJa}）` : ""}`,
    ``,
    ...rowsJa,
    ``,
    `合計：${modelos}種・${unidades}枚`,
  ].join("\n");

  return { pt, ja };
}

export function formatMoneyBr(n: number): string {
  return n.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function buildBillingMessage(opts: {
  kind: "leilao" | "encomenda" | string;
  customerName: string;
  eventDate: string | null | undefined;
  paymentDue: string | null | undefined;
  lines: BillingLine[];
}): { text: string; missingPrice: number; total: number } {
  const lines = opts.lines.filter((l) => (l.qty || 1) > 0);
  let total = 0;
  let missingPrice = 0;
  const rows: string[] = [];
  for (const l of lines) {
    const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
    const price = l.unit_price != null ? Number(l.unit_price) : null;
    if (price == null || !Number.isFinite(price)) {
      missingPrice += 1;
      rows.push(
        qty > 1
          ? `${l.product_title} ×${qty} — R$ ?`
          : `${l.product_title} — R$ ?`,
      );
    } else {
      total += price * qty;
      rows.push(
        qty > 1
          ? `${l.product_title} ×${qty} — R$ ${formatMoneyBr(price * qty)}`
          : `${l.product_title} — R$ ${formatMoneyBr(price)}`,
      );
    }
  }

  const dia = formatDiaLongo(opts.eventDate);
  const prazo = formatDiaCurto(opts.paymentDue);
  const isEnc = opts.kind === "encomenda";

  const text = isEnc
    ? [
        `Olá, ${opts.customerName}! Tudo bem? ☁️💙`,
        ``,
        `A Kairyuu TCG agradece pela sua participação na Rodada de Encomendas! 💕`,
        ``,
        `Resumo das suas encomendas do dia ${dia}:`,
        ...rows,
        ``,
        `Total a pagar: R$ ${formatMoneyBr(total)}`,
        ``,
        `🗓️ Pagamento até: ${prazo}`,
        ``,
        `O pagamento pode ser por pix ou em 12x por cartão com o juros da maquininha.`,
        ``,
        `Sobre a entrega:`,
        `Nos avise caso queira envio, se não, pode acumular conosco junto de outras encomendas! ✨️`,
        ``,
        `Lembrando: o prazo de envio das encomendas é de 60 a 90 dias a partir da confirmação do pagamento.`,
      ].join("\n")
    : [
        `Olá, ${opts.customerName}! Tudo bem? ☁️💙`,
        ``,
        `A Kairyuu TCG agradece pela sua participação no Leilão! 💕`,
        ``,
        `Resumo dos Arremates do dia ${dia}:`,
        ...rows,
        ``,
        `Total a pagar: R$ ${formatMoneyBr(total)}`,
        ``,
        `🗓️ Pagamento até: ${prazo}`,
        ``,
        `O pagamento pode ser por pix ou em 12x por cartão com o juros da maquininha.`,
        ``,
        `Sobre a entrega:`,
        `Nos avise caso queira envio, se não, pode acumular conosco junto de outros leilões por até 2 meses ✨️`,
      ].join("\n");

  return { text, missingPrice, total };
}

export type CombinedBillingEvent = {
  kind: "leilao" | "encomenda" | string;
  eventName: string;
  eventDate: string | null | undefined;
  paymentDue: string | null | undefined;
  lines: BillingLine[];
};

/** Cobrança unificada: vários eventos, blocos separados, total geral. */
export function buildCombinedBillingMessage(opts: {
  customerName: string;
  events: CombinedBillingEvent[];
}): { text: string; missingPrice: number; total: number } {
  const blocks: string[] = [];
  let total = 0;
  let missingPrice = 0;
  let hasLeilao = false;
  let hasEncomenda = false;

  for (const ev of opts.events) {
    const lines = ev.lines.filter((l) => (l.qty || 1) > 0);
    if (!lines.length) continue;
    if (ev.kind === "encomenda") hasEncomenda = true;
    else if (ev.kind === "leilao") hasLeilao = true;

    let sub = 0;
    const rows: string[] = [];
    for (const l of lines) {
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
      const price = l.unit_price != null ? Number(l.unit_price) : null;
      if (price == null || !Number.isFinite(price)) {
        missingPrice += 1;
        rows.push(
          qty > 1
            ? `${l.product_title} ×${qty} — R$ ?`
            : `${l.product_title} — R$ ?`,
        );
      } else {
        sub += price * qty;
        rows.push(
          qty > 1
            ? `${l.product_title} ×${qty} — R$ ${formatMoneyBr(price * qty)}`
            : `${l.product_title} — R$ ${formatMoneyBr(price)}`,
        );
      }
    }
    total += sub;

    const kindLabel =
      ev.kind === "encomenda"
        ? "Encomenda"
        : ev.kind === "leilao"
          ? "Leilão"
          : ev.kind || "Evento";
    const dia = formatDiaLongo(ev.eventDate);
    const prazo = formatDiaCurto(ev.paymentDue);
    const header = ev.eventName
      ? `—— ${kindLabel} · ${ev.eventName} · dia ${dia} ——`
      : `—— ${kindLabel} · dia ${dia} ——`;

    blocks.push(
      [
        header,
        ...rows,
        `Subtotal: R$ ${formatMoneyBr(sub)}`,
        `🗓️ Pagamento até: ${prazo}`,
      ].join("\n"),
    );
  }

  const entrega: string[] = ["Sobre a entrega:"];
  if (hasLeilao) {
    entrega.push(
      "• Leilão: nos avise caso queira envio; se não, pode acumular conosco junto de outros leilões por até 2 meses ✨️",
    );
  }
  if (hasEncomenda) {
    entrega.push(
      "• Encomenda: nos avise caso queira envio; se não, pode acumular conosco junto de outras encomendas! ✨️",
    );
    entrega.push(
      "• Lembrando: o prazo de envio das encomendas é de 60 a 90 dias a partir da confirmação do pagamento.",
    );
  }
  if (!hasLeilao && !hasEncomenda) {
    entrega.push(
      "Nos avise caso queira envio, se não, pode acumular conosco ✨️",
    );
  }

  const text = [
    `Olá, ${opts.customerName}! Tudo bem? ☁️💙`,
    ``,
    `A Kairyuu TCG agradece! Segue o resumo do que está em aberto com a gente 💕`,
    ``,
    ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])),
    ``,
    `Total geral a pagar: R$ ${formatMoneyBr(total)}`,
    ``,
    `O pagamento pode ser por pix ou em 12x por cartão com o juros da maquininha.`,
    ``,
    ...entrega,
  ].join("\n");

  return { text, missingPrice, total };
}

/** Dias desde a data de pagamento (negativo = futuro). */
export function daysSincePayment(
  paidAt: string | null | undefined,
  now = new Date(),
): number | null {
  if (!paidAt) return null;
  const d = new Date(paidAt);
  if (Number.isNaN(d.getTime())) return null;
  const a = new Date(now);
  a.setHours(12, 0, 0, 0);
  d.setHours(12, 0, 0, 0);
  return Math.round((a.getTime() - d.getTime()) / 86_400_000);
}

/** Limite de acumulação na loja para cartas de leilão (≈ 2 meses). */
export const LEILAO_GARAGE_LIMIT_DAYS = 60;
/** Aviso amarelo: faltam ~10 dias pro limite. */
export const LEILAO_GARAGE_WARN_DAYS = 50;

/** Alerta de prazo de garagem do leilão (2 meses ≈ 60 dias). */
export function leilaoGarageUrgency(
  daysHeld: number | null,
): "ok" | "warn" | "overdue" | "none" {
  if (daysHeld == null) return "none";
  if (daysHeld >= LEILAO_GARAGE_LIMIT_DAYS) return "overdue";
  if (daysHeld >= LEILAO_GARAGE_WARN_DAYS) return "warn";
  return "ok";
}

/** Texto curto do prazo de leilão na loja (desde o pagamento). */
export function formatLeilaoGarageDeadline(opts: {
  daysHeld: number;
  sinceIso?: string | null;
}): {
  urgency: "ok" | "warn" | "overdue" | "none";
  sinceLabel: string;
  daysLeft: number;
  shortLabel: string;
  detailLabel: string;
} {
  const urgency = leilaoGarageUrgency(opts.daysHeld);
  const sinceLabel = formatDiaCurto(opts.sinceIso);
  const daysLeft = LEILAO_GARAGE_LIMIT_DAYS - opts.daysHeld;
  let shortLabel = `${opts.daysHeld}d na loja`;
  let detailLabel = `cartas de leilão conosco desde ${sinceLabel} · ${opts.daysHeld} dia(s)`;

  if (urgency === "overdue") {
    const late = Math.max(0, opts.daysHeld - LEILAO_GARAGE_LIMIT_DAYS);
    shortLabel =
      late > 0
        ? `Prazo estourado · ${late}d além dos 2 meses`
        : "Prazo de 2 meses estourado";
    detailLabel = `Tem cartas de leilão conosco desde ${sinceLabel}. Já passou o limite de 2 meses (${opts.daysHeld} dia(s) na loja) — pedir envio.`;
  } else if (urgency === "warn") {
    shortLabel = `Perto do prazo · faltam ${Math.max(0, daysLeft)}d`;
    detailLabel = `Tem cartas de leilão conosco desde ${sinceLabel}. Faltam ${Math.max(0, daysLeft)} dia(s) para o limite de 2 meses — avisar o cliente para pedir envio.`;
  } else {
    detailLabel = `Tem cartas de leilão conosco desde ${sinceLabel} · ${opts.daysHeld} dia(s) · faltam ${Math.max(0, daysLeft)} dia(s) para o limite de 2 meses.`;
  }

  return { urgency, sinceLabel, daysLeft, shortLabel, detailLabel };
}
