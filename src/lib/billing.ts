/** Cobranças automáticas: tipos + montagem das mensagens (puro, roda no browser e no servidor). */

import {
  buildBillingMessage,
  buildCombinedBillingMessage,
  greetingName,
  type BillingLine,
} from "@/lib/cobranca-msg";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import { eventHappenedOn } from "@/lib/event-date";
import {
  isActiveBillableSaleLine,
  parseMoneyFromOption,
} from "@/lib/leilao-resultado";

export type BillingMode = "unificada" | "separada" | "manual";
export type BillingRunStatus = "draft" | "running" | "paused" | "stopped" | "done";
export type BillingItemStatus = "pending" | "sending" | "sent" | "failed" | "skipped";
export type BillingPaymentStatus = "none" | "hint" | "confirmed";

export type BillingRun = {
  id: string;
  name: string;
  mode: BillingMode;
  status: BillingRunStatus;
  is_test: boolean;
  event_ids: string[];
  min_interval_s: number;
  max_interval_s: number;
  next_send_at: string | null;
  last_sent_at: string | null;
  fail_streak: number;
  pause_reason: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

export type BillingItem = {
  id: string;
  run_id: string;
  position: number;
  customer_id: string | null;
  customer_name: string;
  phone_digits: string;
  text: string;
  total: number | null;
  sale_line_ids: string[];
  event_ids: string[];
  status: BillingItemStatus;
  edited: boolean;
  claimed_at: string | null;
  sent_at: string | null;
  error: string;
  wa_message_id: string;
  reply_count: number;
  last_reply_at: string | null;
  payment_status: BillingPaymentStatus;
  payment_confirmed_at: string | null;
  payment_confirmed_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingReply = {
  id: string;
  item_id: string;
  run_id: string;
  phone_digits: string;
  received_at: string;
  kind: "text" | "image" | "document" | "audio" | "video" | "sticker" | "other";
  text: string;
  media_path: string;
  mimetype: string;
  wa_message_id: string;
  created_at: string;
};

export const BILLING_STATUS_LABEL: Record<BillingRunStatus, string> = {
  draft: "Rascunho",
  running: "Enviando",
  paused: "Pausada",
  stopped: "Parada",
  done: "Concluída",
};

export const BILLING_ITEM_STATUS_LABEL: Record<BillingItemStatus, string> = {
  pending: "Na fila",
  sending: "Enviando",
  sent: "Enviada",
  failed: "Falhou",
  skipped: "Pulada",
};

/** Respostas valem por até 7 dias depois do envio. */
export const BILLING_REPLY_WINDOW_DAYS = 7;
/** Item preso em "sending" há mais que isso = bot caiu no meio. */
export const BILLING_STALE_SENDING_MS = 3 * 60_000;
/** Falhas seguidas que pausam a lista sozinha. */
export const BILLING_MAX_FAIL_STREAK = 3;

/** Linha de venda já com evento + cliente (select do Supabase). */
export type BillingSourceLine = {
  id: string;
  event_id: string;
  customer_id: string | null;
  phone_digits: string;
  customer_name_snapshot: string;
  product_title: string;
  valor_ou_opcao: string;
  unit_price: number | null;
  qty: number;
  import_status: string;
  certainty: string;
  cancelled: boolean;
  archived?: boolean | null;
  charged: boolean;
  paid: boolean;
  notes?: string | null;
  events?: {
    id: string;
    name: string;
    opened_at: string | null;
    payment_due_at: string | null;
    kind: string;
  } | null;
  customers?: { id: string; name: string; phone: string } | null;
};

export type BillingDraftItem = {
  customer_id: string | null;
  customer_name: string;
  phone_digits: string;
  text: string;
  total: number;
  sale_line_ids: string[];
  event_ids: string[];
};

export type BillingDraftProblem = {
  name: string;
  phone: string;
  reason: string;
};

export function looksLikePhoneName(name: string): boolean {
  const digits = normalizePhoneDigits(name);
  return digits.length >= 10 && digits === name.replace(/\D/g, "");
}

function linePrice(line: BillingSourceLine): number | null {
  if (line.unit_price != null && Number.isFinite(Number(line.unit_price))) {
    return Number(line.unit_price);
  }
  return (
    parseMoneyFromOption(line.product_title) ??
    parseMoneyFromOption(line.valor_ou_opcao || "")
  );
}

function toBillingLine(line: BillingSourceLine): BillingLine {
  return {
    product_title: line.product_title,
    unit_price: linePrice(line),
    qty: Number(line.qty) > 0 ? Number(line.qty) : 1,
  };
}

/** Em aberto e cobrável (mesma regra dos Participantes do evento). */
export function isBillableOpenLine(
  line: BillingSourceLine,
  includeCharged: boolean,
): boolean {
  if (line.paid || line.cancelled) return false;
  if (!includeCharged && line.charged) return false;
  return isActiveBillableSaleLine(line, line.events?.kind || null);
}

type ClientBucket = {
  phone: string;
  customerId: string | null;
  name: string;
  byEvent: Map<string, BillingSourceLine[]>;
};

/**
 * Agrupa as linhas por cliente (telefone) e monta a mensagem.
 * unificada = 1 por cliente · separada = 1 por cliente+evento.
 * Item com R$ ? fica de fora (vai pra lista de problemas).
 */
export function buildBillingDraft(
  lines: BillingSourceLine[],
  opts: { mode: "unificada" | "separada"; includeCharged: boolean },
): { items: BillingDraftItem[]; problems: BillingDraftProblem[] } {
  const problems: BillingDraftProblem[] = [];
  const clients = new Map<string, ClientBucket>();

  for (const line of lines) {
    if (!isBillableOpenLine(line, opts.includeCharged)) continue;
    const phone = normalizePhoneDigits(
      line.phone_digits || line.customers?.phone || "",
    );
    const name = (line.customers?.name || line.customer_name_snapshot || "").trim();
    if (!phone || phone.length < 10) {
      problems.push({
        name: name || "(sem nome)",
        phone: "",
        reason: `Sem telefone · ${line.product_title}`,
      });
      continue;
    }
    let c = clients.get(phone);
    if (!c) {
      c = {
        phone,
        customerId: line.customer_id,
        name,
        byEvent: new Map(),
      };
      clients.set(phone, c);
    }
    if (!c.customerId && line.customer_id) c.customerId = line.customer_id;
    if ((!c.name || looksLikePhoneName(c.name)) && name) c.name = name;
    const evId = line.event_id;
    const list = c.byEvent.get(evId) || [];
    list.push(line);
    c.byEvent.set(evId, list);
  }

  const items: BillingDraftItem[] = [];
  for (const c of clients.values()) {
    const greeting = greetingName(c.name, c.phone, looksLikePhoneName);
    const groups = [...c.byEvent.entries()].map(([eventId, ls]) => {
      const ev = ls[0]?.events;
      return {
        eventId,
        kind: ev?.kind || "outro",
        eventName: ev?.name || "Evento",
        eventDate: eventHappenedOn({ name: ev?.name, opened_at: ev?.opened_at }),
        paymentDue: ev?.payment_due_at || null,
        lines: ls,
      };
    });
    groups.sort((a, b) => {
      const rank = (k: string) => (k === "leilao" ? 0 : k === "encomenda" ? 1 : 2);
      return (
        rank(a.kind) - rank(b.kind) ||
        (a.eventDate || "").localeCompare(b.eventDate || "")
      );
    });

    const pushItem = (
      text: string,
      total: number,
      missing: number,
      ls: BillingSourceLine[],
      eventIds: string[],
    ) => {
      if (missing > 0) {
        problems.push({
          name: c.name || c.phone,
          phone: c.phone,
          reason: `${missing} item(ns) sem preço (R$ ?) — corrija no evento`,
        });
        return;
      }
      items.push({
        customer_id: c.customerId,
        customer_name: c.name || c.phone,
        phone_digits: c.phone,
        text,
        total,
        sale_line_ids: ls.map((l) => l.id),
        event_ids: eventIds,
      });
    };

    if (opts.mode === "unificada" && groups.length > 1) {
      const { text, total, missingPrice } = buildCombinedBillingMessage({
        customerName: greeting,
        events: groups.map((g) => ({
          kind: g.kind,
          eventName: g.eventName,
          eventDate: g.eventDate,
          paymentDue: g.paymentDue,
          lines: g.lines.map(toBillingLine),
        })),
      });
      pushItem(
        text,
        total,
        missingPrice,
        groups.flatMap((g) => g.lines),
        groups.map((g) => g.eventId),
      );
      continue;
    }

    for (const g of groups) {
      const { text, total, missingPrice } = buildBillingMessage({
        kind: g.kind,
        customerName: greeting,
        eventDate: g.eventDate,
        paymentDue: g.paymentDue,
        lines: g.lines.map(toBillingLine),
      });
      pushItem(text, total, missingPrice, g.lines, [g.eventId]);
    }
  }

  items.sort((a, b) =>
    a.customer_name.localeCompare(b.customer_name, "pt-BR", {
      sensitivity: "base",
    }),
  );
  return { items, problems };
}

/** Mensagem de teste quando não há evento escolhido. */
export function fantasyBillingText(name: string): string {
  return buildBillingMessage({
    kind: "leilao",
    customerName: name || "Teste",
    eventDate: new Date().toISOString().slice(0, 10),
    paymentDue: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    lines: [
      { product_title: "Pikachu (025/165) — TESTE", unit_price: 50, qty: 1 },
      { product_title: "Charizard ex (199/165) — TESTE", unit_price: 120, qty: 1 },
    ],
  }).text;
}

/** "Nome - 5521999999999" / "5521999999999" por linha. */
export function parseTestRecipients(
  raw: string,
): Array<{ name: string; phone: string }> {
  const out: Array<{ name: string; phone: string }> = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // "Nome - telefone" (separador com espaços) ou só o telefone
    const parts = t.split(/\s+[-–—]\s+|\s*:\s*/);
    const phoneRaw = parts.length > 1 ? parts.pop()! : t;
    const name = parts.length > 0 && phoneRaw !== t ? parts.join(" - ").trim() : "";
    if (/[a-z]/i.test(phoneRaw)) continue;
    let phone = normalizePhoneDigits(phoneRaw.replace(/\D/g, ""));
    if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
    if (!phone || phone.length < 12 || seen.has(phone)) continue;
    seen.add(phone);
    out.push({ name: name || phone, phone });
  }
  return out;
}

const PAYMENT_HINT_RE =
  /\b(pagu?ei|pago|paga|pix|comprovante|transferi|transfer[eê]ncia|enviei o valor|mandei o valor|ta pago|tá pago|feito o pagamento|pagamento feito)\b/i;

/** Resposta parece pagamento? (imagem/PDF ou palavra-chave) */
export function looksLikePaymentReply(kind: string, text: string): boolean {
  if (kind === "image" || kind === "document") return true;
  return PAYMENT_HINT_RE.test(text || "");
}

export function randomIntervalMs(minS: number, maxS: number): number {
  const lo = Math.max(30, Math.min(minS, maxS));
  const hi = Math.max(lo, Math.max(minS, maxS));
  return (lo + Math.random() * (hi - lo)) * 1000;
}
