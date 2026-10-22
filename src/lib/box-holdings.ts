import { normalizePhoneDigits } from "@/lib/clients-csv";
import { daysSincePayment, LEILAO_GARAGE_LIMIT_DAYS } from "@/lib/cobranca-msg";
import { phoneVariants } from "@/lib/customers";

type Db = { from: (table: string) => any };

export type StoreItem = {
  key: string;
  title: string;
  qty: number;
  source: "leilao" | "encomenda" | "venda" | "manual" | "outro";
  sinceIso: string | null;
  customerName: string;
  eventName: string;
  manualId?: string;
};

export type MatchedCustomer = { id: string; name: string; phone: string };

export type BoxHoldings = {
  items: StoreItem[];
  matchedCustomers: MatchedCustomer[];
  manualError: string | null;
};

function kindOf(raw: unknown): StoreItem["source"] {
  const row = Array.isArray(raw) ? raw[0] : raw;
  const kind = row && typeof row === "object" ? (row as { kind?: string }).kind : "";
  if (kind === "leilao" || kind === "encomenda" || kind === "venda") return kind;
  return "outro";
}

function eventNameOf(raw: unknown): string {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") return "";
  return String((row as { name?: string }).name || "");
}

/** Quem está nesta caixinha: vínculo direto ou o mesmo telefone. */
export async function customersForBox(
  supabase: Db,
  box: { id: string; phone?: string | null; phone_digits?: string | null },
  linked: MatchedCustomer[],
): Promise<MatchedCustomer[]> {
  const map = new Map<string, MatchedCustomer>();
  for (const c of linked) map.set(c.id, c);
  const digits = normalizePhoneDigits(box.phone_digits || box.phone || "");
  const variants = phoneVariants(digits);
  if (!variants.length) return [...map.values()];
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, phone")
    .in("phone_digits", variants);
  if (error) throw new Error(error.message);
  for (const row of (data || []) as MatchedCustomer[]) map.set(row.id, row);
  return [...map.values()];
}

/**
 * O que está conosco: garagem ainda na loja + linha paga da rodada que
 * ainda não virou envio. Linha manual é o que não passou por rodada.
 */
export async function loadBoxHoldings(
  supabase: Db,
  box: { id: string; phone?: string | null; phone_digits?: string | null },
  linked: MatchedCustomer[],
): Promise<BoxHoldings> {
  const people = await customersForBox(supabase, box, linked);
  const ids = people.map((p) => p.id);
  const nameById = new Map(people.map((p) => [p.id, p.name]));
  const items: StoreItem[] = [];
  const garageIds = new Set<string>();

  if (ids.length) {
    const { data: garage, error: gErr } = await supabase
      .from("customer_garage_items")
      .select(
        "id, customer_id, title, qty_with_store, origin, event_name, created_at, status, event_sale_line_id",
      )
      .in("customer_id", ids)
      .gt("qty_with_store", 0)
      .in("status", ["in_garage", "reserved"]);
    if (gErr) throw new Error(gErr.message);
    for (const g of (garage || []) as Array<{
      id: string;
      customer_id: string;
      title: string;
      qty_with_store: number;
      origin: string;
      event_name: string;
      created_at: string;
    }>) {
      garageIds.add(g.id);
      const source: StoreItem["source"] =
        g.origin === "leilao" || g.origin === "encomenda" || g.origin === "venda"
          ? g.origin
          : "outro";
      items.push({
        key: `g:${g.id}`,
        title: g.title,
        qty: Number(g.qty_with_store) || 1,
        source,
        sinceIso: g.created_at,
        customerName: nameById.get(g.customer_id) || "",
        eventName: g.event_name || "",
      });
    }

    const { data: lines, error: lErr } = await supabase
      .from("event_sale_lines")
      .select(
        "id, customer_id, product_title, qty, qty_sent, qty_delivered, paid_at, garage_item_id, customer_name_snapshot, events(name, kind)",
      )
      .in("customer_id", ids)
      .eq("paid", true)
      .eq("cancelled", false);
    if (lErr) throw new Error(lErr.message);
    for (const line of (lines || []) as Array<{
      id: string;
      customer_id: string | null;
      product_title: string;
      qty: number | null;
      qty_sent: number | null;
      qty_delivered: number | null;
      paid_at: string | null;
      garage_item_id: string | null;
      customer_name_snapshot: string;
      events: unknown;
    }>) {
      if (line.garage_item_id && garageIds.has(line.garage_item_id)) continue;
      if (line.garage_item_id) continue;
      const qty = Number(line.qty) > 0 ? Number(line.qty) : 1;
      const sent = Math.max(Number(line.qty_sent) || 0, Number(line.qty_delivered) || 0);
      if (sent >= qty) continue;
      items.push({
        key: `l:${line.id}`,
        title: line.product_title,
        qty: qty - sent,
        source: kindOf(line.events),
        sinceIso: line.paid_at,
        customerName:
          (line.customer_id && nameById.get(line.customer_id)) ||
          line.customer_name_snapshot ||
          "",
        eventName: eventNameOf(line.events),
      });
    }
  }

  let manualError: string | null = null;
  const { data: manual, error: mErr } = await supabase
    .from("physical_box_lines")
    .select("id, title, qty, created_at, notes")
    .eq("box_id", box.id)
    .order("created_at", { ascending: true });
  if (mErr) {
    manualError = mErr.message;
  } else {
    for (const row of (manual || []) as Array<{
      id: string;
      title: string;
      qty: number;
      created_at: string;
    }>) {
      items.push({
        key: `m:${row.id}`,
        title: row.title,
        qty: Number(row.qty) || 1,
        source: "manual",
        sinceIso: row.created_at,
        customerName: "",
        eventName: "",
        manualId: row.id,
      });
    }
  }

  return { items, matchedCustomers: people, manualError };
}

export type ReminderMilestone = "14" | "7" | "1";

/** Faltam exatamente 14, 7 ou 1 dia para o limite de 3 meses. */
export function reminderMilestone(sinceIso: string | null): ReminderMilestone | null {
  const held = daysSincePayment(sinceIso);
  if (held == null) return null;
  const left = LEILAO_GARAGE_LIMIT_DAYS - held;
  if (left === 14) return "14";
  if (left === 7) return "7";
  if (left === 1) return "1";
  return null;
}

export function anchorDay(sinceIso: string | null): string | null {
  if (!sinceIso) return null;
  const d = new Date(sinceIso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
