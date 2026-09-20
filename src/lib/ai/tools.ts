import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildBillingMessage,
  formatMoneyBr,
  greetingName,
} from "@/lib/cobranca-msg";
import { isActiveBillableSaleLine } from "@/lib/leilao-resultado";
import type { ActionProposal, ToolResult } from "@/lib/ai/types";
import {
  digitsQuery,
  lineQty,
  lineTotal,
  lineUnitPrice,
  looksLikePhoneName,
  newProposalId,
  type SaleLineWithEvent,
} from "@/lib/ai/helpers";
import { eventHappenedOn } from "@/lib/event-date";
import type { AiToolName } from "@/lib/ai/tool-defs";
import {
  fetchRelatedCustomerIds,
  fetchSaleLinesForCustomer,
} from "@/lib/customers";

function ok(data: unknown, proposals?: ActionProposal[]): ToolResult {
  return { ok: true, data, proposals };
}
function fail(error: string): ToolResult {
  return { ok: false, error };
}

async function loadCustomerLines(
  supabase: SupabaseClient,
  customerId: string,
  eventIds?: string[],
): Promise<SaleLineWithEvent[]> {
  const { data: cust, error: custErr } = await supabase
    .from("customers")
    .select("id, phone, phone_digits")
    .eq("id", customerId)
    .maybeSingle();
  if (custErr) throw new Error(custErr.message);
  const phone = String(cust?.phone_digits || cust?.phone || "");
  const relatedIds = await fetchRelatedCustomerIds(
    supabase,
    customerId,
    phone,
  );
  let lines = await fetchSaleLinesForCustomer<SaleLineWithEvent>(supabase, {
    customerIds: relatedIds,
    phoneDigits: phone,
    select:
      "*, events:event_id ( id, name, kind, opened_at, payment_due_at )",
    cancelled: false,
  });
  if (eventIds?.length) {
    const allow = new Set(eventIds);
    lines = lines.filter((l) => allow.has(l.event_id));
  }
  return lines;
}

function openUnpaid(lines: SaleLineWithEvent[]): SaleLineWithEvent[] {
  return lines.filter(
    (l) =>
      !l.paid &&
      isActiveBillableSaleLine(l, l.events?.kind),
  );
}

export async function runAiTool(
  supabase: SupabaseClient,
  name: AiToolName | string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "resolve_customer":
        return await resolveCustomer(supabase, String(args.query || ""));
      case "resolve_event":
        return await resolveEvent(supabase, args);
      case "get_customer_overview":
        return await customerOverview(supabase, String(args.customer_id || ""));
      case "report_pending_payments":
        return await reportPendingPayments(supabase, args);
      case "list_open_charges":
        return await listOpenCharges(supabase, args);
      case "list_garage":
        return await listGarage(supabase, args);
      case "list_pending_shipments":
        return await listPendingShipments(supabase, args);
      case "search_cards":
        return await searchCards(supabase, args);
      case "draft_billing_message":
        return await draftBilling(supabase, args);
      case "list_recent_audit":
        return await listAudit(supabase, args);
      case "propose_mark_paid":
        return await proposeMarkPaid(supabase, args);
      case "propose_mark_charged":
        return await proposeMarkCharged(supabase, args, Boolean(args.value));
      case "propose_mark_separated":
        return await proposeMarkSeparated(supabase, args, Boolean(args.value));
      case "propose_cancel_lines":
        return await proposeCancelLines(supabase, args);
      case "propose_unpay_lines":
        return await proposeUnpay(supabase, args);
      case "propose_ship_garage":
        return await proposeShipGarage(supabase, args);
      case "propose_cancel_garage_item":
        return await proposeCancelGarage(supabase, args);
      case "propose_add_note":
        return await proposeAddNote(supabase, args);
      case "propose_encomenda_stock":
        return await proposeEncomendaStock(supabase, args);
      default:
        return fail(`Ferramenta desconhecida: ${name}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function resolveCustomer(
  supabase: SupabaseClient,
  query: string,
): Promise<ToolResult> {
  const q = query.trim();
  if (!q) return fail("Informe nome ou telefone.");
  const digits = digitsQuery(q);

  const { data: byPhone } =
    digits.length >= 8
      ? await supabase
          .from("customers")
          .select("id, name, phone, phone_digits")
          .or(`phone_digits.ilike.%${digits}%,phone.ilike.%${digits}%`)
          .limit(10)
      : { data: [] as never[] };

  const { data: byName } = await supabase
    .from("customers")
    .select("id, name, phone, phone_digits")
    .ilike("name", `%${q}%`)
    .limit(10);

  const map = new Map<string, { id: string; name: string; phone: string }>();
  for (const c of [...(byPhone || []), ...(byName || [])]) {
    map.set(c.id, {
      id: c.id,
      name: c.name,
      phone: c.phone || c.phone_digits || "",
    });
  }
  const matches = [...map.values()];
  if (!matches.length) {
    return ok({
      matches: [],
      message: `Nenhum cliente encontrado para "${q}".`,
    });
  }
  return ok({
    matches,
    message:
      matches.length === 1
        ? `Cliente encontrado: ${matches[0].name} (${matches[0].phone}). Use customer_id=${matches[0].id}.`
        : `Vários clientes — peça ao usuário qual telefone/id usar.`,
  });
}

async function resolveEvent(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = String(args.query || "").trim();
  const kind = args.kind ? String(args.kind) : null;
  const dateHint = args.date_hint ? String(args.date_hint) : null;

  let q = supabase
    .from("events")
    .select("id, name, kind, status, opened_at, payment_due_at")
    .order("opened_at", { ascending: false })
    .limit(20);
  if (query) q = q.ilike("name", `%${query}%`);
  if (kind) q = q.eq("kind", kind);
  if (dateHint && /^\d{4}-\d{2}/.test(dateHint)) {
    const start = dateHint.length === 7 ? `${dateHint}-01` : dateHint;
    q = q.gte("opened_at", `${start}T00:00:00`);
    if (dateHint.length === 7) {
      const [y, m] = dateHint.split("-").map(Number);
      const end = new Date(y, m, 0);
      const endStr = end.toISOString().slice(0, 10);
      q = q.lte("opened_at", `${endStr}T23:59:59`);
    } else {
      q = q.lte("opened_at", `${dateHint}T23:59:59`);
    }
  }
  const { data, error } = await q;
  if (error) return fail(error.message);
  return ok({
    events: data || [],
    message: data?.length
      ? `Encontrei ${data.length} evento(s).`
      : "Nenhum evento encontrado.",
  });
}

async function customerOverview(
  supabase: SupabaseClient,
  customerId: string,
): Promise<ToolResult> {
  const { data: cust, error } = await supabase
    .from("customers")
    .select("id, name, phone, phone_digits")
    .eq("id", customerId)
    .maybeSingle();
  if (error || !cust) return fail("Cliente não encontrado.");

  const lines = await loadCustomerLines(supabase, customerId);
  const unpaid = openUnpaid(lines);
  let unpaidTotal = 0;
  let missing = 0;
  for (const l of unpaid) {
    const t = lineTotal(l);
    if (t == null) missing += 1;
    else unpaidTotal += t;
  }

  const phone = String(cust.phone_digits || cust.phone || "");
  const relatedIds = await fetchRelatedCustomerIds(
    supabase,
    customerId,
    phone,
  );

  const { data: garage } = await supabase
    .from("customer_garage_items")
    .select(
      "id, title, status, qty_with_store, qty_sent, event_name, unit_price",
    )
    .in("customer_id", relatedIds)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(80);

  const inStore = (garage || []).filter((g) => Number(g.qty_with_store) > 0);
  const sent = (garage || []).filter((g) => Number(g.qty_sent) > 0);

  return ok({
    customer: cust,
    open_charges: {
      count: unpaid.length,
      total: unpaidTotal,
      missing_price: missing,
      sample: unpaid.slice(0, 15).map((l) => ({
        id: l.id,
        product: l.product_title,
        event: l.events?.name,
        event_id: l.event_id,
        qty: lineQty(l),
        total: lineTotal(l),
        charged: l.charged,
        separated: l.separated,
      })),
    },
    garage_in_store: inStore.length,
    garage_sent: sent.length,
    garage_sample: inStore.slice(0, 12),
  });
}

async function reportPendingPayments(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const dueOnOrBefore = args.due_on_or_before
    ? String(args.due_on_or_before).slice(0, 10)
    : null;
  const dueOnOrAfter = args.due_on_or_after
    ? String(args.due_on_or_after).slice(0, 10)
    : null;
  const onlyOverdue = Boolean(args.only_overdue);
  const includeWithoutDue = Boolean(args.include_without_due);
  const eventKind = args.event_kind ? String(args.event_kind) : null;
  const limitPeople = Math.min(80, Number(args.limit_people) || 40);
  const today = new Date().toISOString().slice(0, 10);

  // Busca linhas não pagas ativas (paginado)
  const allLines: SaleLineWithEvent[] = [];
  const pageSize = 1000;
  for (let from = 0; from < 5000; from += pageSize) {
    let q = supabase
      .from("event_sale_lines")
      .select(
        "*, events:event_id ( id, name, kind, opened_at, payment_due_at ), customers:customer_id ( id, name, phone )",
      )
      .eq("cancelled", false)
      .eq("paid", false)
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) return fail(error.message);
    const batch = (data as SaleLineWithEvent[]) || [];
    allLines.push(...batch);
    if (batch.length < pageSize) break;
  }

  type PersonAgg = {
    customer_id: string | null;
    name: string;
    phone: string;
    items: number;
    total: number;
    missing_price: number;
    earliest_due: string | null;
    events: string[];
  };

  const byPerson = new Map<string, PersonAgg>();
  let itemsMatched = 0;
  let totalMatched = 0;
  let missingPrice = 0;

  for (const line of allLines) {
    const kind = line.events?.kind || null;
    if (eventKind && kind !== eventKind) continue;
    if (!isActiveBillableSaleLine(line, kind)) continue;

    const due = line.events?.payment_due_at
      ? String(line.events.payment_due_at).slice(0, 10)
      : null;

    if (!due) {
      if (!includeWithoutDue) continue;
    } else {
      if (onlyOverdue && due >= today) continue;
      if (dueOnOrBefore && due > dueOnOrBefore) continue;
      if (dueOnOrAfter && due < dueOnOrAfter) continue;
    }

    itemsMatched += 1;
    const t = lineTotal(line);
    if (t == null) missingPrice += 1;
    else totalMatched += t;

    const cust = (
      line as SaleLineWithEvent & {
        customers?: { id: string; name: string; phone: string } | null;
      }
    ).customers;
    const key =
      line.customer_id ||
      line.phone_digits ||
      `line:${line.id}`;
    let row = byPerson.get(key);
    if (!row) {
      row = {
        customer_id: line.customer_id,
        name:
          cust?.name ||
          line.customer_name_snapshot ||
          line.phone_digits ||
          "Sem nome",
        phone: cust?.phone || line.phone_digits || "",
        items: 0,
        total: 0,
        missing_price: 0,
        earliest_due: due,
        events: [],
      };
      byPerson.set(key, row);
    }
    row.items += 1;
    if (t == null) row.missing_price += 1;
    else row.total += t;
    if (due && (!row.earliest_due || due < row.earliest_due)) {
      row.earliest_due = due;
    }
    const evName = line.events?.name || "";
    if (evName && !row.events.includes(evName)) row.events.push(evName);
  }

  const people = [...byPerson.values()].sort((a, b) => {
    const da = a.earliest_due || "9999";
    const db = b.earliest_due || "9999";
    if (da !== db) return da.localeCompare(db);
    return b.total - a.total;
  });

  const filterLabel = [
    dueOnOrBefore ? `prazo até ${dueOnOrBefore}` : null,
    dueOnOrAfter ? `prazo a partir de ${dueOnOrAfter}` : null,
    onlyOverdue ? "somente atrasados" : null,
    eventKind ? `kind=${eventKind}` : null,
    includeWithoutDue ? "inclui sem prazo" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return ok({
    today,
    filter: filterLabel || "todas as pendências com prazo (ou conforme args)",
    people_count: people.length,
    items_count: itemsMatched,
    total_amount: totalMatched,
    total_formatted: `R$ ${formatMoneyBr(totalMatched)}`,
    missing_price_items: missingPrice,
    answer_hint: `${people.length} pessoa(s) com pagamento pendente${
      dueOnOrBefore ? ` com prazo até ${dueOnOrBefore}` : ""
    }${onlyOverdue ? " (atrasados)" : ""} · ${itemsMatched} item(ns) · R$ ${formatMoneyBr(totalMatched)}`,
    people: people.slice(0, limitPeople).map((p) => ({
      customer_id: p.customer_id,
      name: p.name,
      phone: p.phone,
      items: p.items,
      total: p.total,
      total_formatted: `R$ ${formatMoneyBr(p.total)}`,
      earliest_due: p.earliest_due,
      events: p.events.slice(0, 4),
    })),
    truncated: people.length > limitPeople,
  });
}

async function listOpenCharges(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const eventIds = [
    ...(Array.isArray(args.event_ids) ? args.event_ids.map(String) : []),
    ...(args.event_id ? [String(args.event_id)] : []),
  ];
  const lines = openUnpaid(
    await loadCustomerLines(
      supabase,
      customerId,
      eventIds.length ? eventIds : undefined,
    ),
  );
  return ok({
    count: lines.length,
    lines: lines.map((l) => ({
      id: l.id,
      product_title: l.product_title,
      event_id: l.event_id,
      event_name: l.events?.name || "",
      event_kind: l.events?.kind,
      qty: lineQty(l),
      unit_price: lineUnitPrice(l),
      total: lineTotal(l),
      charged: l.charged,
      separated: l.separated,
    })),
  });
}

async function listGarage(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const status = String(args.status || "all");
  const { data: cust } = await supabase
    .from("customers")
    .select("phone, phone_digits")
    .eq("id", customerId)
    .maybeSingle();
  const relatedIds = await fetchRelatedCustomerIds(
    supabase,
    customerId,
    String(cust?.phone_digits || cust?.phone || ""),
  );
  let q = supabase
    .from("customer_garage_items")
    .select(
      "id, title, status, qty, qty_with_store, qty_sent, qty_delivered, event_name, event_id, unit_price, origin, created_at",
    )
    .in("customer_id", relatedIds)
    .order("created_at", { ascending: false })
    .limit(100);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return fail(error.message);
  return ok({ items: data || [] });
}

async function listPendingShipments(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const limit = Math.min(80, Number(args.limit) || 40);
  let q = supabase
    .from("customer_garage_items")
    .select(
      "id, title, qty_with_store, event_name, customer_id, customers:customer_id ( id, name, phone )",
    )
    .gt("qty_with_store", 0)
    .neq("status", "cancelled")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (args.customer_id) q = q.eq("customer_id", String(args.customer_id));
  const { data, error } = await q;
  if (error) return fail(error.message);
  return ok({ items: data || [] });
}

async function searchCards(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = String(args.query || "").trim();
  const limit = Math.min(30, Number(args.limit) || 15);
  const { data, error } = await supabase
    .from("cards")
    .select("id, name, set_code, condition, qty_in_stock, orderable")
    .or(`name.ilike.%${query}%,set_code.ilike.%${query}%`)
    .order("name")
    .limit(limit);
  if (error) return fail(error.message);
  return ok({ cards: data || [] });
}

async function draftBilling(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const eventIds = Array.isArray(args.event_ids)
    ? args.event_ids.map(String)
    : [];
  const { data: cust } = await supabase
    .from("customers")
    .select("id, name, phone")
    .eq("id", customerId)
    .maybeSingle();
  if (!cust) return fail("Cliente não encontrado.");

  const lines = openUnpaid(
    await loadCustomerLines(
      supabase,
      customerId,
      eventIds.length ? eventIds : undefined,
    ),
  );
  if (!lines.length) {
    return ok({ message: "Nada em aberto para cobrar.", text: "" });
  }

  const byEvent = new Map<string, SaleLineWithEvent[]>();
  for (const l of lines) {
    const key = l.event_id;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key)!.push(l);
  }

  const blocks: string[] = [];
  let grand = 0;
  let missing = 0;
  for (const group of byEvent.values()) {
    const ev = group[0].events;
    const msg = buildBillingMessage({
      kind: ev?.kind || "leilao",
      customerName: greetingName(cust.name, cust.phone, looksLikePhoneName),
      eventDate: eventHappenedOn({
        name: ev?.name,
        opened_at: ev?.opened_at,
      }),
      paymentDue: ev?.payment_due_at || null,
      lines: group.map((l) => ({
        product_title: l.product_title,
        unit_price: lineUnitPrice(l),
        qty: lineQty(l),
      })),
    });
    grand += msg.total;
    missing += msg.missingPrice;
    blocks.push(msg.text);
  }

  return ok({
    text: blocks.join("\n\n———\n\n"),
    total: grand,
    missing_price: missing,
    line_count: lines.length,
    hint: `Total R$ ${formatMoneyBr(grand)}${missing ? ` · ${missing} sem preço` : ""}`,
  });
}

async function listAudit(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const limit = Math.min(50, Number(args.limit) || 20);
  let q = supabase
    .from("staff_audit_log")
    .select("id, action, detail, created_at, customer_id, event_id, created_by")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (args.customer_id) q = q.eq("customer_id", String(args.customer_id));
  const { data, error } = await q;
  if (error) return fail(error.message);
  return ok({ entries: data || [] });
}

async function getCustomerName(
  supabase: SupabaseClient,
  customerId: string,
): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .from("customers")
    .select("id, name")
    .eq("id", customerId)
    .maybeSingle();
  return data;
}

async function proposeMarkPaid(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const cust = await getCustomerName(supabase, customerId);
  if (!cust) return fail("Cliente não encontrado.");

  const eventIds = Array.isArray(args.event_ids)
    ? args.event_ids.map(String)
    : [];
  const explicitIds = Array.isArray(args.line_ids)
    ? args.line_ids.map(String)
    : [];

  let lines = openUnpaid(
    await loadCustomerLines(
      supabase,
      customerId,
      eventIds.length ? eventIds : undefined,
    ),
  );
  if (explicitIds.length) {
    lines = lines.filter((l) => explicitIds.includes(l.id));
  }
  if (!lines.length) {
    return ok({
      message: "Nenhum item em aberto para marcar pago com esses filtros.",
    });
  }

  let total = 0;
  let missing = 0;
  const mapped = lines.map((l) => {
    const t = lineTotal(l);
    if (t == null) missing += 1;
    else total += t;
    return {
      id: l.id,
      product_title: l.product_title,
      event_name: l.events?.name || "",
      qty: lineQty(l),
      total: t,
    };
  });

  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "mark_paid",
    title: "Marcar pago → caixinha",
    summary: `${cust.name}: ${mapped.length} item(ns)${
      missing ? ` · ${missing} sem preço` : ` · R$ ${formatMoneyBr(total)}`
    }. Ao confirmar, entram na caixinha.`,
    customer_id: customerId,
    customer_name: cust.name,
    line_ids: mapped.map((l) => l.id),
    lines: mapped,
    total: missing ? null : total,
  };
  return ok(
    {
      message:
        "Proposta criada. Peça ao usuário para confirmar no cartão antes de considerar feito.",
      proposal_id: proposal.id,
    },
    [proposal],
  );
}

async function proposeMarkCharged(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
  value: boolean,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const eventIds = Array.isArray(args.event_ids)
    ? args.event_ids.map(String)
    : [];
  const explicitIds = Array.isArray(args.line_ids)
    ? args.line_ids.map(String)
    : [];
  let lines = openUnpaid(
    await loadCustomerLines(
      supabase,
      customerId,
      eventIds.length ? eventIds : undefined,
    ),
  );
  if (explicitIds.length) lines = lines.filter((l) => explicitIds.includes(l.id));
  lines = lines.filter((l) => Boolean(l.charged) !== value);
  if (!lines.length) {
    return ok({ message: "Nada para alterar em cobrança com esses filtros." });
  }
  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "mark_charged",
    title: value ? "Marcar cobrado" : "Desfazer cobrado",
    summary: `${lines.length} item(ns)`,
    value,
    line_ids: lines.map((l) => l.id),
    lines: lines.map((l) => ({
      id: l.id,
      product_title: l.product_title,
      event_name: l.events?.name || "",
    })),
  };
  return ok({ message: "Proposta criada.", proposal_id: proposal.id }, [
    proposal,
  ]);
}

async function proposeMarkSeparated(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
  value: boolean,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const eventIds = Array.isArray(args.event_ids)
    ? args.event_ids.map(String)
    : [];
  const explicitIds = Array.isArray(args.line_ids)
    ? args.line_ids.map(String)
    : [];
  let lines = (
    await loadCustomerLines(
      supabase,
      customerId,
      eventIds.length ? eventIds : undefined,
    )
  ).filter((l) => isActiveBillableSaleLine(l, l.events?.kind));
  if (explicitIds.length) lines = lines.filter((l) => explicitIds.includes(l.id));
  lines = lines.filter((l) => Boolean(l.separated) !== value);
  if (!lines.length) {
    return ok({ message: "Nada para alterar em separado." });
  }
  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "mark_separated",
    title: value ? "Marcar separado" : "Desfazer separado",
    summary: `${lines.length} item(ns)`,
    value,
    line_ids: lines.map((l) => l.id),
    lines: lines.map((l) => ({
      id: l.id,
      product_title: l.product_title,
      event_name: l.events?.name || "",
    })),
  };
  return ok({ message: "Proposta criada.", proposal_id: proposal.id }, [
    proposal,
  ]);
}

async function proposeCancelLines(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const reason = String(args.reason || "").trim();
  if (!reason) return fail("Motivo do cancelamento é obrigatório.");
  const eventIds = Array.isArray(args.event_ids)
    ? args.event_ids.map(String)
    : [];
  const explicitIds = Array.isArray(args.line_ids)
    ? args.line_ids.map(String)
    : [];
  let lines = await loadCustomerLines(
    supabase,
    customerId,
    eventIds.length ? eventIds : undefined,
  );
  if (explicitIds.length) lines = lines.filter((l) => explicitIds.includes(l.id));
  if (!lines.length) return ok({ message: "Nenhuma linha para cancelar." });

  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "cancel_lines",
    title: "Cancelar itens",
    summary: `${lines.length} item(ns) · motivo: ${reason}`,
    reason,
    line_ids: lines.map((l) => l.id),
    lines: lines.map((l) => ({
      id: l.id,
      product_title: l.product_title,
      event_name: l.events?.name || "",
      qty: lineQty(l),
    })),
  };
  return ok({ message: "Proposta criada.", proposal_id: proposal.id }, [
    proposal,
  ]);
}

async function proposeUnpay(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const eventIds = Array.isArray(args.event_ids)
    ? args.event_ids.map(String)
    : [];
  const explicitIds = Array.isArray(args.line_ids)
    ? args.line_ids.map(String)
    : [];
  let lines = (
    await loadCustomerLines(
      supabase,
      customerId,
      eventIds.length ? eventIds : undefined,
    )
  ).filter((l) => l.paid && !l.cancelled);
  if (explicitIds.length) lines = lines.filter((l) => explicitIds.includes(l.id));
  if (!lines.length) return ok({ message: "Nenhum item pago para desfazer." });

  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "unpay_lines",
    title: "Desfazer pagamento",
    summary: `${lines.length} item(ns). Só funciona se ainda não houve envio.`,
    line_ids: lines.map((l) => l.id),
    lines: lines.map((l) => ({
      id: l.id,
      product_title: l.product_title,
      event_name: l.events?.name || "",
    })),
  };
  return ok({ message: "Proposta criada.", proposal_id: proposal.id }, [
    proposal,
  ]);
}

async function proposeShipGarage(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const cust = await getCustomerName(supabase, customerId);
  if (!cust) return fail("Cliente não encontrado.");
  const shippedOn =
    String(args.shipped_on || "").slice(0, 10) ||
    new Date().toISOString().slice(0, 10);

  let q = supabase
    .from("customer_garage_items")
    .select("id, title, qty_with_store, event_name, event_id, status")
    .eq("customer_id", customerId)
    .gt("qty_with_store", 0)
    .neq("status", "cancelled");
  if (args.event_id) q = q.eq("event_id", String(args.event_id));
  if (Array.isArray(args.item_ids) && args.item_ids.length) {
    q = q.in("id", args.item_ids.map(String));
  }
  const { data, error } = await q;
  if (error) return fail(error.message);
  const items = data || [];
  if (!items.length) return ok({ message: "Nada na loja para enviar." });

  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "ship_garage_items",
    title: "Marcar enviado",
    summary: `${cust.name}: ${items.length} item(ns) em ${shippedOn}`,
    customer_id: customerId,
    customer_name: cust.name,
    item_ids: items.map((i) => i.id),
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      qty: Number(i.qty_with_store),
      event_name: i.event_name || "",
    })),
    shipped_on: shippedOn,
  };
  return ok({ message: "Proposta criada.", proposal_id: proposal.id }, [
    proposal,
  ]);
}

async function proposeCancelGarage(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const itemId = String(args.item_id || "");
  const reason = String(args.reason || "").trim();
  if (!reason) return fail("Motivo obrigatório.");
  const { data: item } = await supabase
    .from("customer_garage_items")
    .select("id, title, customer_id, status")
    .eq("id", itemId)
    .maybeSingle();
  if (!item) return fail("Item da caixinha não encontrado.");
  if (item.status === "cancelled") {
    return ok({ message: "Item já está cancelado." });
  }
  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "cancel_garage_item",
    title: "Cancelar item da caixinha",
    summary: `${item.title} · ${reason}`,
    reason,
    item_id: item.id,
    item_title: item.title,
    customer_id: item.customer_id,
  };
  return ok({ message: "Proposta criada.", proposal_id: proposal.id }, [
    proposal,
  ]);
}

async function proposeAddNote(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const customerId = String(args.customer_id || "");
  const body = String(args.body || "").trim();
  if (!body) return fail("Nota vazia.");
  const cust = await getCustomerName(supabase, customerId);
  if (!cust) return fail("Cliente não encontrado.");
  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "add_customer_note",
    title: "Adicionar nota",
    summary: `${cust.name}: ${body.slice(0, 120)}`,
    customer_id: customerId,
    customer_name: cust.name,
    body,
  };
  return ok({ message: "Proposta criada.", proposal_id: proposal.id }, [
    proposal,
  ]);
}

async function proposeEncomendaStock(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const eventId = String(args.event_id || "");
  const productTitle = String(args.product_title || "").trim();
  if (!eventId || !productTitle) return fail("event_id e product_title obrigatórios.");
  const { data: ev } = await supabase
    .from("events")
    .select("id, name, kind")
    .eq("id", eventId)
    .maybeSingle();
  if (!ev) return fail("Evento não encontrado.");

  const proposal: ActionProposal = {
    id: newProposalId(),
    kind: "set_encomenda_stock",
    title: "Atualizar estoque da encomenda",
    summary: `${ev.name} · ${productTitle}${
      args.pedido_feito != null
        ? ` · pedido_feito=${Boolean(args.pedido_feito)}`
        : ""
    }${
      args.qty_arrived != null ? ` · chegou=${Number(args.qty_arrived)}` : ""
    }`,
    event_id: eventId,
    product_title: productTitle,
    pedido_feito:
      args.pedido_feito === undefined ? undefined : Boolean(args.pedido_feito),
    qty_arrived:
      args.qty_arrived === undefined ? undefined : Number(args.qty_arrived),
  };
  return ok({ message: "Proposta criada.", proposal_id: proposal.id }, [
    proposal,
  ]);
}
