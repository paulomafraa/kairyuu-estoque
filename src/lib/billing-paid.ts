import { lineUnitPrice } from "@/lib/ai/helpers";
import { eventHappenedOn } from "@/lib/event-date";
import type { SupabaseClient } from "@supabase/supabase-js";

type EventBits = {
  kind: string | null;
  name: string | null;
  opened_at: string | null;
};

type SaleRow = {
  id: string;
  customer_id: string | null;
  product_title: string;
  qty: number | null;
  unit_price: number | null;
  valor_ou_opcao: string | null;
  garage_item_id: string | null;
  cancelled: boolean;
  import_status: string | null;
  arremate: boolean | null;
  events: EventBits | EventBits[] | null;
};

function eventOf(row: SaleRow): EventBits | null {
  const raw = row.events;
  if (!raw) return null;
  return Array.isArray(raw) ? raw[0] || null : raw;
}

/**
 * Pagamento confirmado na lista de cobrança vira pago no evento
 * (e entra na caixinha, para o envio continuar na mão).
 * Desfazer só vale se ainda não houve envio.
 */
export async function applyBillingPaymentToLines(
  supabase: SupabaseClient,
  lineIds: string[],
  paid: boolean,
  userId: string | null,
): Promise<{ updated: number; blocked: number }> {
  const ids = [...new Set(lineIds.filter(Boolean))];
  if (!ids.length) return { updated: 0, blocked: 0 };

  const { data, error } = await supabase
    .from("event_sale_lines")
    .select(
      "id, customer_id, product_title, qty, unit_price, valor_ou_opcao, garage_item_id, cancelled, import_status, arremate, events(kind, name, opened_at)",
    )
    .in("id", ids);
  if (error) throw new Error(error.message);
  const rows = (data || []) as SaleRow[];
  const now = new Date().toISOString();
  let updated = 0;
  let blocked = 0;

  for (const line of rows) {
    if (line.cancelled) continue;
    if (!paid) {
      const stopped = await undoPaid(supabase, line, userId, now);
      if (stopped) blocked += 1;
      else updated += 1;
      continue;
    }
    if (!line.customer_id) continue;
    await ensureGarage(supabase, line, userId);
    const { error: upErr } = await supabase
      .from("event_sale_lines")
      .update({
        paid: true,
        paid_at: now,
        paid_by: userId,
        charged: true,
        charged_at: now,
        charged_by: userId,
        separated: true,
        separated_at: now,
        separated_by: userId,
      })
      .eq("id", line.id);
    if (upErr) throw new Error(upErr.message);
    updated += 1;
  }

  return { updated, blocked };
}

async function undoPaid(
  supabase: SupabaseClient,
  line: SaleRow,
  userId: string | null,
  now: string,
): Promise<boolean> {
  if (line.garage_item_id) {
    const { data: g } = await supabase
      .from("customer_garage_items")
      .select("id, status, qty_sent, qty_delivered")
      .eq("id", line.garage_item_id)
      .maybeSingle();
    if (g && (Number(g.qty_sent) > 0 || Number(g.qty_delivered) > 0)) {
      return true;
    }
    if (g && g.status !== "cancelled") {
      await supabase
        .from("customer_garage_items")
        .update({
          status: "cancelled",
          cancelled_at: now,
          cancelled_by: userId,
          cancel_reason: "Pagamento desfeito na lista de cobrança",
        })
        .eq("id", g.id);
    }
    await supabase
      .from("event_sale_lines")
      .update({ garage_item_id: null })
      .eq("id", line.id);
  }
  const { error } = await supabase
    .from("event_sale_lines")
    .update({ paid: false, paid_at: null, paid_by: null })
    .eq("id", line.id);
  if (error) throw new Error(error.message);
  return false;
}

async function ensureGarage(
  supabase: SupabaseClient,
  line: SaleRow,
  userId: string | null,
): Promise<void> {
  if (line.garage_item_id) {
    const { data: existingG } = await supabase
      .from("customer_garage_items")
      .select("id, status")
      .eq("id", line.garage_item_id)
      .maybeSingle();
    if (existingG && existingG.status !== "cancelled") return;
    await supabase
      .from("event_sale_lines")
      .update({ garage_item_id: null })
      .eq("id", line.id);
  }

  const ev = eventOf(line);
  const qty = Number(line.qty) > 0 ? Number(line.qty) : 1;
  const payload = {
    customer_id: line.customer_id,
    title: line.product_title,
    category: "carta",
    qty,
    qty_with_store: qty,
    qty_sent: 0,
    qty_delivered: 0,
    status: "in_garage",
    origin:
      ev?.kind === "encomenda"
        ? "encomenda"
        : ev?.kind === "leilao" ||
            line.import_status === "arrematado" ||
            line.arremate
          ? "leilao"
          : "evento",
    event_name: ev?.name || "",
    event_date: eventHappenedOn({
      name: ev?.name,
      opened_at: ev?.opened_at,
    }),
    unit_price: lineUnitPrice(line),
    notes: line.valor_ou_opcao || "",
    created_by: userId,
  };

  const { data: fresh } = await supabase
    .from("event_sale_lines")
    .select("event_id")
    .eq("id", line.id)
    .maybeSingle();
  const eventId = (fresh?.event_id as string | null) || null;

  const withEvent = eventId ? { ...payload, event_id: eventId } : payload;
  let insert = await supabase
    .from("customer_garage_items")
    .insert({ ...withEvent, event_sale_line_id: line.id })
    .select("id")
    .single();
  if (
    insert.error &&
    (insert.error.message.includes("event_sale_line_id") ||
      insert.error.code === "PGRST204")
  ) {
    insert = await supabase
      .from("customer_garage_items")
      .insert(withEvent)
      .select("id")
      .single();
  }
  if (insert.error?.code === "23505") {
    const { data: existing } = await supabase
      .from("customer_garage_items")
      .select("id, status")
      .eq("event_sale_line_id", line.id)
      .maybeSingle();
    if (existing?.id) {
      if (existing.status === "cancelled") {
        await supabase
          .from("customer_garage_items")
          .update({
            status: "in_garage",
            cancelled_at: null,
            cancelled_by: null,
            cancel_reason: "",
            qty,
            qty_with_store: qty,
            qty_sent: 0,
            qty_delivered: 0,
          })
          .eq("id", existing.id);
      }
      await supabase
        .from("event_sale_lines")
        .update({ garage_item_id: existing.id })
        .eq("id", line.id)
        .is("garage_item_id", null);
    }
    return;
  }
  if (insert.error || !insert.data) return;
  const { data: claimed } = await supabase
    .from("event_sale_lines")
    .update({ garage_item_id: insert.data.id })
    .eq("id", line.id)
    .is("garage_item_id", null)
    .select("id");
  if (!claimed?.length) {
    await supabase.from("customer_garage_items").delete().eq("id", insert.data.id);
  }
}
