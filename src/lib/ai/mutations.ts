import type { SupabaseClient } from "@supabase/supabase-js";
import { logStaffAction } from "@/lib/audit";
import { lineQty, lineUnitPrice } from "@/lib/ai/helpers";
import { eventHappenedOn } from "@/lib/event-date";
import type { ActionProposal } from "@/lib/ai/types";

export type ConfirmResult = {
  ok: boolean;
  message: string;
  detail?: string;
};

async function claimGarage(
  supabase: SupabaseClient,
  saleLineId: string,
  garageItemId: string,
  deleteOrphan: boolean,
): Promise<boolean> {
  const { data: claimed } = await supabase
    .from("event_sale_lines")
    .update({ garage_item_id: garageItemId })
    .eq("id", saleLineId)
    .is("garage_item_id", null)
    .select("id");
  if (!claimed?.length) {
    if (deleteOrphan) {
      await supabase.from("customer_garage_items").delete().eq("id", garageItemId);
    }
    return false;
  }
  return true;
}

async function ensureGarageForPaidLine(
  supabase: SupabaseClient,
  line: {
    id: string;
    customer_id: string | null;
    product_title: string;
    qty: number;
    unit_price: number | null;
    valor_ou_opcao: string;
    import_status: string;
    arremate: boolean;
    garage_item_id: string | null;
    event_id: string;
  },
  event: {
    id: string;
    name: string;
    kind?: string | null;
    opened_at?: string | null;
  } | null,
  meId: string | null,
): Promise<void> {
  if (!line.customer_id) return;

  if (line.garage_item_id) {
    const { data: g } = await supabase
      .from("customer_garage_items")
      .select("id, status")
      .eq("id", line.garage_item_id)
      .maybeSingle();
    if (g && g.status !== "cancelled") return;
    await supabase
      .from("event_sale_lines")
      .update({ garage_item_id: null })
      .eq("id", line.id);
  }

  const qty = lineQty(line);
  const origin =
    event?.kind === "encomenda"
      ? "encomenda"
      : event?.kind === "leilao" ||
          line.import_status === "arrematado" ||
          line.arremate
        ? "leilao"
        : "evento";

  const base = {
    customer_id: line.customer_id,
    title: line.product_title,
    category: "carta",
    qty,
    qty_with_store: qty,
    qty_sent: 0,
    qty_delivered: 0,
    status: "in_garage",
    origin,
    event_name: event?.name || "",
    event_date:
      eventHappenedOn({
        name: event?.name,
        opened_at: event?.opened_at,
      }) || null,
    event_id: line.event_id,
    unit_price: lineUnitPrice(line),
    notes: line.valor_ou_opcao || "",
    created_by: meId,
  };

  let insert = await supabase
    .from("customer_garage_items")
    .insert({ ...base, event_sale_line_id: line.id })
    .select("id")
    .single();

  if (
    insert.error &&
    (insert.error.message.includes("event_sale_line_id") ||
      insert.error.code === "PGRST204")
  ) {
    insert = await supabase
      .from("customer_garage_items")
      .insert(base)
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
      await claimGarage(supabase, line.id, existing.id, false);
    }
    return;
  }

  if (insert.error || !insert.data) return;
  await claimGarage(supabase, line.id, insert.data.id, true);
}

export async function executeActionProposal(
  supabase: SupabaseClient,
  proposal: ActionProposal,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  switch (proposal.kind) {
    case "mark_paid":
      return markPaid(supabase, proposal, meId, meName);
    case "mark_charged":
      return markCharged(supabase, proposal, meId, meName);
    case "mark_separated":
      return markSeparated(supabase, proposal, meId, meName);
    case "cancel_lines":
      return cancelLines(supabase, proposal, meId, meName);
    case "unpay_lines":
      return unpayLines(supabase, proposal, meId, meName);
    case "ship_garage_items":
      return shipGarage(supabase, proposal, meId, meName);
    case "cancel_garage_item":
      return cancelGarage(supabase, proposal, meId, meName);
    case "add_customer_note":
      return addNote(supabase, proposal, meId, meName);
    case "set_encomenda_stock":
      return setEncomendaStock(supabase, proposal, meId, meName);
    default:
      return { ok: false, message: "Ação desconhecida." };
  }
}

async function markPaid(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "mark_paid" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const { data: lines, error } = await supabase
    .from("event_sale_lines")
    .select(
      "id, customer_id, product_title, qty, unit_price, valor_ou_opcao, import_status, arremate, garage_item_id, event_id, paid, cancelled, events:event_id ( id, name, kind, opened_at )",
    )
    .in("id", proposal.line_ids);
  if (error) return { ok: false, message: error.message };

  const payable = (lines || []).filter(
    (l) =>
      !l.cancelled &&
      !l.paid &&
      l.customer_id === proposal.customer_id,
  );
  if (!payable.length) {
    return {
      ok: false,
      message: "Nenhum item elegível (já pagos, cancelados ou cliente diferente).",
    };
  }

  for (const line of payable) {
    const ev = Array.isArray(line.events) ? line.events[0] : line.events;
    await ensureGarageForPaidLine(
      supabase,
      line,
      ev as {
        id: string;
        name: string;
        kind?: string | null;
        opened_at?: string | null;
      } | null,
      meId,
    );
  }

  const ids = payable.map((l) => l.id);
  const now = new Date().toISOString();
  const { error: uErr } = await supabase
    .from("event_sale_lines")
    .update({
      paid: true,
      paid_at: now,
      paid_by: meId,
      charged: true,
      charged_at: now,
      charged_by: meId,
    })
    .in("id", ids);
  if (uErr) return { ok: false, message: uErr.message };

  await logStaffAction(supabase, {
    action: "IA · Pago",
    detail: `IA (${meName}): pago ${ids.length} item(ns) · ${proposal.customer_name}`,
    created_by: meId,
    entity_type: "event_sale_lines",
    entity_id: ids.join(","),
    customer_id: proposal.customer_id,
  });

  return {
    ok: true,
    message: `Pago · ${ids.length} item(ns) foram pra caixinha.`,
  };
}

async function markCharged(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "mark_charged" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("event_sale_lines")
    .update(
      proposal.value
        ? { charged: true, charged_at: now, charged_by: meId }
        : { charged: false, charged_at: null, charged_by: null },
    )
    .in("id", proposal.line_ids);
  if (error) return { ok: false, message: error.message };
  await logStaffAction(supabase, {
    action: proposal.value ? "IA · Cobrado" : "IA · Desfazer cobrado",
    detail: `IA (${meName}): ${proposal.line_ids.length} item(ns)`,
    created_by: meId,
    entity_type: "event_sale_lines",
    entity_id: proposal.line_ids.join(","),
  });
  return {
    ok: true,
    message: proposal.value
      ? `Cobrado · ${proposal.line_ids.length} item(ns)`
      : `Cobrança desfeita · ${proposal.line_ids.length} item(ns)`,
  };
}

async function markSeparated(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "mark_separated" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("event_sale_lines")
    .update(
      proposal.value
        ? { separated: true, separated_at: now, separated_by: meId }
        : { separated: false, separated_at: null, separated_by: null },
    )
    .in("id", proposal.line_ids);
  if (error) return { ok: false, message: error.message };
  await logStaffAction(supabase, {
    action: proposal.value ? "IA · Separado" : "IA · Desfazer separado",
    detail: `IA (${meName}): ${proposal.line_ids.length} item(ns)`,
    created_by: meId,
    entity_type: "event_sale_lines",
    entity_id: proposal.line_ids.join(","),
  });
  return {
    ok: true,
    message: proposal.value
      ? `Separado · ${proposal.line_ids.length} item(ns)`
      : `Separação desfeita · ${proposal.line_ids.length}`,
  };
}

async function cancelLines(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "cancel_lines" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const { data: lines } = await supabase
    .from("event_sale_lines")
    .select("id, garage_item_id")
    .in("id", proposal.line_ids);
  const now = new Date().toISOString();
  for (const row of lines || []) {
    if (!row.garage_item_id) continue;
    await supabase
      .from("customer_garage_items")
      .update({
        status: "cancelled",
        cancelled_at: now,
        cancelled_by: meId,
        cancel_reason: proposal.reason,
      })
      .eq("id", row.garage_item_id);
  }
  const { error } = await supabase
    .from("event_sale_lines")
    .update({
      cancelled: true,
      cancel_reason: proposal.reason,
      cancelled_at: now,
      cancelled_by: meId,
    })
    .in("id", proposal.line_ids);
  if (error) return { ok: false, message: error.message };
  await logStaffAction(supabase, {
    action: "IA · Cancelado",
    detail: `IA (${meName}): ${proposal.line_ids.length} · ${proposal.reason}`,
    created_by: meId,
    entity_type: "event_sale_lines",
    entity_id: proposal.line_ids.join(","),
  });
  return {
    ok: true,
    message: `Cancelado · ${proposal.line_ids.length} item(ns)`,
  };
}

async function unpayLines(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "unpay_lines" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const { data: lines } = await supabase
    .from("event_sale_lines")
    .select("id, garage_item_id, paid")
    .in("id", proposal.line_ids);

  for (const line of lines || []) {
    if (!line.garage_item_id) continue;
    const { data: g } = await supabase
      .from("customer_garage_items")
      .select("id, status, qty_sent, qty_delivered")
      .eq("id", line.garage_item_id)
      .maybeSingle();
    if (g && (Number(g.qty_sent) > 0 || Number(g.qty_delivered) > 0)) {
      return {
        ok: false,
        message:
          "Não dá para desfazer: já houve envio/entrega. Desfaça o envio na ficha antes.",
      };
    }
    if (g && g.status !== "cancelled") {
      await supabase
        .from("customer_garage_items")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancelled_by: meId,
          cancel_reason: "Pagamento desfeito (IA)",
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
    .in("id", proposal.line_ids);
  if (error) return { ok: false, message: error.message };

  await logStaffAction(supabase, {
    action: "IA · Desfazer pago",
    detail: `IA (${meName}): ${proposal.line_ids.length} item(ns)`,
    created_by: meId,
    entity_type: "event_sale_lines",
    entity_id: proposal.line_ids.join(","),
  });
  return {
    ok: true,
    message: `Pagamento desfeito · ${proposal.line_ids.length} item(ns)`,
  };
}

async function shipGarage(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "ship_garage_items" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const { data: existing } = await supabase
    .from("customer_shipments")
    .select("id")
    .eq("customer_id", proposal.customer_id)
    .eq("shipped_on", proposal.shipped_on)
    .eq("label", "")
    .limit(1)
    .maybeSingle();

  let shipmentId = existing?.id as string | undefined;
  if (!shipmentId) {
    const { data: created, error } = await supabase
      .from("customer_shipments")
      .insert({
        customer_id: proposal.customer_id,
        shipped_on: proposal.shipped_on,
        label: "",
        notes: "",
        created_by: meId,
      })
      .select("id")
      .single();
    if (error || !created) {
      return { ok: false, message: error?.message || "Falha ao criar pacote." };
    }
    shipmentId = created.id;
  }

  const { data: items } = await supabase
    .from("customer_garage_items")
    .select("id, qty_with_store, qty_sent, qty_delivered, status, title")
    .in("id", proposal.item_ids);

  let shipped = 0;
  for (const item of items || []) {
    const n = Number(item.qty_with_store);
    if (n <= 0) continue;
    const nextSent = Number(item.qty_sent) + n;
    const { error } = await supabase
      .from("customer_garage_items")
      .update({
        qty_with_store: 0,
        qty_sent: nextSent,
        status: Number(item.qty_delivered) === 0 ? "shipped" : item.status,
        shipment_id: shipmentId,
        shipped_on: proposal.shipped_on,
      })
      .eq("id", item.id);
    if (!error) {
      shipped += 1;
      await logStaffAction(supabase, {
        action: "IA · Envio",
        detail: `IA (${meName}): ${item.title} ×${n} enviado`,
        created_by: meId,
        entity_type: "customer_garage_items",
        entity_id: item.id,
        customer_id: proposal.customer_id,
      });
    }
  }

  if (!shipped) {
    return { ok: false, message: "Nenhum item pôde ser enviado." };
  }
  return {
    ok: true,
    message: `Enviado · ${shipped} item(ns) · pacote ${proposal.shipped_on}`,
  };
}

async function cancelGarage(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "cancel_garage_item" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("customer_garage_items")
    .update({
      status: "cancelled",
      cancelled_at: now,
      cancelled_by: meId,
      cancel_reason: proposal.reason,
    })
    .eq("id", proposal.item_id);
  if (error) return { ok: false, message: error.message };

  await supabase
    .from("event_sale_lines")
    .update({
      cancelled: true,
      cancel_reason: proposal.reason,
      cancelled_at: now,
      cancelled_by: meId,
    })
    .eq("garage_item_id", proposal.item_id)
    .eq("cancelled", false);

  await logStaffAction(supabase, {
    action: "IA · Cancelar caixinha",
    detail: `IA (${meName}): ${proposal.item_title} · ${proposal.reason}`,
    created_by: meId,
    entity_type: "customer_garage_items",
    entity_id: proposal.item_id,
    customer_id: proposal.customer_id,
  });
  return { ok: true, message: `Cancelado · ${proposal.item_title}` };
}

async function addNote(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "add_customer_note" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const { error } = await supabase.from("customer_notes").insert({
    customer_id: proposal.customer_id,
    body: proposal.body,
    created_by: meId,
  });
  if (error) return { ok: false, message: error.message };
  await logStaffAction(supabase, {
    action: "IA · Nota",
    detail: `IA (${meName}): nota em ${proposal.customer_name}`,
    created_by: meId,
    customer_id: proposal.customer_id,
  });
  return { ok: true, message: "Nota adicionada." };
}

async function setEncomendaStock(
  supabase: SupabaseClient,
  proposal: Extract<ActionProposal, { kind: "set_encomenda_stock" }>,
  meId: string | null,
  meName: string,
): Promise<ConfirmResult> {
  const { data: existing } = await supabase
    .from("event_product_stock")
    .select("id, pedido_feito, qty_arrived")
    .eq("event_id", proposal.event_id)
    .eq("product_title", proposal.product_title)
    .maybeSingle();

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: meId,
  };
  if (proposal.pedido_feito !== undefined) {
    patch.pedido_feito = proposal.pedido_feito;
  }
  if (proposal.qty_arrived !== undefined) {
    patch.qty_arrived = proposal.qty_arrived;
  }

  if (existing?.id) {
    const { error } = await supabase
      .from("event_product_stock")
      .update(patch)
      .eq("id", existing.id);
    if (error) return { ok: false, message: error.message };
  } else {
    const { error } = await supabase.from("event_product_stock").insert({
      event_id: proposal.event_id,
      product_title: proposal.product_title,
      qty_arrived: proposal.qty_arrived ?? 0,
      pedido_feito: proposal.pedido_feito ?? false,
      notes: "",
      updated_by: meId,
    });
    if (error) return { ok: false, message: error.message };
  }

  await logStaffAction(supabase, {
    action: "IA · Encomenda stock",
    detail: `IA (${meName}): ${proposal.summary}`,
    created_by: meId,
    event_id: proposal.event_id,
  });
  return { ok: true, message: "Estoque da encomenda atualizado." };
}
