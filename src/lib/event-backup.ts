import { fetchAllQueryRows } from "@/lib/customers";
import type { Event } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

export type EventRoundPayload = {
  event: Record<string, unknown>;
  sale_lines: Record<string, unknown>[];
  product_stock: Record<string, unknown>[];
  product_costs: Record<string, unknown>[];
  allocations: Record<string, unknown>[];
  assignments: Record<string, unknown>[];
  garage_items: Record<string, unknown>[];
  customer_items: Record<string, unknown>[];
};

export type EventRoundBackup = {
  id: string;
  original_event_id: string;
  event_name: string;
  event_kind: string;
  opened_at: string | null;
  deleted_at: string;
  deleted_by: string | null;
  payload?: EventRoundPayload;
};

const CHUNK = 200;

async function tableOrEmpty<T>(
  run: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const { data, error } = await run();
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return data || [];
}

function stripJoin<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out = { ...row };
  delete out.customers;
  delete out.cards;
  delete out.profiles;
  delete out.events;
  return out;
}

export async function snapshotEventRound(
  supabase: DbClient,
  eventId: string,
): Promise<EventRoundPayload> {
  const ev = await supabase.from("events").select("*").eq("id", eventId).single();
  if (ev.error || !ev.data) {
    throw new Error(ev.error?.message || "Evento não encontrado.");
  }

  const [sale_lines, product_stock, product_costs, allocations, assignments, garage_items, customer_items] =
    await Promise.all([
      fetchAllQueryRows<Record<string, unknown>>((from, to) =>
        supabase
          .from("event_sale_lines")
          .select("*")
          .eq("event_id", eventId)
          .order("id", { ascending: true })
          .range(from, to),
      ),
      tableOrEmpty<Record<string, unknown>>(() =>
        supabase.from("event_product_stock").select("*").eq("event_id", eventId),
      ),
      tableOrEmpty<Record<string, unknown>>(() =>
        supabase.from("event_product_costs").select("*").eq("event_id", eventId),
      ),
      tableOrEmpty<Record<string, unknown>>(() =>
        supabase.from("event_allocations").select("*").eq("event_id", eventId),
      ),
      tableOrEmpty<Record<string, unknown>>(() =>
        supabase.from("event_assignments").select("*").eq("event_id", eventId),
      ),
      tableOrEmpty<Record<string, unknown>>(() =>
        supabase.from("customer_garage_items").select("*").eq("event_id", eventId),
      ),
      tableOrEmpty<Record<string, unknown>>(() =>
        supabase.from("customer_items").select("*").eq("event_id", eventId),
      ),
    ]);

  return {
    event: stripJoin(ev.data as Record<string, unknown>),
    sale_lines: sale_lines.map(stripJoin),
    product_stock: product_stock.map(stripJoin),
    product_costs: product_costs.map(stripJoin),
    allocations: allocations.map(stripJoin),
    assignments: assignments.map(stripJoin),
    garage_items: garage_items.map(stripJoin),
    customer_items: customer_items.map(stripJoin),
  };
}

export async function saveEventRoundBackup(
  supabase: DbClient,
  opts: {
    event: Pick<Event, "id" | "name" | "kind" | "opened_at">;
    payload: EventRoundPayload;
    deletedBy: string | null;
  },
): Promise<EventRoundBackup> {
  const { data, error } = await supabase
    .from("event_round_backups")
    .insert({
      original_event_id: opts.event.id,
      event_name: opts.event.name,
      event_kind: opts.event.kind || "leilao",
      opened_at: opts.event.opened_at || null,
      deleted_by: opts.deletedBy,
      payload: opts.payload,
    })
    .select("*")
    .single();
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      throw new Error(
        "Falta a tabela de backup. Rode supabase/migration_event_round_backups.sql no Supabase.",
      );
    }
    throw new Error(error.message);
  }
  return data as EventRoundBackup;
}

async function detachBlockingFks(supabase: DbClient, eventId: string) {
  for (const table of ["customer_items", "stock_movements"] as const) {
    const { error } = await supabase
      .from(table)
      .update({ event_id: null })
      .eq("event_id", eventId);
    if (error && !/does not exist|schema cache/i.test(error.message)) {
      throw new Error(error.message);
    }
  }
}

export async function deleteEventKeepingBackup(
  supabase: DbClient,
  opts: {
    event: Event;
    deletedBy: string | null;
  },
): Promise<EventRoundBackup> {
  const payload = await snapshotEventRound(supabase, opts.event.id);
  const backup = await saveEventRoundBackup(supabase, {
    event: opts.event,
    payload,
    deletedBy: opts.deletedBy,
  });
  await detachBlockingFks(supabase, opts.event.id);
  const { error } = await supabase.from("events").delete().eq("id", opts.event.id);
  if (error) {
    throw new Error(
      `${error.message} O backup da rodada já foi gravado e não pode ser apagado.`,
    );
  }
  return backup;
}

async function insertChunked(
  supabase: DbClient,
  table: string,
  rows: Record<string, unknown>[],
) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

export async function restoreEventRoundBackup(
  supabase: DbClient,
  backup: EventRoundBackup,
): Promise<string> {
  const payload = backup.payload;
  if (!payload?.event?.id) throw new Error("Backup sem dados do evento.");
  const ev = payload.event;

  const eventId = String(ev.id);
  const existing = await supabase
    .from("events")
    .select("id")
    .eq("id", eventId)
    .maybeSingle();
  if (existing.data) {
    throw new Error("Esse evento já está restaurado (o id original ainda existe).");
  }

  const { error: evErr } = await supabase.from("events").insert({
    id: ev.id,
    name: ev.name,
    status: ev.status || "open",
    owner_id: ev.owner_id ?? null,
    notes: ev.notes ?? "",
    opened_at: ev.opened_at,
    closed_at: ev.closed_at ?? null,
    payment_due_at: ev.payment_due_at ?? null,
    kind: ev.kind || backup.event_kind || "leilao",
    use_stock_box: ev.use_stock_box ?? false,
  });
  if (evErr) throw new Error(evErr.message);

  await insertChunked(supabase, "event_allocations", payload.allocations || []);
  await insertChunked(supabase, "event_product_stock", payload.product_stock || []);
  await insertChunked(supabase, "event_product_costs", payload.product_costs || []);
  await insertChunked(supabase, "event_assignments", payload.assignments || []);
  await insertChunked(supabase, "event_sale_lines", payload.sale_lines || []);

  const garageIds = (payload.garage_items || [])
    .map((g) => g.id)
    .filter((id): id is string => typeof id === "string");
  if (garageIds.length) {
    await supabase
      .from("customer_garage_items")
      .update({ event_id: eventId })
      .in("id", garageIds)
      .is("event_id", null);
  }

  return eventId;
}

export function backupTableMissing(message: string): boolean {
  return /event_round_backups|does not exist|schema cache/i.test(message);
}
