"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmButton } from "@/components/ConfirmButton";
import { createClient } from "@/lib/supabase/client";
import { logStaffAction } from "@/lib/audit";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import {
  buildBillingMessage,
  buildCombinedBillingMessage,
  daysSincePayment,
  formatDiaCurto,
  formatMoneyBr,
  greetingName,
  leilaoGarageUrgency,
} from "@/lib/cobranca-msg";
import {
  isShelvedSaleLine,
  parseMoneyFromOption,
  paymentUrgency,
} from "@/lib/leilao-resultado";
import {
  GARAGE_CATEGORY_LABEL,
  GARAGE_ORIGIN_LABEL,
  GARAGE_STATUS_LABEL,
  formatStaffName,
} from "@/lib/labels";
import type {
  Customer,
  CustomerNote,
  CustomerPhoto,
  Event,
  EventSaleLine,
  GarageAuditEvent,
  GarageCategory,
  GarageItem,
  GarageOrigin,
  GarageStatus,
} from "@/lib/types";

type Tab =
  | "garagem"
  | "reservados"
  | "enviados"
  | "entregues"
  | "cancelados"
  | "notas"
  | "auditoria";

type ChargeLine = EventSaleLine & {
  events?: Pick<
    Event,
    "id" | "name" | "opened_at" | "payment_due_at" | "kind" | "status"
  > | null;
};

type ChargeEventGroup = {
  key: string;
  eventId: string | null;
  eventName: string;
  eventDate: string | null;
  paymentDue: string | null;
  kind: string;
  lines: ChargeLine[];
  total: number;
  missingPrice: number;
};

const CATEGORIES = Object.keys(GARAGE_CATEGORY_LABEL) as GarageCategory[];
const ORIGINS = Object.keys(GARAGE_ORIGIN_LABEL) as GarageOrigin[];

function looksLikePhoneName(name: string): boolean {
  const digits = normalizePhoneDigits(name);
  return digits.length >= 10 && digits === name.replace(/\D/g, "");
}

function lineUnitPrice(line: ChargeLine): number | null {
  if (line.unit_price != null && Number.isFinite(Number(line.unit_price))) {
    return Number(line.unit_price);
  }
  return (
    parseMoneyFromOption(line.product_title) ??
    parseMoneyFromOption(line.valor_ou_opcao || "")
  );
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR");
}

function fmtDay(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = iso.length <= 10 ? `${iso}T12:00:00` : iso;
  return new Date(d).toLocaleDateString("pt-BR");
}

const TAB_KEYS = new Set<Tab>([
  "garagem",
  "reservados",
  "enviados",
  "entregues",
  "cancelados",
  "notas",
  "auditoria",
]);

export default function ClienteDetailPage() {
  const params = useParams<{ id: string }>();
  const customerId = params.id;
  const supabase = useMemo(() => createClient(), []);

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [items, setItems] = useState<GarageItem[]>([]);
  const [chargeLines, setChargeLines] = useState<ChargeLine[]>([]); // todas as linhas ativas (pago e em aberto)
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [photos, setPhotos] = useState<CustomerPhoto[]>([]);
  const [audit, setAudit] = useState<GarageAuditEvent[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState("Staff");
  const [tab, setTab] = useState<Tab>("garagem");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editName, setEditName] = useState("");
  const [editingName, setEditingName] = useState(false);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<GarageCategory>("carta");
  const [qty, setQty] = useState(1);
  const [asReserved, setAsReserved] = useState(false);
  const [reservedUntil, setReservedUntil] = useState("");
  const [origin, setOrigin] = useState<GarageOrigin>("compra_direta");
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [itemNotes, setItemNotes] = useState("");

  const [selected, setSelected] = useState<Record<string, number>>({});
  const [noteBody, setNoteBody] = useState("");
  const [photoCaption, setPhotoCaption] = useState("");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && TAB_KEYS.has(t as Tab)) setTab(t as Tab);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    const auth = await supabase.auth.getUser();
    const uid = auth.data.user?.id ?? null;
    setMeId(uid);
    if (uid) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("name")
        .eq("id", uid)
        .maybeSingle();
      setMeName(profile?.name || auth.data.user?.email || "Staff");
    }

    const [cu, gi, nt, ph, profiles, ev] = await Promise.all([
      supabase.from("customers").select("*").eq("id", customerId).single(),
      supabase
        .from("customer_garage_items")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false }),
      supabase
        .from("customer_notes")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false }),
      supabase
        .from("customer_photos")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false }),
      supabase.from("profiles").select("id, name"),
      supabase
        .from("customer_garage_events")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (cu.error) setError(cu.error.message);
    else {
      setCustomer(cu.data as Customer);
      setEditName((cu.data as Customer).name);
    }

    const phoneDigits =
      (cu.data as Customer | null)?.phone_digits ||
      normalizePhoneDigits((cu.data as Customer | null)?.phone || "");

    const saleQuery = supabase
      .from("event_sale_lines")
      .select(
        "*, events(id, name, opened_at, payment_due_at, kind, status)",
      )
      .eq("cancelled", false)
      .order("created_at", { ascending: false })
      .limit(400);

    const saleRes = phoneDigits
      ? await saleQuery.or(
          `customer_id.eq.${customerId},phone_digits.eq.${phoneDigits}`,
        )
      : await saleQuery.eq("customer_id", customerId);

    if (saleRes.error) setChargeLines([]);
    else setChargeLines((saleRes.data as ChargeLine[]) || []);

    const nameById = new Map<string, string>();
    for (const p of profiles.data || []) {
      nameById.set(p.id as string, p.name as string);
    }
    const withStaff = <T extends { created_by?: string | null; cancelled_by?: string | null }>(
      row: T,
    ) => ({
      ...row,
      created_by_profile: row.created_by
        ? { id: row.created_by, name: nameById.get(row.created_by) || "Staff" }
        : null,
      cancelled_by_profile: row.cancelled_by
        ? {
            id: row.cancelled_by,
            name: nameById.get(row.cancelled_by) || "Staff",
          }
        : null,
    });

    if (gi.error) setError(gi.error.message);
    else setItems(((gi.data || []) as GarageItem[]).map(withStaff));

    if (nt.error) setError(nt.error.message);
    else setNotes(((nt.data || []) as CustomerNote[]).map(withStaff));

    if (ph.error) setError(ph.error.message);
    else setPhotos(((ph.data || []) as CustomerPhoto[]).map(withStaff));

    if (ev.error) {
      // tabela pode existir; se falhar, só não mostra auditoria
      setAudit([]);
    } else {
      setAudit(
        ((ev.data || []) as GarageAuditEvent[]).map((row) => ({
          ...row,
          created_by_profile: row.created_by
            ? {
                id: row.created_by,
                name: nameById.get(row.created_by) || "Staff",
              }
            : null,
        })),
      );
    }
  }, [supabase, customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function logEvent(action: string, detail: string, itemId?: string) {
    await supabase.from("customer_garage_events").insert({
      customer_id: customerId,
      item_id: itemId || null,
      action,
      detail,
      created_by: meId,
    });
    await logStaffAction(supabase, {
      action,
      detail,
      created_by: meId,
      entity_type: "customer_garage",
      entity_id: itemId || "",
      customer_id: customerId,
    });
  }

  async function saveName() {
    if (!editName.trim()) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("customers")
      .update({ name: editName.trim() })
      .eq("id", customerId);
    setBusy(false);
    if (err) setError(err.message);
    else {
      setEditingName(false);
      setInfo("Nome atualizado.");
      await load();
    }
  }

  async function addItem(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    const q = Math.max(1, qty);
    const status: GarageStatus = asReserved ? "reserved" : "in_garage";
    const { data, error: err } = await supabase
      .from("customer_garage_items")
      .insert({
        customer_id: customerId,
        title: title.trim(),
        category,
        qty: q,
        qty_with_store: q,
        qty_sent: 0,
        qty_delivered: 0,
        status,
        reserved_until: asReserved && reservedUntil ? reservedUntil : null,
        origin,
        event_name: eventName.trim(),
        event_date: eventDate || null,
        unit_price: unitPrice ? Number(unitPrice) : null,
        notes: itemNotes.trim(),
        created_by: meId,
      })
      .select("id")
      .single();
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    await logEvent(
      "add",
      `${title.trim()} ×${q} · ${GARAGE_STATUS_LABEL[status]} · por ${meName}`,
      data?.id,
    );
    setTitle("");
    setQty(1);
    setAsReserved(false);
    setReservedUntil("");
    setEventName("");
    setEventDate("");
    setUnitPrice("");
    setItemNotes("");
    setInfo("Produto associado ao cliente.");
    await load();
  }

  async function moveQty(
    item: GarageItem,
    amount: number,
    kind: "send" | "deliver" | "unsend",
  ) {
    const n = Math.max(1, amount);
    setError(null);
    let next = { ...item };
    if (kind === "send") {
      if (item.qty_with_store < n) {
        setError("Quantidade na loja insuficiente.");
        return;
      }
      next.qty_with_store -= n;
      next.qty_sent += n;
      if (next.status === "reserved") next.status = "in_garage";
      if (next.qty_with_store === 0 && next.qty_delivered === 0) {
        next.status = "shipped";
      } else if (next.qty_with_store > 0) {
        next.status = "in_garage";
      }
    } else if (kind === "unsend") {
      if (item.qty_sent < n) {
        setError("Quantidade enviada insuficiente para desfazer.");
        return;
      }
      next.qty_sent -= n;
      next.qty_with_store += n;
      if (next.qty_sent === 0 && next.qty_delivered === 0) {
        next.status = "in_garage";
      } else if (next.qty_with_store > 0) {
        next.status = "in_garage";
      } else if (next.qty_sent > 0) {
        next.status = "shipped";
      }
    } else {
      if (item.qty_sent < n) {
        setError("Quantidade enviada insuficiente.");
        return;
      }
      next.qty_sent -= n;
      next.qty_delivered += n;
      if (next.qty_with_store === 0 && next.qty_sent === 0) {
        next.status = "delivered";
      }
    }

    const { error: err } = await supabase
      .from("customer_garage_items")
      .update({
        qty_with_store: next.qty_with_store,
        qty_sent: next.qty_sent,
        qty_delivered: next.qty_delivered,
        status: next.status,
      })
      .eq("id", item.id);
    if (err) {
      setError(err.message);
      return;
    }
    const actionLabel =
      kind === "send" ? "send" : kind === "unsend" ? "unsend" : "deliver";
    const detailLabel =
      kind === "send"
        ? "enviado(s)"
        : kind === "unsend"
          ? "envio desfeito → voltou pra loja"
          : "entregue(s)";
    await logEvent(
      actionLabel,
      `${item.title}: ${n} ${detailLabel} · por ${meName}`,
      item.id,
    );
    if (kind === "send") {
      setInfo(
        `Marcado como enviado · abra a aba Enviados para desfazer se foi engano.`,
      );
      setTab("enviados");
    } else if (kind === "unsend") {
      setInfo(`Envio desfeito · ${n} un. de volta na loja · ${meName}`);
      setTab("garagem");
    } else {
      setInfo(null);
    }
    setSelected((s) => {
      const copy = { ...s };
      delete copy[item.id];
      return copy;
    });
    await load();
  }

  async function cancelItem(item: GarageItem, reason: string) {
    setError(null);
    const { error: err } = await supabase
      .from("customer_garage_items")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_by: meId,
        cancel_reason: reason.trim() || "Estorno / cancelamento",
      })
      .eq("id", item.id);
    if (err) {
      setError(err.message);
      return;
    }
    await logEvent(
      "cancel",
      `${item.title} cancelado/estornado · por ${meName}` +
        (reason ? ` · ${reason}` : ""),
      item.id,
    );
    await load();
  }

  async function markPaid(item: GarageItem) {
    setError(null);
    const { error: err } = await supabase
      .from("customer_garage_items")
      .update({
        status: "in_garage",
        reserved_until: null,
      })
      .eq("id", item.id)
      .eq("status", "reserved");
    if (err) {
      setError(err.message);
      return;
    }
    await logEvent(
      "paid",
      `${item.title} pago → caixinha na loja · por ${meName}`,
      item.id,
    );
    await load();
  }

  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!noteBody.trim()) return;
    const { error: err } = await supabase.from("customer_notes").insert({
      customer_id: customerId,
      body: noteBody.trim(),
      created_by: meId,
    });
    if (err) setError(err.message);
    else {
      setNoteBody("");
      await load();
    }
  }

  async function uploadPhoto(file: File) {
    setBusy(true);
    setError(null);
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${customerId}/${Date.now()}.${ext}`;
    const up = await supabase.storage
      .from("customer-photos")
      .upload(path, file, { upsert: false });
    if (up.error) {
      setBusy(false);
      setError(
        up.error.message +
          " — confira se rodou a migration e se o bucket customer-photos existe.",
      );
      return;
    }
    const { data: pub } = supabase.storage
      .from("customer-photos")
      .getPublicUrl(path);
    const { error: err } = await supabase.from("customer_photos").insert({
      customer_id: customerId,
      storage_path: path,
      public_url: pub.publicUrl,
      caption: photoCaption.trim(),
      created_by: meId,
    });
    setBusy(false);
    if (err) setError(err.message);
    else {
      setPhotoCaption("");
      await load();
    }
  }

  const reserved = items.filter(
    (i) => i.status === "reserved" && !i.cancelled_at,
  );
  const garage = items.filter(
    (i) => i.status !== "cancelled" && i.qty_with_store > 0,
  );
  const sent = items.filter((i) => i.status !== "cancelled" && i.qty_sent > 0);
  const delivered = items.filter(
    (i) => i.status !== "cancelled" && i.qty_delivered > 0,
  );
  const cancelled = items.filter((i) => i.status === "cancelled");

  const chargeGroups = useMemo(() => {
    const byEvent = new Map<string, ChargeEventGroup>();
    for (const line of chargeLines) {
      if (line.paid) continue;
      const kind = line.events?.kind || "outro";
      if (isShelvedSaleLine(line, kind)) continue;
      const eventId = line.event_id || line.events?.id || null;
      const eventName = line.events?.name || "Evento";
      const eventDate =
        line.events?.opened_at?.slice(0, 10) || null;
      const paymentDue = line.events?.payment_due_at || null;
      const key = eventId || `ev:${eventName}:${eventDate || ""}`;
      let g = byEvent.get(key);
      if (!g) {
        g = {
          key,
          eventId,
          eventName,
          eventDate,
          paymentDue,
          kind,
          lines: [],
          total: 0,
          missingPrice: 0,
        };
        byEvent.set(key, g);
      }
      g.lines.push(line);
      const price = lineUnitPrice(line);
      const qty = Number(line.qty) > 0 ? Number(line.qty) : 1;
      if (price == null) g.missingPrice += 1;
      else g.total += price * qty;
    }
    const list = [...byEvent.values()];
    list.sort((a, b) => {
      const kindRank = (k: string) =>
        k === "leilao" ? 0 : k === "encomenda" ? 1 : 2;
      return (
        kindRank(a.kind) - kindRank(b.kind) ||
        (b.eventDate || "").localeCompare(a.eventDate || "")
      );
    });
    return list;
  }, [chargeLines]);

  const nextPaymentDue = useMemo(() => {
    let best: ChargeEventGroup | null = null;
    for (const g of chargeGroups) {
      if (!g.paymentDue) continue;
      if (!best || (g.paymentDue || "") < (best.paymentDue || "")) best = g;
    }
    if (!best?.paymentDue) return null;
    const urgency = paymentUrgency(false, false, best.paymentDue);
    return {
      group: best,
      urgency,
      label: formatDiaCurto(best.paymentDue),
    };
  }, [chargeGroups]);

  const leilaoGarageAlerts = useMemo(() => {
    const rows: Array<{
      item: GarageItem;
      daysHeld: number;
      urgency: "ok" | "warn" | "overdue" | "none";
    }> = [];
    for (const item of garage) {
      if (item.origin !== "leilao") continue;
      const daysHeld = daysSincePayment(item.created_at);
      if (daysHeld == null) continue;
      const urgency = leilaoGarageUrgency(daysHeld);
      if (urgency === "ok" || urgency === "none") continue;
      rows.push({ item, daysHeld, urgency });
    }
    rows.sort((a, b) => b.daysHeld - a.daysHeld);
    return rows;
  }, [garage]);

  const eventHistory = useMemo(() => {
    const byId = new Map<
      string,
      {
        eventId: string;
        eventName: string;
        eventDate: string | null;
        kind: string;
        openItems: number;
        paidItems: number;
      }
    >();
    for (const line of chargeLines) {
      const kind = line.events?.kind || "outro";
      if (isShelvedSaleLine(line, kind)) continue;
      const eventId = line.event_id || line.events?.id;
      if (!eventId) continue;
      let row = byId.get(eventId);
      if (!row) {
        row = {
          eventId,
          eventName: line.events?.name || "Evento",
          eventDate: line.events?.opened_at?.slice(0, 10) || null,
          kind,
          openItems: 0,
          paidItems: 0,
        };
        byId.set(eventId, row);
      }
      if (line.paid) row.paidItems += 1;
      else row.openItems += 1;
    }
    return [...byId.values()]
      .sort((a, b) => (b.eventDate || "").localeCompare(a.eventDate || ""))
      .slice(0, 12);
  }, [chargeLines]);

  const whatsappUrl = useMemo(() => {
    const digits = normalizePhoneDigits(customer?.phone || customer?.phone_digits || "");
    if (digits.length < 10) return null;
    return `https://wa.me/${digits}`;
  }, [customer]);

  const leilaoCharges = useMemo(
    () => chargeGroups.filter((g) => g.kind === "leilao"),
    [chargeGroups],
  );
  const encomendaCharges = useMemo(
    () => chargeGroups.filter((g) => g.kind === "encomenda"),
    [chargeGroups],
  );
  const otherCharges = useMemo(
    () =>
      chargeGroups.filter((g) => g.kind !== "leilao" && g.kind !== "encomenda"),
    [chargeGroups],
  );

  const chargeTotals = useMemo(() => {
    let total = 0;
    let missing = 0;
    let items = 0;
    for (const g of chargeGroups) {
      total += g.total;
      missing += g.missingPrice;
      items += g.lines.length;
    }
    return { total, missing, items };
  }, [chargeGroups]);

  function customerGreeting() {
    if (!customer) return "@cliente";
    return greetingName(customer.name, customer.phone || "", looksLikePhoneName);
  }

  async function copyEventCharge(group: ChargeEventGroup) {
    const { text, missingPrice } = buildBillingMessage({
      kind: group.kind,
      customerName: customerGreeting(),
      eventDate: group.eventDate,
      paymentDue: group.paymentDue,
      lines: group.lines.map((l) => ({
        product_title: l.product_title,
        unit_price: lineUnitPrice(l),
        qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
      })),
    });
    try {
      await navigator.clipboard.writeText(text);
      setInfo(
        missingPrice > 0
          ? `Cobrança copiada · ${missingPrice} item(ns) sem valor (R$ ?).`
          : `Cobrança copiada · ${group.eventName}`,
      );
    } catch {
      setError("Não foi possível copiar a mensagem.");
    }
  }

  async function copyAllCharges() {
    if (!chargeGroups.length) {
      setError("Nenhuma cobrança em aberto para este cliente.");
      return;
    }
    const { text, missingPrice } = buildCombinedBillingMessage({
      customerName: customerGreeting(),
      events: chargeGroups.map((g) => ({
        kind: g.kind,
        eventName: g.eventName,
        eventDate: g.eventDate,
        paymentDue: g.paymentDue,
        lines: g.lines.map((l) => ({
          product_title: l.product_title,
          unit_price: lineUnitPrice(l),
          qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
        })),
      })),
    });
    try {
      await navigator.clipboard.writeText(text);
      setInfo(
        missingPrice > 0
          ? `Cobrança unificada copiada · ${missingPrice} item(ns) sem valor.`
          : `Cobrança unificada copiada · R$ ${formatMoneyBr(chargeTotals.total)}`,
      );
    } catch {
      setError("Não foi possível copiar a mensagem.");
    }
  }

  async function markLinesCharged(
    lines: ChargeLine[],
    value: boolean,
    label: string,
  ) {
    const ids = lines.filter((l) => !l.paid && Boolean(l.charged) !== value).map((l) => l.id);
    if (!ids.length) {
      setInfo(
        value
          ? "Nada pendente — já estava marcado como cobrado."
          : "Nada para desfazer — nenhum item cobrado.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({
        charged: value,
        charged_at: value ? new Date().toISOString() : null,
        charged_by: value ? meId : null,
      })
      .in("id", ids);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    await logStaffAction(supabase, {
      action: value ? "mark_charged" : "unmark_charged",
      detail: `${label} · ${ids.length} item(ns) · ${meName}`,
      created_by: meId,
      entity_type: "customer",
      entity_id: customerId,
      customer_id: customerId,
    });
    setInfo(
      value
        ? `Marcado como cobrado · ${ids.length} item(ns) · ${label}`
        : `Cobrança desfeita · ${ids.length} item(ns) · ${label}`,
    );
    await load();
  }

  const unchargedOpenCount = useMemo(
    () =>
      chargeGroups.reduce(
        (s, g) => s + g.lines.filter((l) => !l.charged).length,
        0,
      ),
    [chargeGroups],
  );

  const counts: Record<Tab, number> = {
    garagem: garage.length,
    reservados: reserved.length,
    enviados: sent.length,
    entregues: delivered.length,
    cancelados: cancelled.length,
    notas: notes.length + photos.length,
    auditoria: audit.length,
  };

  function renderItemRow(
    item: GarageItem,
    opts: {
      showStore?: boolean;
      showSent?: boolean;
      showDelivered?: boolean;
      actions?: "garage" | "reserved" | "sent" | "none";
    },
  ) {
    const selQty = selected[item.id] ?? 1;
    return (
      <tr key={`${opts.actions}-${item.id}`}>
        <td>
          <div className="font-medium">{item.title}</div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            <Badge tone="neutral">{GARAGE_CATEGORY_LABEL[item.category]}</Badge>
            <Badge tone="info">{GARAGE_ORIGIN_LABEL[item.origin]}</Badge>
            {item.event_name ? (
              <Badge tone="warn">
                {item.event_name}
                {item.event_date ? ` · ${fmtDay(item.event_date)}` : ""}
              </Badge>
            ) : null}
          </div>
          {item.notes ? (
            <p className="mt-1 text-xs text-zinc-500">{item.notes}</p>
          ) : null}
          <p className="mt-1 text-xs text-zinc-500">
            Associado em {fmtDate(item.created_at)} ·{" "}
            {formatStaffName(item.created_by_profile, "Staff")}
          </p>
          {item.status === "cancelled" ? (
            <p className="mt-1 text-xs text-red-700">
              Cancelado em {fmtDate(item.cancelled_at)} ·{" "}
              {formatStaffName(item.cancelled_by_profile)} ·{" "}
              {item.cancel_reason || "estorno"}
            </p>
          ) : null}
        </td>
        <td className="font-mono text-sm whitespace-nowrap">
          {opts.showStore ? (
            <div>
              Loja: <strong>{item.qty_with_store}</strong>
            </div>
          ) : null}
          {opts.showSent ? (
            <div>
              Enviado: <strong>{item.qty_sent}</strong>
            </div>
          ) : null}
          {opts.showDelivered ? (
            <div>
              Entregue: <strong>{item.qty_delivered}</strong>
            </div>
          ) : null}
          <div className="text-xs text-zinc-500">Total: {item.qty}</div>
          {item.qty_with_store > 0 && item.qty_sent > 0 ? (
            <Badge tone="warn">Envio parcial</Badge>
          ) : null}
        </td>
        <td className="text-sm">
          {item.unit_price != null ? `R$ ${Number(item.unit_price).toFixed(2)}` : "—"}
        </td>
        <td>
          {opts.actions === "garage" ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
              <input
                className="field w-16"
                type="number"
                min={1}
                max={item.qty_with_store}
                value={selQty}
                onChange={(e) =>
                  setSelected((s) => ({
                    ...s,
                    [item.id]: Number(e.target.value),
                  }))
                }
              />
              <button
                type="button"
                className="btn-primary"
                onClick={() => moveQty(item, selQty, "send")}
              >
                Marcar enviado
              </button>
              {item.qty_sent > 0 ? (
                <ConfirmButton
                  label="Voltar envio pra loja"
                  confirmLabel="Desfazer envio parcial?"
                  className="btn-secondary"
                  onConfirm={() =>
                    moveQty(item, Math.min(selQty, item.qty_sent), "unsend")
                  }
                />
              ) : null}
              <ConfirmButton
                label="Cancelar item (estorno)"
                confirmLabel="Estornar de vez?"
                className="btn-danger"
                onConfirm={() =>
                  cancelItem(
                    item,
                    window.prompt("Motivo do cancelamento/estorno:") || "",
                  )
                }
              />
            </div>
          ) : null}
          {opts.actions === "reserved" ? (
            <div className="flex flex-col gap-2">
              {item.reserved_until ? (
                <span className="text-xs text-amber-800">
                  Pagar até {fmtDay(item.reserved_until)}
                </span>
              ) : null}
              <button
                type="button"
                className="btn-primary"
                onClick={() => markPaid(item)}
              >
                Marcar pago (vai pra caixinha)
              </button>
              <ConfirmButton
                label="Cancelar reserva"
                confirmLabel="Cancelar?"
                className="btn-danger"
                onConfirm={() =>
                  cancelItem(
                    item,
                    window.prompt("Motivo:") || "Reserva cancelada",
                  )
                }
              />
            </div>
          ) : null}
          {opts.actions === "sent" ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
              <input
                className="field w-16"
                type="number"
                min={1}
                max={item.qty_sent}
                value={selQty}
                onChange={(e) =>
                  setSelected((s) => ({
                    ...s,
                    [item.id]: Number(e.target.value),
                  }))
                }
              />
              <button
                type="button"
                className="btn-primary"
                onClick={() => moveQty(item, selQty, "deliver")}
              >
                Marcar entregue
              </button>
              <ConfirmButton
                label="Voltar pra loja (desfazer envio)"
                confirmLabel="Desfazer envio?"
                className="btn-secondary"
                onConfirm={() => moveQty(item, selQty, "unsend")}
              />
            </div>
          ) : null}
        </td>
      </tr>
    );
  }

  if (!customer) {
    return <p className="text-sm text-zinc-600">Carregando cliente...</p>;
  }

  return (
    <div>
      <PageHeader
        title={editingName ? "Editar nome" : customer.name}
        description={`WhatsApp: ${customer.phone || "—"} · Você: ${meName}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {whatsappUrl ? (
              <a
                className="btn-primary"
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Abrir WhatsApp
              </a>
            ) : null}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setTab("garagem");
                requestAnimationFrame(() => {
                  document
                    .getElementById("caixinha-garagem")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
              }}
            >
              Caixinha/garagem ({counts.garagem})
            </button>
            {editingName ? (
              <>
                <input
                  className="field w-56"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => void saveName()}
                >
                  Salvar nome
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setEditingName(false);
                    setEditName(customer.name);
                  }}
                >
                  Cancelar
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setEditingName(true)}
              >
                Trocar nome
              </button>
            )}
            <Link href="/clientes" className="btn-secondary">
              Voltar
            </Link>
          </div>
        }
      />

      {error ? (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {info}
        </p>
      ) : null}

      <section className="panel mb-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Resumo do cliente</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Caixinha, cobranças, prazos e eventos. A mensagem unificada
              separa cada evento.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="info">Caixinha: {garage.length}</Badge>
            <Badge tone={chargeTotals.items > 0 ? "warn" : "neutral"}>
              Em aberto: {chargeTotals.items} item(ns)
            </Badge>
            {chargeTotals.items > 0 ? (
              <Badge tone="bad">
                R$ {formatMoneyBr(chargeTotals.total)}
              </Badge>
            ) : null}
          </div>
        </div>

        {nextPaymentDue ? (
          <div
            className={`rounded-md border px-3 py-2 text-sm ${
              nextPaymentDue.urgency === "overdue"
                ? "border-red-300 bg-red-50 text-red-900"
                : nextPaymentDue.urgency === "warn"
                  ? "border-amber-300 bg-amber-50 text-amber-950"
                  : "border-zinc-200 bg-zinc-50 text-zinc-800"
            }`}
          >
            <strong>
              {nextPaymentDue.urgency === "overdue"
                ? "Prazo atrasado"
                : nextPaymentDue.urgency === "warn"
                  ? "Prazo perto"
                  : "Próximo pagamento"}
              :
            </strong>{" "}
            até {nextPaymentDue.label}
            {" · "}
            {nextPaymentDue.group.kind === "leilao"
              ? "Leilão"
              : nextPaymentDue.group.kind === "encomenda"
                ? "Encomenda"
                : "Evento"}{" "}
            {nextPaymentDue.group.eventName}
            {nextPaymentDue.group.eventId ? (
              <>
                {" · "}
                <Link
                  className="underline"
                  href={`/eventos/${nextPaymentDue.group.eventId}`}
                >
                  abrir
                </Link>
              </>
            ) : null}
          </div>
        ) : null}

        {leilaoGarageAlerts.length > 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50/70 px-3 py-3">
            <h3 className="text-sm font-semibold text-amber-950">
              Leilão na caixinha · prazo de 2 meses ({leilaoGarageAlerts.length})
            </h3>
            <p className="mt-1 text-xs text-amber-900/80">
              Conta a partir do pagamento. Amarelo ≈ 50 dias; vermelho ≥ 60.
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {leilaoGarageAlerts.map(({ item, daysHeld, urgency }) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    {item.title}
                    {item.event_name ? (
                      <span className="text-xs text-zinc-600">
                        {" "}
                        · {item.event_name}
                      </span>
                    ) : null}
                  </span>
                  <Badge tone={urgency === "overdue" ? "bad" : "warn"}>
                    {daysHeld}d na loja
                  </Badge>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn-secondary mt-2 px-2 py-1 text-xs"
              onClick={() => {
                setTab("garagem");
                requestAnimationFrame(() => {
                  document
                    .getElementById("caixinha-garagem")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
              }}
            >
              Ir para Caixinha/garagem
            </button>
          </div>
        ) : null}

        {eventHistory.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-zinc-800">
              Eventos deste cliente ({eventHistory.length}
              {eventHistory.length >= 12 ? "+" : ""})
            </h3>
            <ul className="flex flex-wrap gap-2">
              {eventHistory.map((ev) => (
                <li key={ev.eventId}>
                  <Link
                    href={`/eventos/${ev.eventId}`}
                    className="inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs hover:bg-zinc-50"
                  >
                    <span className="font-medium text-zinc-900">
                      {ev.kind === "leilao"
                        ? "Leilão"
                        : ev.kind === "encomenda"
                          ? "Encomenda"
                          : ev.kind}{" "}
                      · {fmtDay(ev.eventDate)}
                    </span>
                    <span className="text-zinc-500">
                      {ev.openItems > 0
                        ? `${ev.openItems} em aberto`
                        : `${ev.paidItems} pago(s)`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {chargeTotals.items === 0 ? (
          <p className="text-sm text-zinc-500">
            Nenhuma cobrança em aberto neste momento.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void copyAllCharges()}
              >
                Copiar cobrança de tudo
              </button>
              {unchargedOpenCount > 0 ? (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    void markLinesCharged(
                      chargeGroups.flatMap((g) => g.lines),
                      true,
                      "todos os eventos em aberto",
                    )
                  }
                >
                  Marcar tudo como cobrado ({unchargedOpenCount})
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    void markLinesCharged(
                      chargeGroups.flatMap((g) => g.lines),
                      false,
                      "todos os eventos em aberto",
                    )
                  }
                >
                  Desfazer cobrado (tudo)
                </button>
              )}
              {chargeTotals.missing > 0 ? (
                <Badge tone="bad">
                  {chargeTotals.missing} sem valor (revise no evento)
                </Badge>
              ) : null}
            </div>

            {(
              [
                ["Leilão — cobranças", leilaoCharges],
                ["Encomenda — cobranças", encomendaCharges],
                ["Outros eventos", otherCharges],
              ] as const
            ).map(([title, groups]) =>
              groups.length === 0 ? null : (
                <div key={title} className="space-y-3">
                  <h3 className="text-sm font-semibold text-zinc-800">
                    {title} ({groups.reduce((s, g) => s + g.lines.length, 0)})
                  </h3>
                  {groups.map((g) => (
                    <div
                      key={g.key}
                      className="rounded-md border border-zinc-200 bg-zinc-50/60 px-3 py-3"
                    >
                      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-medium text-zinc-900">
                            {g.eventName}
                          </div>
                          <div className="text-xs text-zinc-500">
                            {fmtDay(g.eventDate)}
                            {g.paymentDue
                              ? ` · pagar até ${fmtDay(g.paymentDue)}`
                              : ""}
                            {" · "}
                            R$ {formatMoneyBr(g.total)}
                            {g.missingPrice
                              ? ` · ${g.missingPrice} sem R$`
                              : ""}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn-secondary px-2 py-1 text-xs"
                            onClick={() => void copyEventCharge(g)}
                          >
                            Copiar cobrança
                          </button>
                          {g.lines.some((l) => !l.charged) ? (
                            <button
                              type="button"
                              className="btn-primary px-2 py-1 text-xs"
                              disabled={busy}
                              onClick={() =>
                                void markLinesCharged(
                                  g.lines,
                                  true,
                                  g.eventName,
                                )
                              }
                            >
                              Marcar cobrado
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn-secondary px-2 py-1 text-xs"
                              disabled={busy}
                              onClick={() =>
                                void markLinesCharged(
                                  g.lines,
                                  false,
                                  g.eventName,
                                )
                              }
                            >
                              Desfazer cobrado
                            </button>
                          )}
                          {g.eventId ? (
                            <Link
                              className="btn-secondary px-2 py-1 text-xs"
                              href={`/eventos/${g.eventId}`}
                            >
                              Abrir evento
                            </Link>
                          ) : null}
                        </div>
                      </div>
                      <ul className="space-y-1 text-sm">
                        {g.lines.map((l) => {
                          const price = lineUnitPrice(l);
                          const qty =
                            Number(l.qty) > 0 ? Number(l.qty) : 1;
                          return (
                            <li
                              key={l.id}
                              className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 py-1 last:border-0"
                            >
                              <span className="flex flex-wrap items-center gap-2">
                                {l.product_title}
                                {qty > 1 ? ` ×${qty}` : ""}
                                {l.charged ? (
                                  <Badge tone="warn">cobrado</Badge>
                                ) : (
                                  <Badge tone="neutral">não cobrado</Badge>
                                )}
                              </span>
                              <span className="font-mono text-xs">
                                {price != null
                                  ? `R$ ${formatMoneyBr(price * qty)}`
                                  : "Falta valor"}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              ),
            )}
          </>
        )}
      </section>

      <form onSubmit={addItem} className="panel mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <h2 className="sm:col-span-2 lg:col-span-4 text-base font-semibold">
          Adicionar na Caixinha/garagem deste cliente
        </h2>
        <label className="text-sm lg:col-span-2">
          <span className="mb-1 block text-zinc-600">Produto</span>
          <input
            className="field"
            required
            placeholder="Ex.: Charizard, Box Prismatic, Sleeve Matte…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Tipo</span>
          <select
            className="field"
            value={category}
            onChange={(e) => setCategory(e.target.value as GarageCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {GARAGE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Qtd</span>
          <input
            className="field"
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Origem</span>
          <select
            className="field"
            value={origin}
            onChange={(e) => setOrigin(e.target.value as GarageOrigin)}
          >
            {ORIGINS.map((o) => (
              <option key={o} value={o}>
                {GARAGE_ORIGIN_LABEL[o]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Valor (opc.)</span>
          <input
            className="field"
            type="number"
            min={0}
            step="0.01"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Evento (nome)</span>
          <input
            className="field"
            placeholder="Ex.: Leilão Ago"
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Data do evento</span>
          <input
            className="field"
            type="date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-700 lg:col-span-2">
          <input
            type="checkbox"
            checked={asReserved}
            onChange={(e) => setAsReserved(e.target.checked)}
          />
          Reservado (ainda não pago)
        </label>
        {asReserved ? (
          <label className="text-sm">
            <span className="mb-1 block text-zinc-600">Pagar até</span>
            <input
              className="field"
              type="date"
              value={reservedUntil}
              onChange={(e) => setReservedUntil(e.target.value)}
            />
          </label>
        ) : null}
        <label className="text-sm sm:col-span-2 lg:col-span-4">
          <span className="mb-1 block text-zinc-600">Observação do produto</span>
          <input
            className="field"
            value={itemNotes}
            onChange={(e) => setItemNotes(e.target.value)}
          />
        </label>
        <div className="sm:col-span-2 lg:col-span-4">
          <button type="submit" className="btn-primary" disabled={busy}>
            Associar (responsável: {meName})
          </button>
        </div>
      </form>

      <div id="caixinha-garagem" className="mb-4 scroll-mt-4">
        <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ["garagem", "Caixinha/garagem"],
            ["reservados", "Reservados"],
            ["enviados", "Enviados"],
            ["entregues", "Entregues"],
            ["cancelados", "Cancelados"],
            ["notas", "Notas e fotos"],
            ["auditoria", "Auditoria"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "btn-primary" : "btn-secondary"}
            onClick={() => setTab(key)}
          >
            {label} ({counts[key]})
          </button>
        ))}
        </div>
      </div>

      {tab === "garagem" ? (
        garage.length === 0 ? (
          <EmptyState
            title="Caixinha/garagem vazia"
            hint="Associe produtos pagos que estão conosco, ou marque pago no evento para entrar aqui."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Qtds</th>
                  <th>Valor</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {garage.map((item) =>
                  renderItemRow(item, {
                    showStore: true,
                    showSent: true,
                    actions: "garage",
                  }),
                )}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === "reservados" ? (
        reserved.length === 0 ? (
          <EmptyState title="Sem reservas" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Qtds</th>
                  <th>Valor</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {reserved.map((item) =>
                  renderItemRow(item, {
                    showStore: true,
                    actions: "reserved",
                  }),
                )}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === "enviados" ? (
        sent.length === 0 ? (
          <EmptyState
            title="Nenhum envio"
            hint="Quando marcar enviado na caixinha, o item aparece aqui. Use “Voltar pra loja” para desfazer."
          />
        ) : (
          <>
            <p className="mb-3 text-sm text-zinc-600">
              Para desfazer um envio marcado por engano, use{" "}
              <strong>Voltar pra loja (desfazer envio)</strong> — o item volta
              pra caixinha sem cancelar.
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Produto</th>
                    <th>Qtds</th>
                    <th>Valor</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {sent.map((item) =>
                    renderItemRow(item, {
                      showStore: true,
                      showSent: true,
                      showDelivered: true,
                      actions: "sent",
                    }),
                  )}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : null}

      {tab === "entregues" ? (
        delivered.length === 0 ? (
          <EmptyState title="Nada entregue ainda" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Qtds</th>
                  <th>Valor</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {delivered.map((item) =>
                  renderItemRow(item, {
                    showDelivered: true,
                    actions: "none",
                  }),
                )}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === "cancelados" ? (
        cancelled.length === 0 ? (
          <EmptyState title="Nenhum cancelamento" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Qtds</th>
                  <th>Valor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {cancelled.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="font-medium">{item.title}</div>
                      <Badge tone="bad">{GARAGE_STATUS_LABEL.cancelled}</Badge>
                      <p className="mt-1 text-xs text-red-700">
                        {item.cancel_reason} · {fmtDate(item.cancelled_at)} ·{" "}
                        {formatStaffName(item.cancelled_by_profile)}
                      </p>
                    </td>
                    <td className="font-mono">{item.qty}</td>
                    <td>
                      {item.unit_price != null
                        ? `R$ ${Number(item.unit_price).toFixed(2)}`
                        : "—"}
                    </td>
                    <td>
                      <Badge tone="bad">Estorno / cancelado</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === "notas" ? (
        <div className="space-y-6">
          <form onSubmit={addNote} className="panel space-y-3">
            <h2 className="text-base font-semibold">Nova observação</h2>
            <textarea
              className="field min-h-24"
              required
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Combinado de envio, preferência, pendência…"
            />
            <button type="submit" className="btn-primary">
              Salvar nota (como {meName})
            </button>
          </form>

          <div className="panel space-y-3">
            <h2 className="text-base font-semibold">Foto</h2>
            <input
              className="field"
              placeholder="Legenda (opc.)"
              value={photoCaption}
              onChange={(e) => setPhotoCaption(e.target.value)}
            />
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadPhoto(f);
              }}
            />
          </div>

          {notes.length === 0 && photos.length === 0 ? (
            <EmptyState title="Sem notas/fotos ainda" />
          ) : (
            <>
              {photos.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {photos.map((p) => (
                    <figure key={p.id} className="panel p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.public_url}
                        alt={p.caption || "Foto do cliente"}
                        className="h-40 w-full rounded object-cover"
                      />
                      <figcaption className="mt-2 text-xs text-zinc-600">
                        {p.caption || "Sem legenda"} · {fmtDate(p.created_at)} ·{" "}
                        {formatStaffName(p.created_by_profile)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
              <ul className="space-y-2">
                {notes.map((n) => (
                  <li key={n.id} className="panel text-sm">
                    <p className="whitespace-pre-wrap text-zinc-800">{n.body}</p>
                    <p className="mt-2 text-xs text-zinc-500">
                      {fmtDate(n.created_at)} ·{" "}
                      {formatStaffName(n.created_by_profile)}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {tab === "auditoria" ? (
        audit.length === 0 ? (
          <EmptyState
            title="Sem registros ainda"
            hint="Envios, estornos, desfazer envio e cancelamentos ficam aqui com quem fez e quando."
          />
        ) : (
          <div className="panel">
            <h2 className="mb-3 text-base font-semibold">Log de auditoria</h2>
            <p className="mb-3 text-sm text-zinc-600">
              Ações delicadas (envio, desfazer envio, entrega, cancelamento, etc.)
              com usuário e data.
            </p>
            <ul className="max-h-[min(70vh,36rem)] space-y-2 overflow-y-auto">
              {audit.map((e) => (
                <li
                  key={e.id}
                  className="rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{e.action}</Badge>
                    <span className="font-medium text-zinc-800">
                      {formatStaffName(e.created_by_profile, "Staff")}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {fmtDate(e.created_at)}
                    </span>
                  </div>
                  <p className="mt-1 text-zinc-700">{e.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
    </div>
  );
}
