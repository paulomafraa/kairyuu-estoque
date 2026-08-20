"use client";

import Link from "next/link";
import { FormEvent, Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EventResumoPanel } from "@/components/EventResumoPanel";
import { createClient } from "@/lib/supabase/client";
import { EVENT_STATUS_LABEL, cardLabel } from "@/lib/labels";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import { logStaffAction } from "@/lib/audit";
import {
  parseResultadoFile,
  paymentUrgency,
  filterLinesForKind,
  isShelvedSaleLine,
  isEncInterestOption,
  parseMoneyFromOption,
  classifyStoredLeilaoLine,
  type ParsedSaleLine,
} from "@/lib/leilao-resultado";
import {
  buildBillingMessage,
  greetingName,
} from "@/lib/cobranca-msg";
import {
  parseEncomendaTemplateCsv,
  type EncomendaCostRow,
} from "@/lib/encomenda-template";
import { buildEventResumo } from "@/lib/evento-resumo";
import {
  buildResultadoCsv,
  downloadTextFile,
} from "@/lib/resultado-export";
import type {
  Card,
  Customer,
  Event,
  EventAllocation,
  EventProductCost,
  EventProductStock,
  EventSaleLine,
  Profile,
} from "@/lib/types";

type Participant = {
  key: string;
  customer_id: string | null;
  name: string;
  phone: string;
  lines: EventSaleLine[];
  unpaid: number;
  urgency: "ok" | "warn" | "overdue" | "none";
};

/** Nome de cadastro que ainda é só o telefone (import bruto). */
function looksLikePhoneName(name: string): boolean {
  const digits = normalizePhoneDigits(name);
  return digits.length >= 10 && digits === name.replace(/\D/g, "");
}

function displayCustomerName(
  cust: Customer | undefined | null,
  snapshot: string,
  phone: string,
): string {
  if (cust?.name && !looksLikePhoneName(cust.name)) return cust.name;
  if (snapshot && !looksLikePhoneName(snapshot)) return snapshot;
  return cust?.name || snapshot || phone || "Sem cliente";
}

function labelWithPhone(name: string, phone: string): string {
  const p = (phone || "").trim();
  if (!p) return name;
  if (name === p || looksLikePhoneName(name)) return p;
  return `${name} (${p})`;
}

function lineUnitPrice(line: EventSaleLine): number | null {
  if (line.unit_price != null && Number.isFinite(Number(line.unit_price))) {
    return Number(line.unit_price);
  }
  return (
    parseMoneyFromOption(line.product_title) ??
    parseMoneyFromOption(line.valor_ou_opcao)
  );
}

export default function EventoDetailPage() {
  const params = useParams<{ id: string }>();
  const eventId = params.id;
  const supabase = useMemo(() => createClient(), []);

  const [event, setEvent] = useState<(Event & { profiles?: Profile | null }) | null>(null);
  const [lines, setLines] = useState<EventSaleLine[]>([]);
  const [productStock, setProductStock] = useState<EventProductStock[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [allocations, setAllocations] = useState<EventAllocation[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState("Staff");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showBox, setShowBox] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [includeReview, setIncludeReview] = useState(true);
  const [includeNoVotes, setIncludeNoVotes] = useState(true);
  const [importPreview, setImportPreview] = useState<{
    certain: ParsedSaleLine[];
    review: ParsedSaleLine[];
    noVotes: ParsedSaleLine[];
    sheetUsed: string;
    skippedByKind: number;
  } | null>(null);

  const [paymentDue, setPaymentDue] = useState("");
  const [eventNameEdit, setEventNameEdit] = useState("");
  const [editingEventName, setEditingEventName] = useState(false);
  const [allocCardId, setAllocCardId] = useState("");
  const [allocQty, setAllocQty] = useState(1);

  const [manualTitle, setManualTitle] = useState("");
  const [manualCustomerId, setManualCustomerId] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualValor, setManualValor] = useState("");
  const [manualQty, setManualQty] = useState(1);

  const [selectedParticipant, setSelectedParticipant] = useState<string | null>(null);
  const [selectedLineIds, setSelectedLineIds] = useState<Record<string, boolean>>({});
  const [showShelved, setShowShelved] = useState(false);
  const [showShelvedEvent, setShowShelvedEvent] = useState(false);
  const [openProductTitles, setOpenProductTitles] = useState<Record<string, boolean>>({});

  /** Revisão ❓: atribuir dono sem mexer em itens já pagos/organizados. */
  const [reviewLineId, setReviewLineId] = useState<string | null>(null);
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewScope, setReviewScope] = useState<"event" | "all">("event");
  const [reviewKeep, setReviewKeep] = useState(true);
  const [stickyCustomerId, setStickyCustomerId] = useState<string | null>(null);
  const [newReviewName, setNewReviewName] = useState("");
  const [newReviewPhone, setNewReviewPhone] = useState("");
  const [showNewReview, setShowNewReview] = useState(false);

  const [certainSearch, setCertainSearch] = useState("");
  const [reviewCardSearch, setReviewCardSearch] = useState("");
  const [noVotesSearch, setNoVotesSearch] = useState("");
  const [participantSearch, setParticipantSearch] = useState("");

  /** Trocar dono em carta já com dono certo (motivo obrigatório). */
  const [reassignLineId, setReassignLineId] = useState<string | null>(null);
  const [reassignReason, setReassignReason] = useState("");
  const [reassignSearch, setReassignSearch] = useState("");
  const [reassignScope, setReassignScope] = useState<"event" | "all">("event");
  const [showReassignNew, setShowReassignNew] = useState(false);
  const [reassignNewName, setReassignNewName] = useState("");
  const [reassignNewPhone, setReassignNewPhone] = useState("");

  const [productCosts, setProductCosts] = useState<EventProductCost[]>([]);
  const [controlReason, setControlReason] = useState("");
  const [orphanLineId, setOrphanLineId] = useState<string | null>(null);
  const [orphanSearch, setOrphanSearch] = useState("");
  const [detachLineId, setDetachLineId] = useState<string | null>(null);
  const [detachReason, setDetachReason] = useState("");
  const [extraTitle, setExtraTitle] = useState("");
  const [extraCustomerId, setExtraCustomerId] = useState("");
  const [extraPrice, setExtraPrice] = useState("");
  const [extraQty, setExtraQty] = useState(1);
  const [extraReason, setExtraReason] = useState("");
  const [reviewReason, setReviewReason] = useState("");

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

    const [ev, ln, cu, al, cd, ps, costs] = await Promise.all([
      supabase
        .from("events")
        .select("*, profiles!owner_id(id, name, role, created_at)")
        .eq("id", eventId)
        .single(),
      supabase
        .from("event_sale_lines")
        .select("*, customers(id, name, phone)")
        .eq("event_id", eventId)
        .order("created_at"),
      supabase.from("customers").select("*").order("name"),
      supabase
        .from("event_allocations")
        .select("*, cards(*)")
        .eq("event_id", eventId),
      supabase.from("cards").select("*").gt("qty_in_stock", 0).order("name"),
      supabase
        .from("event_product_stock")
        .select("*")
        .eq("event_id", eventId),
      supabase
        .from("event_product_costs")
        .select("*")
        .eq("event_id", eventId)
        .order("product_title"),
    ]);

    if (ev.error) setError(ev.error.message);
    else {
      setEvent(ev.data as typeof event);
      setPaymentDue((ev.data as Event).payment_due_at || "");
      setEventNameEdit((ev.data as Event).name || "");
      setShowBox(Boolean((ev.data as Event).use_stock_box));
    }

    if (ln.error) setError(ln.error.message);
    else setLines((ln.data as EventSaleLine[]) || []);

    if (ps.error && !String(ps.error.message || "").includes("does not exist")) {
      setError(ps.error.message);
    } else {
      setProductStock((ps.data as EventProductStock[]) || []);
    }

    setCustomers((cu.data as Customer[]) || []);
    if (!al.error) setAllocations((al.data as EventAllocation[]) || []);
    setCards((cd.data as Card[]) || []);
    if (costs.error) {
      if (!String(costs.error.message || "").includes("does not exist")) {
        // migration ainda não rodada — ignora
      }
      setProductCosts([]);
    } else {
      setProductCosts((costs.data as EventProductCost[]) || []);
    }
  }, [supabase, eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const phoneToCustomer = useMemo(() => {
    const map = new Map<string, Customer>();
    for (const c of customers) {
      const d = c.phone_digits || normalizePhoneDigits(c.phone);
      if (d) map.set(d, c);
    }
    return map;
  }, [customers]);

  const participants = useMemo(() => {
    const byKey = new Map<string, Participant>();
    const kind = event?.kind;
    for (const line of lines) {
      if (line.cancelled) continue;
      // Leilão: revisão/sem votos ficam só no painel Controle (não poluem participantes)
      if (kind === "leilao") {
        const bucket = classifyStoredLeilaoLine(line);
        if (bucket === "review" || bucket === "no_votes") continue;
      }
      const phone = line.phone_digits || "";
      const key = line.customer_id || phone || line.id;
      const cust = line.customer_id
        ? customers.find((c) => c.id === line.customer_id)
        : phoneToCustomer.get(phone);
      const name = displayCustomerName(cust, line.customer_name_snapshot, phone);
      let p = byKey.get(key);
      if (!p) {
        p = {
          key,
          customer_id: cust?.id || line.customer_id,
          name,
          phone: cust?.phone || phone,
          lines: [],
          unpaid: 0,
          urgency: "none",
        };
        byKey.set(key, p);
      }
      p.lines.push(line);
      if (!isShelvedSaleLine(line, kind) && !line.paid) p.unpaid += 1;
    }

    const due = event?.payment_due_at;
    const list = [...byKey.values()]
      .map((p) => {
        const active = p.lines.filter((l) => !isShelvedSaleLine(l, kind));
        const anyUnpaid = active.some((l) => !l.paid && !l.cancelled);
        return {
          ...p,
          urgency: anyUnpaid
            ? paymentUrgency(false, false, due)
            : ("ok" as const),
        };
      })
      .filter((p) => p.lines.some((l) => !isShelvedSaleLine(l, kind)));
    list.sort((a, b) => {
      const rank = { overdue: 0, warn: 1, none: 2, ok: 3 };
      return rank[a.urgency] - rank[b.urgency] || a.name.localeCompare(b.name, "pt-BR");
    });
    return list;
  }, [lines, customers, phoneToCustomer, event?.payment_due_at, event?.kind]);

  const shelvedOnlyParticipants = useMemo(() => {
    const kind = event?.kind;
    const activeKeys = new Set(participants.map((p) => p.key));
    const byKey = new Map<string, Participant>();
    for (const line of lines) {
      if (line.cancelled || !isShelvedSaleLine(line, kind)) continue;
      const phone = line.phone_digits || "";
      const key = line.customer_id || phone || line.id;
      if (activeKeys.has(key)) continue;
      const cust = line.customer_id
        ? customers.find((c) => c.id === line.customer_id)
        : phoneToCustomer.get(phone);
      const name = displayCustomerName(cust, line.customer_name_snapshot, phone);
      let p = byKey.get(key);
      if (!p) {
        p = {
          key,
          customer_id: cust?.id || line.customer_id,
          name,
          phone: cust?.phone || phone,
          lines: [],
          unpaid: 0,
          urgency: "ok",
        };
        byKey.set(key, p);
      }
      p.lines.push(line);
    }
    return [...byKey.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR"),
    );
  }, [lines, customers, phoneToCustomer, participants, event?.kind]);

  const activeParticipant =
    participants.find((p) => p.key === selectedParticipant) ||
    shelvedOnlyParticipants.find((p) => p.key === selectedParticipant);

  const activeMainLines = useMemo(
    () =>
      (activeParticipant?.lines || []).filter(
        (l) => !l.cancelled && !isShelvedSaleLine(l, event?.kind),
      ),
    [activeParticipant, event?.kind],
  );

  const activeShelvedLines = useMemo(
    () =>
      (activeParticipant?.lines || []).filter(
        (l) => !l.cancelled && isShelvedSaleLine(l, event?.kind),
      ),
    [activeParticipant, event?.kind],
  );

  const eventShelvedLines = useMemo(
    () =>
      lines.filter((l) => !l.cancelled && isShelvedSaleLine(l, event?.kind)),
    [lines, event?.kind],
  );

  const selectedCount = useMemo(
    () => activeMainLines.filter((l) => selectedLineIds[l.id]).length,
    [activeMainLines, selectedLineIds],
  );

  const allActiveSelected =
    activeMainLines.length > 0 && selectedCount === activeMainLines.length;

  const productSummary = useMemo(() => {
    const arrivedMap = new Map(
      productStock.map((s) => [s.product_title, s.qty_arrived] as const),
    );
    const map = new Map<
      string,
      {
        title: string;
        ordered: number;
        arrived: number;
        people: number;
        lines: EventSaleLine[];
      }
    >();
    const kind = event?.kind;
    for (const line of lines) {
      if (line.cancelled || isShelvedSaleLine(line, kind)) continue;
      const title = line.product_title;
      let row = map.get(title);
      if (!row) {
        row = {
          title,
          ordered: 0,
          arrived: arrivedMap.get(title) ?? 0,
          people: 0,
          lines: [],
        };
        map.set(title, row);
      }
      row.ordered += Number(line.qty) > 0 ? Number(line.qty) : 1;
      row.people += 1;
      row.lines.push(line);
    }
    for (const row of map.values()) {
      row.lines.sort((a, b) => {
        const na =
          a.customers?.name || a.customer_name_snapshot || a.phone_digits || "";
        const nb =
          b.customers?.name || b.customer_name_snapshot || b.phone_digits || "";
        return na.localeCompare(nb, "pt-BR");
      });
    }
    return [...map.values()].sort((a, b) =>
      a.title.localeCompare(b.title, "pt-BR"),
    );
  }, [lines, productStock, event?.kind]);

  const leilaoBuckets = useMemo(() => {
    if (event?.kind !== "leilao") {
      return { certain: [] as EventSaleLine[], review: [] as EventSaleLine[], noVotes: [] as EventSaleLine[] };
    }
    const certain: EventSaleLine[] = [];
    const review: EventSaleLine[] = [];
    const noVotes: EventSaleLine[] = [];
    for (const line of lines) {
      if (line.cancelled || isShelvedSaleLine(line, "leilao")) continue;
      const bucket = classifyStoredLeilaoLine(line);
      if (bucket === "no_votes") noVotes.push(line);
      else if (bucket === "review") review.push(line);
      else certain.push(line);
    }
    const byTitle = (a: EventSaleLine, b: EventSaleLine) =>
      a.product_title.localeCompare(b.product_title, "pt-BR");
    certain.sort(byTitle);
    review.sort(byTitle);
    noVotes.sort(byTitle);
    return { certain, review, noVotes };
  }, [lines, event?.kind]);

  const eventResumo = useMemo(() => {
    const costRows: EncomendaCostRow[] = productCosts.map((c) => ({
      product_title: c.product_title,
      cost_jp: c.cost_jp != null ? Number(c.cost_jp) : null,
      price_sale: c.price_sale != null ? Number(c.price_sale) : null,
      price_liga: c.price_liga != null ? Number(c.price_liga) : null,
      link: c.link || "",
    }));
    return buildEventResumo(
      lines.map((l) => ({
        product_title: l.product_title,
        unit_price: lineUnitPrice(l),
        qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
        customer_id: l.customer_id,
        customer_name:
          l.customers?.name ||
          l.customer_name_snapshot ||
          l.phone_digits ||
          "",
        phone: l.customers?.phone || l.phone_digits || "",
        cancelled: l.cancelled,
        paid: l.paid,
        import_status: l.import_status,
        valor_ou_opcao: l.valor_ou_opcao,
        archived: l.archived,
      })),
      event?.kind,
      event?.kind === "encomenda" ? costRows : undefined,
    );
  }, [lines, productCosts, event?.kind]);

  const filteredCertain = useMemo(() => {
    const q = certainSearch.trim().toLowerCase();
    if (!q) return leilaoBuckets.certain;
    return leilaoBuckets.certain.filter((l) => {
      const who = `${l.customers?.name || ""} ${l.customer_name_snapshot || ""} ${l.phone_digits || ""}`;
      return (
        l.product_title.toLowerCase().includes(q) ||
        who.toLowerCase().includes(q)
      );
    });
  }, [leilaoBuckets.certain, certainSearch]);

  const filteredReview = useMemo(() => {
    const q = reviewCardSearch.trim().toLowerCase();
    if (!q) return leilaoBuckets.review;
    return leilaoBuckets.review.filter((l) =>
      l.product_title.toLowerCase().includes(q),
    );
  }, [leilaoBuckets.review, reviewCardSearch]);

  const filteredNoVotes = useMemo(() => {
    const q = noVotesSearch.trim().toLowerCase();
    if (!q) return leilaoBuckets.noVotes;
    return leilaoBuckets.noVotes.filter((l) =>
      l.product_title.toLowerCase().includes(q),
    );
  }, [leilaoBuckets.noVotes, noVotesSearch]);

  const filteredParticipants = useMemo(() => {
    const q = participantSearch.trim().toLowerCase();
    if (!q) return participants;
    return participants.filter((p) =>
      `${p.name} ${p.phone}`.toLowerCase().includes(q),
    );
  }, [participants, participantSearch]);

  async function saveEventName() {
    const name = eventNameEdit.trim();
    if (!name) {
      setError("Nome do evento não pode ficar vazio.");
      return;
    }
    const { error: err } = await supabase
      .from("events")
      .update({ name })
      .eq("id", eventId);
    if (err) setError(err.message);
    else {
      setEditingEventName(false);
      setInfo("Nome do evento atualizado.");
      await load();
    }
  }

  async function healLeilaoStatuses() {
    const toFix = lines.filter(
      (l) =>
        !l.cancelled &&
        classifyStoredLeilaoLine(l) === "no_votes" &&
        l.import_status !== "sem_voto",
    );
    if (!toFix.length) {
      setInfo("Nada para corrigir — classificação já está ok.");
      return;
    }
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({ import_status: "sem_voto", certainty: "manual_review" })
      .in(
        "id",
        toFix.map((l) => l.id),
      );
    if (err) {
      setError(
        err.message.includes("sem_voto")
          ? `${err.message} — rode migration_sem_voto.sql no Supabase.`
          : err.message,
      );
      return;
    }
    setInfo(`Corrigido: ${toFix.length} carta(s) → sem votos.`);
    await load();
  }

  async function saveDue() {
    const { error: err } = await supabase
      .from("events")
      .update({ payment_due_at: paymentDue || null })
      .eq("id", eventId);
    if (err) setError(err.message);
    else {
      setInfo("Prazo de pagamento atualizado.");
      await load();
    }
  }

  async function onPickFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const parsed = await parseResultadoFile(file);
      const kind = event?.kind;
      const { keep: certain, skipped: s1 } = filterLinesForKind(
        parsed.certain,
        kind,
      );
      const { keep: review, skipped: s2 } = filterLinesForKind(
        parsed.review,
        kind,
      );
      const { keep: noVotes, skipped: s3 } = filterLinesForKind(
        parsed.noVotes,
        kind,
      );
      // Leilão: revisão e sem votos vêm por padrão
      if (kind === "leilao") {
        setIncludeReview(true);
        setIncludeNoVotes(true);
      } else {
        setIncludeReview(false);
        setIncludeNoVotes(false);
      }
      setImportPreview({
        certain,
        review,
        noVotes,
        sheetUsed: parsed.sheetUsed,
        skippedByKind: s1 + s2 + s3,
      });
      setShowImport(true);
      setInfo(
        kind === "leilao"
          ? `Lido (${parsed.sheetUsed}): ${certain.length} dono certo · ${review.length} revisão ❓ · ${noVotes.length} sem votos.`
          : `Lido (${parsed.sheetUsed}): ${certain.length} para importar · ${review.length} revisão.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao ler planilha");
    } finally {
      setBusy(false);
    }
  }

  async function ensureCustomer(line: ParsedSaleLine): Promise<string | null> {
    if (!line.phone_digits) return null;
    const existing = phoneToCustomer.get(line.phone_digits);
    if (existing) {
      // Só preenche nome no cadastro se ainda estiver como telefone.
      // Nunca mexe em cartas, linhas já atribuídas, garagem ou pagamentos.
      const snap = (line.customer_name_snapshot || "").trim();
      if (
        snap &&
        !looksLikePhoneName(snap) &&
        looksLikePhoneName(existing.name)
      ) {
        await supabase
          .from("customers")
          .update({ name: snap })
          .eq("id", existing.id);
      }
      return existing.id;
    }
    const { data, error: err } = await supabase
      .from("customers")
      .insert({
        name: line.customer_name_snapshot || line.phone_digits,
        phone: line.phone_digits,
        phone_digits: line.phone_digits,
        source: "whatsapp_group",
        notes: "",
      })
      .select("id")
      .single();
    if (err) {
      // race / unique
      const { data: again } = await supabase
        .from("customers")
        .select("id")
        .eq("phone_digits", line.phone_digits)
        .maybeSingle();
      return again?.id ?? null;
    }
    return data.id;
  }

  async function confirmImport() {
    if (!importPreview) return;
    setBusy(true);
    setError(null);
    try {
      // Leilão: sempre traz os 3 blocos (dono certo / revisão ❓ / sem votos)
      const wantReview =
        event?.kind === "leilao" ? true : includeReview;
      const wantNoVotes =
        event?.kind === "leilao" ? true : includeNoVotes;
      const toImport = [
        ...importPreview.certain,
        ...(wantReview ? importPreview.review : []),
        ...(wantNoVotes ? importPreview.noVotes : []),
      ];
      if (!toImport.length) {
        setError("Nenhuma linha para importar.");
        return;
      }

      // Uma enquete = uma carta: não duplicar pelo poll_id + título
      const existingPollProducts = new Set(
        lines.map((l) =>
          `${l.poll_id}|${l.product_title}`.toLowerCase().trim(),
        ),
      );
      // Fallback sem poll_id: título + status
      const existingTitleStatus = new Set(
        lines.map((l) =>
          `${l.product_title}|${l.import_status}`.toLowerCase().trim(),
        ),
      );

      let inserted = 0;
      let skipped = 0;
      let insertedReview = 0;
      let insertedNoVotes = 0;
      const chunk: Record<string, unknown>[] = [];

      for (const row of toImport) {
        const pollKey = `${row.poll_id}|${row.product_title}`
          .toLowerCase()
          .trim();
        const titleKey = `${row.product_title}|${row.import_status}`
          .toLowerCase()
          .trim();
        if (
          (row.poll_id && existingPollProducts.has(pollKey)) ||
          (!row.poll_id && existingTitleStatus.has(titleKey))
        ) {
          skipped += 1;
          continue;
        }
        const customerId = row.phone_digits
          ? await ensureCustomer(row)
          : null;
        chunk.push({
          event_id: eventId,
          customer_id: customerId,
          phone_digits: row.phone_digits || "",
          customer_name_snapshot: row.customer_name_snapshot || "",
          product_title: row.product_title,
          valor_ou_opcao:
            row.valor_ou_opcao ||
            (row.import_status === "verificar_manual"
              ? "verificar_manual"
              : row.import_status === "sem_voto"
                ? "sem_voto"
                : ""),
          unit_price: row.unit_price,
          qty: row.qty || 1,
          import_status: row.import_status,
          certainty: row.certainty,
          arremate: row.arremate,
          poll_id: row.poll_id || "",
          notes:
            row.import_status === "verificar_manual"
              ? "Revisão manual (❓) — bot não definiu ganhador"
              : row.import_status === "sem_voto"
                ? "Sem votos na enquete"
                : "",
          created_by: meId,
        });
        if (row.poll_id) existingPollProducts.add(pollKey);
        existingTitleStatus.add(titleKey);
        if (row.import_status === "verificar_manual") insertedReview += 1;
        if (row.import_status === "sem_voto") insertedNoVotes += 1;
        if (chunk.length >= 80) {
          const { error: err } = await supabase.from("event_sale_lines").insert(chunk);
          if (err) throw err;
          inserted += chunk.length;
          chunk.length = 0;
        }
      }
      if (chunk.length) {
        const { error: err } = await supabase.from("event_sale_lines").insert(chunk);
        if (err) throw err;
        inserted += chunk.length;
      }

      setInfo(
        `Importação: ${inserted} novas · ${skipped} já existiam` +
          (insertedReview ? ` · +${insertedReview} revisão ❓` : "") +
          (insertedNoVotes ? ` · +${insertedNoVotes} sem votos` : "") +
          (wantReview && importPreview.review.length && !insertedReview && skipped
            ? ` · revisão já estava (ou faltou no arquivo)`
            : "") +
          ".",
      );
      setImportPreview(null);
      setShowImport(false);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Falha na importação";
      setError(
        msg.includes("import_status") || msg.includes("sem_voto")
          ? `${msg} — rode supabase/migration_sem_voto.sql no Supabase.`
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  async function addManual(e: FormEvent) {
    e.preventDefault();
    if (!manualTitle.trim() || !manualCustomerId) return;
    const priceNum = Number(manualPrice);
    if (!manualPrice.trim() || !Number.isFinite(priceNum) || priceNum < 0) {
      setError("Informe o valor (R$) do item — é obrigatório.");
      return;
    }
    const cust = customers.find((c) => c.id === manualCustomerId);
    const { error: err } = await supabase.from("event_sale_lines").insert({
      event_id: eventId,
      customer_id: manualCustomerId,
      phone_digits: cust?.phone_digits || normalizePhoneDigits(cust?.phone || ""),
      customer_name_snapshot: cust?.name || "",
      product_title: manualTitle.trim(),
      valor_ou_opcao: manualValor.trim(),
      unit_price: priceNum,
      qty: Math.max(1, Number(manualQty) || 1),
      import_status: "manual",
      certainty: "certain",
      arremate: false,
      created_by: meId,
    });
    if (err) setError(err.message);
    else {
      setManualTitle("");
      setManualValor("");
      setManualPrice("");
      setManualQty(1);
      setInfo("Item manual adicionado.");
      await load();
    }
  }

  async function patchLines(
    ids: string[],
    patch: Record<string, unknown>,
    label: string,
  ) {
    if (!ids.length) return;
    setError(null);
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update(patch)
      .in("id", ids);
    if (err) {
      setError(err.message);
      return;
    }
    setInfo(`${label} · ${ids.length} item(ns) · ${meName}`);
    setSelectedLineIds({});
    await logStaffAction(supabase, {
      action: label,
      detail: `${label} · ${ids.length} item(ns) no evento ${event?.name || eventId}`,
      created_by: meId,
      entity_type: "event_sale_lines",
      entity_id: ids.join(","),
      event_id: eventId,
    });
    await load();
  }

  async function markSeparated(ids: string[], value: boolean) {
    await patchLines(
      ids,
      {
        separated: value,
        separated_at: value ? new Date().toISOString() : null,
        separated_by: value ? meId : null,
      },
      value ? "Separado" : "Separação desfeita",
    );
  }

  async function markCharged(ids: string[], value: boolean) {
    await patchLines(
      ids,
      {
        charged: value,
        charged_at: value ? new Date().toISOString() : null,
        charged_by: value ? meId : null,
      },
      value ? "Cobrança marcada" : "Cobrança desfeita",
    );
  }

  async function markPaid(ids: string[], value: boolean) {
    // ao pagar, cria item na garagem se ainda não tiver
    if (value) {
      for (const id of ids) {
        const line = lines.find((l) => l.id === id);
        if (!line || line.cancelled || line.garage_item_id || !line.customer_id) continue;
        const { data: gi, error: gErr } = await supabase
          .from("customer_garage_items")
          .insert({
            customer_id: line.customer_id,
            title: line.product_title,
            category: "carta",
            qty: Number(line.qty) > 0 ? Number(line.qty) : 1,
            qty_with_store: Number(line.qty) > 0 ? Number(line.qty) : 1,
            qty_sent: 0,
            qty_delivered: 0,
            status: "in_garage",
            origin:
              event?.kind === "encomenda"
                ? "encomenda"
                : event?.kind === "leilao" ||
                    line.import_status === "arrematado" ||
                    line.arremate
                  ? "leilao"
                  : "evento",
            event_name: event?.name || "",
            event_date: event?.opened_at?.slice(0, 10) || null,
            event_id: eventId,
            unit_price: lineUnitPrice(line),
            notes: line.valor_ou_opcao || "",
            created_by: meId,
          })
          .select("id")
          .single();
        if (!gErr && gi) {
          await supabase
            .from("event_sale_lines")
            .update({ garage_item_id: gi.id })
            .eq("id", id);
        }
      }
    }
    await patchLines(
      ids,
      value
        ? {
            paid: true,
            paid_at: new Date().toISOString(),
            paid_by: meId,
            charged: true,
            charged_at: new Date().toISOString(),
            charged_by: meId,
          }
        : {
            paid: false,
            paid_at: null,
            paid_by: null,
          },
      value ? "Pago (foi pra caixinha)" : "Pagamento desfeito",
    );
  }

  async function cancelLines(ids: string[]) {
    const reason = window.prompt(
      "Motivo do cancelamento (obrigatório): cliente não pagou, desistiu, etc.",
    );
    if (reason == null) return;
    if (!reason.trim()) {
      setError("Informe o motivo do cancelamento.");
      return;
    }
    for (const id of ids) {
      const line = lines.find((l) => l.id === id);
      if (line?.garage_item_id) {
        await supabase
          .from("customer_garage_items")
          .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
            cancelled_by: meId,
            cancel_reason: reason.trim(),
          })
          .eq("id", line.garage_item_id);
      }
    }
    await patchLines(
      ids,
      {
        cancelled: true,
        cancel_reason: reason.trim(),
        cancelled_at: new Date().toISOString(),
        cancelled_by: meId,
      },
      "Cancelado",
    );
  }

  function selectedIdsFromParticipant(): string[] {
    if (!activeParticipant) return [];
    return activeMainLines.filter((l) => selectedLineIds[l.id]).map((l) => l.id);
  }

  function toggleSelectAll(checked: boolean) {
    if (!activeParticipant) return;
    const next: Record<string, boolean> = {};
    if (checked) {
      for (const l of activeMainLines) next[l.id] = true;
    }
    setSelectedLineIds(next);
  }

  async function setArchived(ids: string[], archived: boolean) {
    if (!ids.length) return;
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({ archived })
      .in("id", ids);
    if (err) {
      setError(
        err.message.includes("archived")
          ? "Rode a migration migration_archive_lines.sql no Supabase (coluna archived)."
          : err.message,
      );
      return;
    }
    setInfo(
      archived
        ? `Arquivado · ${ids.length} item(ns) (ficam na aba retrátil)`
        : `Restaurado · ${ids.length} item(ns)`,
    );
    setSelectedLineIds({});
    await load();
  }

  async function archiveAllHeartsInEvent() {
    const ids = lines
      .filter(
        (l) =>
          !l.cancelled &&
          !l.archived &&
          isEncInterestOption(l.valor_ou_opcao || ""),
      )
      .map((l) => l.id);
    if (!ids.length) {
      setInfo("Nenhum 💙 pendente de arquivar (já estão na aba retrátil).");
      return;
    }
    await setArchived(ids, true);
  }

  async function updateLineQty(lineId: string, qty: number) {
    const n = Math.max(1, Math.floor(qty) || 1);
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({ qty: n })
      .eq("id", lineId);
    if (err) setError(err.message);
    else await load();
  }

  async function updateLinePrice(lineId: string, raw: string) {
    const n = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) {
      setError("Valor inválido.");
      return;
    }
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({ unit_price: n })
      .eq("id", lineId);
    if (err) setError(err.message);
    else {
      setInfo("Valor atualizado.");
      await load();
    }
  }

  async function copyBillingMessage() {
    if (!activeParticipant || !event) return;
    const sourceLines =
      selectedCount > 0
        ? activeMainLines.filter((l) => selectedLineIds[l.id])
        : activeMainLines.filter((l) => !l.paid);
    const linesForMsg = (sourceLines.length ? sourceLines : activeMainLines).map(
      (l) => ({
        product_title: l.product_title,
        unit_price: lineUnitPrice(l),
        qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
      }),
    );
    if (!linesForMsg.length) {
      setError("Nenhum item para montar a cobrança.");
      return;
    }
    const { text, missingPrice } = buildBillingMessage({
      kind: event.kind || "leilao",
      customerName: greetingName(
        activeParticipant.name,
        activeParticipant.phone,
        looksLikePhoneName,
      ),
      eventDate: event.opened_at,
      paymentDue: event.payment_due_at,
      lines: linesForMsg,
    });
    try {
      await navigator.clipboard.writeText(text);
      setInfo(
        missingPrice > 0
          ? `Mensagem copiada · ${missingPrice} item(ns) sem valor (revise o R$ ?).`
          : "Mensagem de cobrança copiada.",
      );
    } catch {
      setError("Não foi possível copiar. Permita acesso à área de transferência.");
    }
  }

  /**
   * Atribui dono a uma linha ❓ ou sem votos.
   * Exige motivo (auditoria). Não toca pago/caixinha.
   */
  async function assignOwnerControlled(
    lineId: string,
    customer: Pick<Customer, "id" | "name" | "phone" | "phone_digits">,
    reason: string,
    allowed: Array<"review" | "no_votes">,
  ) {
    const motivo = reason.trim();
    if (motivo.length < 3) {
      setError("Informe o motivo da associação (obrigatório).");
      return;
    }
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    const bucket = classifyStoredLeilaoLine(line);
    if (!allowed.includes(bucket as "review" | "no_votes")) {
      setError("Esta carta não está na lista permitida para essa ação.");
      return;
    }
    if (line.paid || line.garage_item_id) {
      setError(
        "Esse item já está pago ou na Caixinha/garagem — não reatribua por aqui.",
      );
      return;
    }

    const phone =
      customer.phone_digits || normalizePhoneDigits(customer.phone || "");
    const cleanValor = (line.valor_ou_opcao || "")
      .replace(/verificar_manual/gi, "")
      .replace(/sem_voto/gi, "")
      .trim();
    const prevNotes = (line.notes || "")
      .replace(/verificar_manual/gi, "")
      .replace(/sem_voto/gi, "")
      .trim();
    const notes = [prevNotes, `Associação: ${motivo}`].filter(Boolean).join(" · ");
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({
        customer_id: customer.id,
        phone_digits: phone,
        customer_name_snapshot: customer.name || phone,
        import_status:
          event?.kind === "encomenda" ? "voto" : "arrematado",
        certainty: "certain",
        valor_ou_opcao:
          event?.kind === "encomenda" && !cleanValor
            ? "Eu quero"
            : cleanValor,
        notes,
      })
      .eq("id", lineId)
      .eq("event_id", eventId);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }

    await logStaffAction(supabase, {
      action: "owner_assign",
      detail: `Associar dono · ${line.product_title} → ${customer.name || phone} · motivo: ${motivo} · ${meName}`,
      created_by: meId,
      entity_type: "event_sale_line",
      entity_id: lineId,
      customer_id: customer.id,
      event_id: eventId,
    });

    if (reviewKeep) setStickyCustomerId(customer.id);
    setInfo(`Associado: ${line.product_title} → ${customer.name || phone}`);
    if (customer.id) setSelectedParticipant(customer.id);
    setReviewReason("");
    setControlReason("");
    setOrphanLineId(null);

    if (bucket === "review") {
      const remaining = leilaoBuckets.review.filter((l) => l.id !== lineId);
      setReviewLineId(remaining[0]?.id || null);
    }
    await load();
  }

  async function assignReviewToCustomer(
    lineId: string,
    customer: Pick<Customer, "id" | "name" | "phone" | "phone_digits">,
  ) {
    await assignOwnerControlled(lineId, customer, reviewReason, ["review"]);
  }

  async function detachOwner(lineId: string, reason: string) {
    const motivo = reason.trim();
    if (motivo.length < 3) {
      setError("Informe o motivo da desassociação (obrigatório).");
      return;
    }
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    if (classifyStoredLeilaoLine(line) !== "certain") {
      setError("Só dá para desassociar cartas com dono certo.");
      return;
    }
    if (line.paid || line.garage_item_id) {
      setError(
        "Item já pago ou na Caixinha/garagem — não desassocie por aqui.",
      );
      return;
    }
    const prevWho =
      line.customers?.name ||
      line.customer_name_snapshot ||
      line.phone_digits ||
      "—";
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({
        customer_id: null,
        phone_digits: "",
        customer_name_snapshot: "",
        import_status: "verificar_manual",
        certainty: "manual_review",
        valor_ou_opcao: "verificar_manual",
        notes: [line.notes, `Desassociado de ${prevWho}: ${motivo}`]
          .filter(Boolean)
          .join(" · "),
      })
      .eq("id", lineId)
      .eq("event_id", eventId);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    await logStaffAction(supabase, {
      action: "owner_detach",
      detail: `Desassociar · ${line.product_title} · de ${prevWho} · motivo: ${motivo} · ${meName}`,
      created_by: meId,
      entity_type: "event_sale_line",
      entity_id: lineId,
      event_id: eventId,
    });
    setInfo(`Desassociado: ${line.product_title}`);
    setDetachLineId(null);
    setDetachReason("");
    await load();
  }

  function downloadCorrectedCsv() {
    const csv = buildResultadoCsv(
      lines.map((l) => ({
        product_title: l.product_title,
        customer_name_snapshot:
          l.customers?.name || l.customer_name_snapshot || "",
        phone_digits: l.phone_digits || "",
        valor_ou_opcao: l.valor_ou_opcao || "",
        unit_price: lineUnitPrice(l),
        qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
        import_status: l.import_status,
        certainty: l.certainty,
        arremate: l.arremate,
        poll_id: l.poll_id || "",
        cancelled: l.cancelled,
        paid: l.paid,
        charged: l.charged,
        separated: l.separated,
        notes: l.notes || "",
      })),
    );
    const safe = (event?.name || "evento")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .slice(0, 60);
    downloadTextFile(`resultado-corrigido-${safe}.csv`, csv);
    setInfo("CSV corrigido baixado (estado atual da interface).");
  }

  async function uploadEncomendaTemplate(file: File) {
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      const rows = parseEncomendaTemplateCsv(text);
      if (!rows.length) {
        setError("Template sem linhas válidas (precisa coluna Carta).");
        return;
      }
      await supabase.from("event_product_costs").delete().eq("event_id", eventId);
      const payload = rows.map((r) => ({
        event_id: eventId,
        product_title: r.product_title,
        cost_jp: r.cost_jp,
        price_sale: r.price_sale,
        price_liga: r.price_liga,
        link: r.link,
      }));
      const { error: err } = await supabase
        .from("event_product_costs")
        .insert(payload);
      if (err) {
        setError(
          err.message.includes("event_product_costs")
            ? `${err.message} — rode supabase/migration_event_product_costs.sql`
            : err.message,
        );
        return;
      }
      await logStaffAction(supabase, {
        action: "upload_cost_template",
        detail: `Template encomenda · ${rows.length} carta(s) · ${meName}`,
        created_by: meId,
        entity_type: "event",
        entity_id: eventId,
        event_id: eventId,
      });
      setInfo(`Template importado: ${rows.length} carta(s).`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function addExceptionalEncomenda(e: FormEvent) {
    e.preventDefault();
    if (event?.kind !== "encomenda") return;
    const motivo = extraReason.trim();
    if (motivo.length < 3) {
      setError("Motivo obrigatório para item extraordinário.");
      return;
    }
    if (!extraTitle.trim() || !extraCustomerId) {
      setError("Informe produto e cliente.");
      return;
    }
    const priceNum = Number(String(extraPrice).replace(",", "."));
    if (!extraPrice.trim() || !Number.isFinite(priceNum) || priceNum < 0) {
      setError("Informe o valor (R$).");
      return;
    }
    const cust = customers.find((c) => c.id === extraCustomerId);
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("event_sale_lines")
      .insert({
        event_id: eventId,
        customer_id: extraCustomerId,
        phone_digits:
          cust?.phone_digits || normalizePhoneDigits(cust?.phone || ""),
        customer_name_snapshot: cust?.name || "",
        product_title: extraTitle.trim(),
        valor_ou_opcao: "Eu quero (pós-rodada)",
        unit_price: priceNum,
        qty: Math.max(1, Number(extraQty) || 1),
        import_status: "manual",
        certainty: "certain",
        arremate: false,
        notes: `Extraordinário: ${motivo}`,
        created_by: meId,
      })
      .select("id")
      .single();
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    await logStaffAction(supabase, {
      action: "exceptional_add",
      detail: `Item extraordinário · ${extraTitle.trim()} → ${cust?.name || extraCustomerId} · motivo: ${motivo} · ${meName}`,
      created_by: meId,
      entity_type: "event_sale_line",
      entity_id: data?.id || "",
      customer_id: extraCustomerId,
      event_id: eventId,
    });
    setExtraTitle("");
    setExtraPrice("");
    setExtraQty(1);
    setExtraReason("");
    setInfo("Item extraordinário adicionado.");
    await load();
  }

  async function createCustomerAndAssignReview(lineId: string) {
    const phone = normalizePhoneDigits(newReviewPhone);
    const name = newReviewName.trim() || phone;
    if (!phone || phone.length < 10) {
      setError("Informe um telefone válido (10–15 dígitos).");
      return;
    }
    const existing = phoneToCustomer.get(phone);
    if (existing) {
      await assignReviewToCustomer(lineId, existing);
      setNewReviewName("");
      setNewReviewPhone("");
      setShowNewReview(false);
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("customers")
      .insert({
        name,
        phone,
        phone_digits: phone,
        source: "manual",
        notes: "",
      })
      .select("id, name, phone, phone_digits")
      .single();
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setNewReviewName("");
    setNewReviewPhone("");
    setShowNewReview(false);
    await assignReviewToCustomer(lineId, data as Customer);
  }

  async function changeLineOwner(
    lineId: string,
    customer: Pick<Customer, "id" | "name" | "phone" | "phone_digits">,
    reason: string,
  ) {
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    const motivo = reason.trim();
    if (motivo.length < 3) {
      setError("Informe o motivo da troca de dono (obrigatório).");
      return;
    }
    if (line.paid || line.garage_item_id) {
      setError(
        "Item já pago ou na Caixinha/garagem — não troque o dono por aqui.",
      );
      return;
    }
    const phone =
      customer.phone_digits || normalizePhoneDigits(customer.phone || "");
    const prevWho =
      line.customers?.name ||
      line.customer_name_snapshot ||
      line.phone_digits ||
      "—";
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({
        customer_id: customer.id,
        phone_digits: phone,
        customer_name_snapshot: customer.name || phone,
        import_status:
          line.import_status === "verificar_manual" ||
          line.import_status === "sem_voto"
            ? "arrematado"
            : line.import_status || "arrematado",
        certainty: "certain",
      })
      .eq("id", lineId)
      .eq("event_id", eventId);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    await logStaffAction(supabase, {
      action: "change_owner",
      detail: `Troca de dono · ${line.product_title} · de ${prevWho} → ${customer.name || phone} · motivo: ${motivo} · ${meName}`,
      created_by: meId,
      entity_type: "event_sale_line",
      entity_id: lineId,
      customer_id: customer.id,
      event_id: eventId,
    });
    setInfo(
      `Dono alterado: ${line.product_title} → ${customer.name || phone}`,
    );
    setReassignLineId(null);
    setReassignReason("");
    setReassignSearch("");
    setShowReassignNew(false);
    await load();
  }

  async function createCustomerAndChangeOwner(lineId: string) {
    const phone = normalizePhoneDigits(reassignNewPhone);
    const name = reassignNewName.trim() || phone;
    if (!phone || phone.length < 10) {
      setError("Informe um telefone válido (10–15 dígitos).");
      return;
    }
    if (reassignReason.trim().length < 3) {
      setError("Informe o motivo da troca de dono (obrigatório).");
      return;
    }
    const existing = phoneToCustomer.get(phone);
    if (existing) {
      await changeLineOwner(lineId, existing, reassignReason);
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("customers")
      .insert({
        name,
        phone,
        phone_digits: phone,
        source: "manual",
        notes: "",
      })
      .select("id, name, phone, phone_digits")
      .single();
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    await changeLineOwner(lineId, data as Customer, reassignReason);
  }

  async function saveArrived(title: string, qtyArrived: number) {
    const n = Math.max(0, Math.floor(qtyArrived) || 0);
    const { error: err } = await supabase.from("event_product_stock").upsert(
      {
        event_id: eventId,
        product_title: title,
        qty_arrived: n,
        updated_at: new Date().toISOString(),
        updated_by: meId,
      },
      { onConflict: "event_id,product_title" },
    );
    if (err) setError(err.message);
    else {
      setInfo(`Chegada atualizada: ${title}`);
      await load();
    }
  }

  async function markProductFullyArrived(title: string, ordered: number) {
    await saveArrived(title, ordered);
  }

  async function markAllProductsFullyArrived() {
    if (!productSummary.length) return;
    setBusy(true);
    setError(null);
    try {
      const rows = productSummary.map((row) => ({
        event_id: eventId,
        product_title: row.title,
        qty_arrived: row.ordered,
        updated_at: new Date().toISOString(),
        updated_by: meId,
      }));
      const { error: err } = await supabase
        .from("event_product_stock")
        .upsert(rows, { onConflict: "event_id,product_title" });
      if (err) throw err;
      setInfo(`Chegou tudo da rodada · ${rows.length} produto(s)`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao marcar chegada");
    } finally {
      setBusy(false);
    }
  }

  async function allocate(e: FormEvent) {
    e.preventDefault();
    const { error: err } = await supabase.rpc("allocate_to_event", {
      p_event_id: eventId,
      p_card_id: allocCardId,
      p_qty: allocQty,
    });
    if (err) setError(err.message);
    else {
      setAllocQty(1);
      await load();
    }
  }

  if (!event) {
    return <p className="text-sm text-zinc-600">Carregando evento...</p>;
  }

  return (
    <div>
      <PageHeader
        title={
          editingEventName ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="field max-w-xl text-xl font-semibold"
                value={eventNameEdit}
                onChange={(e) => setEventNameEdit(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="btn-primary"
                onClick={() => void saveEventName()}
              >
                Salvar nome
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setEditingEventName(false);
                  setEventNameEdit(event.name);
                }}
              >
                Cancelar
              </button>
            </div>
          ) : (
            event.name
          )
        }
        description={`${event.kind || "leilao"} · responsável: ${event.profiles?.name || "—"} · você: ${meName}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {!editingEventName ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setEventNameEdit(event.name);
                  setEditingEventName(true);
                }}
              >
                Editar nome
              </button>
            ) : null}
            <Link href="/eventos" className="btn-secondary">
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

      <div className="panel mb-6 grid gap-3 sm:grid-cols-3">
        <div>
          <Badge tone={event.status === "open" ? "good" : "neutral"}>
            {EVENT_STATUS_LABEL[event.status]}
          </Badge>
        </div>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Prazo de pagamento</span>
          <div className="flex gap-2">
            <input
              className="field"
              type="date"
              value={paymentDue}
              onChange={(e) => setPaymentDue(e.target.value)}
            />
            <button type="button" className="btn-secondary" onClick={() => void saveDue()}>
              Salvar
            </button>
          </div>
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowImport((v) => !v)}
          >
            Importar planilha do bot
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={lines.length === 0}
            onClick={() => downloadCorrectedCsv()}
          >
            Baixar CSV corrigido
          </button>
          {event.kind === "encomenda" ? (
            <label className="btn-secondary cursor-pointer">
              Template JP/venda
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadEncomendaTemplate(f);
                  e.target.value = "";
                }}
              />
            </label>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowBox((v) => !v)}
          >
            {showBox ? "Ocultar caixa física" : "Caixa física (opcional)"}
          </button>
        </div>
      </div>

      {event.kind === "encomenda" && productCosts.length > 0 ? (
        <p className="mb-4 text-sm text-zinc-600">
          Template de custos: <strong>{productCosts.length}</strong> carta(s)
          carregada(s).
        </p>
      ) : null}

      <EventResumoPanel kind={event.kind || "leilao"} resumo={eventResumo} />

      {event.kind === "encomenda" ? (
        <form
          onSubmit={addExceptionalEncomenda}
          className="panel mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
        >
          <h2 className="sm:col-span-2 lg:col-span-6 font-semibold">
            Item extraordinário (pós-rodada)
          </h2>
          <p className="sm:col-span-2 lg:col-span-6 text-sm text-zinc-600">
            Pessoa pediu depois da rodada. Motivo obrigatório (auditoria).
          </p>
          <label className="text-sm lg:col-span-2">
            <span className="mb-1 block text-zinc-600">Cliente</span>
            <select
              className="field"
              required
              value={extraCustomerId}
              onChange={(e) => setExtraCustomerId(e.target.value)}
            >
              <option value="">Selecione</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.phone}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm lg:col-span-2">
            <span className="mb-1 block text-zinc-600">Produto</span>
            <input
              className="field"
              required
              value={extraTitle}
              onChange={(e) => setExtraTitle(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-600">Qtd</span>
            <input
              className="field"
              type="number"
              min={1}
              value={extraQty}
              onChange={(e) => setExtraQty(Number(e.target.value))}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-600">Valor R$ *</span>
            <input
              className="field"
              type="number"
              min={0}
              step="0.01"
              required
              value={extraPrice}
              onChange={(e) => setExtraPrice(e.target.value)}
            />
          </label>
          <label className="text-sm sm:col-span-2 lg:col-span-4">
            <span className="mb-1 block text-zinc-600">Motivo *</span>
            <input
              className="field"
              required
              value={extraReason}
              onChange={(e) => setExtraReason(e.target.value)}
              placeholder="Ex.: pediu no PV depois do fechamento"
            />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn-primary" disabled={busy}>
              Adicionar com motivo
            </button>
          </div>
        </form>
      ) : null}

      {showImport ? (
        <div className="panel mb-6 space-y-3">
          <h2 className="font-semibold">Importar Resultado (!planilha)</h2>
          <p className="text-sm text-zinc-600">
            Use o <strong>.xlsx</strong> do bot (aba Resultado).{" "}
            {event.kind === "encomenda" ? (
              <>
                Em <strong>encomenda</strong> só entram votos em{" "}
                <strong>Eu quero…</strong> (a opção 💙 é ignorada).
              </>
            ) : event.kind === "leilao" ? (
              <>
                Em <strong>leilão</strong> o Resultado já vem em 3 blocos: dono
                certo (arremate/lance), revisão ❓ (teve voto mas o bot não soube
                quem ganhou) e sem votos. Os três entram por padrão para
                controlar tudo que saiu na rodada.
              </>
            ) : (
              <>Importe a aba Resultado do bot.</>
            )}
          </p>
          <input
            type="file"
            accept=".xlsx,.xls,.csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPickFile(f);
            }}
          />
          {event.kind === "leilao" ? (
            <p className="text-sm text-emerald-800">
              Neste leilão a importação <strong>sempre</strong> inclui os 3
              blocos (dono certo, revisão ❓ e sem votos). Se reimportar a mesma
              planilha, só entram cartas que ainda faltam.
            </p>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeReview}
                onChange={(e) => setIncludeReview(e.target.checked)}
              />
              Incluir também linhas de revisão manual (❓)
            </label>
          )}
          {importPreview ? (
            <div className="space-y-3 text-sm text-zinc-700">
              <p>
                Aba/arquivo: <strong>{importPreview.sheetUsed}</strong>
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div className="font-semibold text-emerald-900">
                    Dono certo ({importPreview.certain.length})
                  </div>
                  <ul className="mt-1 max-h-32 overflow-y-auto text-xs text-emerald-900/80">
                    {importPreview.certain.slice(0, 40).map((l, i) => (
                      <li key={`c-${i}`}>
                        {l.product_title}
                        {l.customer_name_snapshot
                          ? ` · ${l.customer_name_snapshot}`
                          : ""}
                      </li>
                    ))}
                    {importPreview.certain.length > 40 ? (
                      <li>… +{importPreview.certain.length - 40}</li>
                    ) : null}
                  </ul>
                </div>
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                  <div className="font-semibold text-amber-900">
                    Revisão ❓ ({importPreview.review.length})
                  </div>
                  <p className="text-xs text-amber-800/80">
                    Teve voto, mas o bot não definiu o ganhador.
                  </p>
                  <ul className="mt-1 max-h-32 overflow-y-auto text-xs text-amber-900/80">
                    {importPreview.review.slice(0, 40).map((l, i) => (
                      <li key={`r-${i}`}>{l.product_title}</li>
                    ))}
                    {importPreview.review.length > 40 ? (
                      <li>… +{importPreview.review.length - 40}</li>
                    ) : null}
                  </ul>
                </div>
                <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                  <div className="font-semibold text-zinc-800">
                    Sem votos ({importPreview.noVotes.length})
                  </div>
                  <ul className="mt-1 max-h-32 overflow-y-auto text-xs text-zinc-600">
                    {importPreview.noVotes.slice(0, 40).map((l, i) => (
                      <li key={`n-${i}`}>{l.product_title}</li>
                    ))}
                    {importPreview.noVotes.length > 40 ? (
                      <li>… +{importPreview.noVotes.length - 40}</li>
                    ) : null}
                  </ul>
                </div>
              </div>
              <div>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => void confirmImport()}
                >
                  Confirmar importação
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {event.kind === "leilao" &&
      (leilaoBuckets.certain.length > 0 ||
        leilaoBuckets.review.length > 0 ||
        leilaoBuckets.noVotes.length > 0) ? (
        <section className="panel mb-6 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold">Controle do leilão</h2>
              <p className="mt-1 text-sm text-zinc-600">
                Neste evento:{" "}
                <strong>{leilaoBuckets.certain.length}</strong> dono certo ·{" "}
                <strong>{leilaoBuckets.review.length}</strong> revisão ❓ ·{" "}
                <strong>{leilaoBuckets.noVotes.length}</strong> sem votos.
                Revisões e sem votos não entram em Participantes.
              </p>
              {leilaoBuckets.review.length === 0 &&
              leilaoBuckets.noVotes.length > 0 ? (
                <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  Revisar está 0, mas a planilha do dia 9 tem 6 cartas com{" "}
                  <strong>verificar_manual</strong> (Mega Mawile, Skarmory,
                  Slowbro, Starmie, Zeraora, Rampardos). Elas provavelmente não
                  entraram no 1º import — use{" "}
                  <strong>Importar planilha do bot</strong> de novo (no leilão
                  a revisão entra sempre); só as faltantes serão adicionadas.
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => void healLeilaoStatuses()}
            >
              Corrigir status legado (lance sem dono → sem votos)
            </button>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
              <h3 className="mb-2 text-sm font-semibold text-emerald-950">
                Dono certo ({leilaoBuckets.certain.length})
              </h3>
              <input
                className="field mb-2 text-sm"
                placeholder="Buscar carta ou telefone…"
                value={certainSearch}
                onChange={(e) => setCertainSearch(e.target.value)}
              />
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {filteredCertain.length === 0 ? (
                  <li className="text-sm text-zinc-500">Nenhuma</li>
                ) : (
                  filteredCertain.map((l) => {
                    const who =
                      l.customers?.name ||
                      l.customer_name_snapshot ||
                      l.phone_digits ||
                      "—";
                    const canReassign = !l.paid && !l.garage_item_id;
                    return (
                      <li
                        key={l.id}
                        className={`rounded-md border bg-white px-2.5 py-2 text-sm ${
                          reassignLineId === l.id
                            ? "border-emerald-500 ring-1 ring-emerald-400"
                            : "border-emerald-100"
                        }`}
                      >
                        <div className="font-medium leading-snug text-zinc-900">
                          {l.product_title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                          <span className="break-all">{who}</span>
                          {l.paid ? (
                            <Badge tone="good">pago</Badge>
                          ) : (
                            <Badge tone="bad">em aberto</Badge>
                          )}
                          {canReassign ? (
                            <>
                              <button
                                type="button"
                                className="text-xs font-medium text-amber-800 underline"
                                onClick={() => {
                                  setReassignLineId(
                                    reassignLineId === l.id ? null : l.id,
                                  );
                                  setDetachLineId(null);
                                  setReassignReason("");
                                  setReassignSearch("");
                                  setShowReassignNew(false);
                                }}
                              >
                                {reassignLineId === l.id
                                  ? "Cancelar troca"
                                  : "Trocar dono"}
                              </button>
                              <button
                                type="button"
                                className="text-xs font-medium text-red-700 underline"
                                onClick={() => {
                                  setDetachLineId(
                                    detachLineId === l.id ? null : l.id,
                                  );
                                  setReassignLineId(null);
                                  setDetachReason("");
                                }}
                              >
                                {detachLineId === l.id
                                  ? "Cancelar"
                                  : "Desassociar"}
                              </button>
                            </>
                          ) : null}
                        </div>

                        {detachLineId === l.id ? (
                          <div className="mt-2 space-y-2 rounded-md border border-red-200 bg-red-50/50 p-2">
                            <p className="text-xs text-red-900">
                              Remove o dono e volta a carta para Revisar ❓.
                              Motivo obrigatório (auditoria).
                            </p>
                            <textarea
                              className="field min-h-16 text-sm"
                              placeholder="Motivo da desassociação…"
                              value={detachReason}
                              onChange={(e) => setDetachReason(e.target.value)}
                            />
                            <button
                              type="button"
                              className="btn-danger w-full text-xs"
                              disabled={busy}
                              onClick={() =>
                                void detachOwner(l.id, detachReason)
                              }
                            >
                              Confirmar desassociação
                            </button>
                          </div>
                        ) : null}

                        {reassignLineId === l.id ? (
                          <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50/50 p-2">
                            <p className="text-xs text-amber-950">
                              Ação crítica: motivo obrigatório (vai para
                              Auditoria).
                            </p>
                            <textarea
                              className="field min-h-16 text-sm"
                              placeholder="Motivo da troca de dono…"
                              value={reassignReason}
                              onChange={(e) =>
                                setReassignReason(e.target.value)
                              }
                              required
                            />
                            <div className="flex flex-wrap gap-1 text-xs">
                              <button
                                type="button"
                                className={
                                  reassignScope === "event"
                                    ? "btn-primary px-2 py-1 text-xs"
                                    : "btn-secondary px-2 py-1 text-xs"
                                }
                                onClick={() => setReassignScope("event")}
                              >
                                Deste leilão
                              </button>
                              <button
                                type="button"
                                className={
                                  reassignScope === "all"
                                    ? "btn-primary px-2 py-1 text-xs"
                                    : "btn-secondary px-2 py-1 text-xs"
                                }
                                onClick={() => setReassignScope("all")}
                              >
                                Todos
                              </button>
                            </div>
                            <input
                              className="field text-sm"
                              placeholder="Buscar nome ou telefone…"
                              value={reassignSearch}
                              onChange={(e) =>
                                setReassignSearch(e.target.value)
                              }
                            />
                            <ul className="max-h-32 space-y-1 overflow-y-auto">
                              {(reassignScope === "event"
                                ? participants
                                    .map((p) =>
                                      p.customer_id
                                        ? customers.find(
                                            (c) => c.id === p.customer_id,
                                          )
                                        : null,
                                    )
                                    .filter(Boolean)
                                : customers
                              )
                                .filter((c): c is Customer => {
                                  if (!c || c.id === l.customer_id) return false;
                                  const q = reassignSearch.trim().toLowerCase();
                                  if (!q) return true;
                                  return `${c.name} ${c.phone} ${c.phone_digits || ""}`
                                    .toLowerCase()
                                    .includes(q);
                                })
                                .slice(0, 30)
                                .map((c) => (
                                  <li key={c.id}>
                                    <button
                                      type="button"
                                      className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-white"
                                      disabled={busy}
                                      onClick={() =>
                                        void changeLineOwner(
                                          l.id,
                                          c,
                                          reassignReason,
                                        )
                                      }
                                    >
                                      <span>
                                        {labelWithPhone(c.name, c.phone || "")}
                                      </span>
                                      <span className="text-emerald-700">
                                        Confirmar
                                      </span>
                                    </button>
                                  </li>
                                ))}
                            </ul>
                            {!showReassignNew ? (
                              <button
                                type="button"
                                className="btn-secondary w-full text-xs"
                                onClick={() => setShowReassignNew(true)}
                              >
                                Novo cliente + trocar
                              </button>
                            ) : (
                              <div className="space-y-1">
                                <input
                                  className="field text-sm"
                                  placeholder="Nome"
                                  value={reassignNewName}
                                  onChange={(e) =>
                                    setReassignNewName(e.target.value)
                                  }
                                />
                                <input
                                  className="field text-sm"
                                  placeholder="Telefone"
                                  value={reassignNewPhone}
                                  onChange={(e) =>
                                    setReassignNewPhone(e.target.value)
                                  }
                                />
                                <button
                                  type="button"
                                  className="btn-primary w-full text-xs"
                                  disabled={busy}
                                  onClick={() =>
                                    void createCustomerAndChangeOwner(l.id)
                                  }
                                >
                                  Criar e confirmar troca
                                </button>
                              </div>
                            )}
                          </div>
                        ) : null}
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 lg:col-span-1">
              <h3 className="mb-1 text-sm font-semibold text-amber-950">
                Revisar ❓ ({leilaoBuckets.review.length})
              </h3>
              <p className="mb-2 text-xs text-amber-900/80">
                Clique na carta para associar o dono. Só altera essa linha — não
                mexe em itens já pagos ou na caixinha.
              </p>
              <input
                className="field mb-2 text-sm"
                placeholder="Buscar carta…"
                value={reviewCardSearch}
                onChange={(e) => setReviewCardSearch(e.target.value)}
              />
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {filteredReview.length === 0 ? (
                  <li className="text-sm text-zinc-500">Nenhuma</li>
                ) : (
                  filteredReview.map((l) => (
                    <li key={l.id}>
                      <button
                        type="button"
                        className={`w-full rounded-md border px-2.5 py-2 text-left text-sm font-medium transition ${
                          reviewLineId === l.id
                            ? "border-amber-500 bg-amber-100 text-amber-950 ring-1 ring-amber-400"
                            : "border-amber-100 bg-white text-zinc-900 hover:border-amber-300 hover:bg-amber-50"
                        }`}
                        onClick={() => {
                          setReviewLineId(l.id);
                          setShowNewReview(false);
                          setReviewSearch("");
                        }}
                      >
                        {l.product_title}
                        {lineUnitPrice(l) == null ? (
                          <span className="ml-1 text-xs font-normal text-red-600">
                            · falta R$
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))
                )}
              </ul>

              {reviewLineId &&
              leilaoBuckets.review.some((l) => l.id === reviewLineId) ? (
                (() => {
                  const line = leilaoBuckets.review.find(
                    (l) => l.id === reviewLineId,
                  )!;
                  const q = reviewSearch.trim().toLowerCase();
                  const eventCustomers = participants
                    .map((p) => {
                      if (!p.customer_id) return null;
                      const c = customers.find((x) => x.id === p.customer_id);
                      return c || null;
                    })
                    .filter(Boolean) as Customer[];
                  const pool =
                    reviewScope === "event" ? eventCustomers : customers;
                  const filtered = pool
                    .filter((c) => {
                      if (!q) return true;
                      const hay =
                        `${c.name} ${c.phone} ${c.phone_digits || ""}`.toLowerCase();
                      return hay.includes(q);
                    })
                    .slice(0, 40);
                  const sticky = stickyCustomerId
                    ? customers.find((c) => c.id === stickyCustomerId)
                    : null;

                  return (
                    <div className="mt-3 space-y-3 rounded-md border border-amber-300 bg-white p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-medium uppercase tracking-wide text-amber-800">
                            Associar dono
                          </div>
                          <div className="font-semibold text-zinc-900">
                            {line.product_title}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="text-xs text-zinc-500 underline"
                          onClick={() => {
                            setReviewLineId(null);
                            setShowNewReview(false);
                          }}
                        >
                          Fechar
                        </button>
                      </div>

                      <div className="flex flex-wrap gap-2 text-xs">
                        <button
                          type="button"
                          className={
                            reviewScope === "event"
                              ? "btn-primary px-2 py-1 text-xs"
                              : "btn-secondary px-2 py-1 text-xs"
                          }
                          onClick={() => setReviewScope("event")}
                        >
                          Deste leilão ({eventCustomers.length})
                        </button>
                        <button
                          type="button"
                          className={
                            reviewScope === "all"
                              ? "btn-primary px-2 py-1 text-xs"
                              : "btn-secondary px-2 py-1 text-xs"
                          }
                          onClick={() => setReviewScope("all")}
                        >
                          Todos os clientes
                        </button>
                      </div>

                      <label className="flex items-center gap-2 text-xs text-zinc-700">
                        <input
                          type="checkbox"
                          checked={reviewKeep}
                          onChange={(e) => setReviewKeep(e.target.checked)}
                        />
                        Continuar com o mesmo cliente nas próximas cartas
                      </label>

                      <textarea
                        className="field min-h-14 text-sm"
                        placeholder="Motivo da associação (obrigatório)…"
                        value={reviewReason}
                        onChange={(e) => setReviewReason(e.target.value)}
                      />

                      {sticky && reviewKeep ? (
                        <button
                          type="button"
                          className="btn-primary w-full text-sm"
                          disabled={busy}
                          onClick={() =>
                            void assignReviewToCustomer(line.id, sticky)
                          }
                        >
                          Usar de novo: {labelWithPhone(sticky.name, sticky.phone)}
                        </button>
                      ) : null}

                      <input
                        className="field text-sm"
                        placeholder="Buscar nome ou telefone…"
                        value={reviewSearch}
                        onChange={(e) => setReviewSearch(e.target.value)}
                      />

                      <ul className="max-h-40 space-y-1 overflow-y-auto">
                        {filtered.length === 0 ? (
                          <li className="text-xs text-zinc-500">
                            Nenhum cliente encontrado.
                          </li>
                        ) : (
                          filtered.map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100"
                                disabled={busy}
                                onClick={() =>
                                  void assignReviewToCustomer(line.id, c)
                                }
                              >
                                <span>
                                  {labelWithPhone(c.name, c.phone || "")}
                                </span>
                                <span className="text-xs text-emerald-700">
                                  Associar
                                </span>
                              </button>
                            </li>
                          ))
                        )}
                      </ul>

                      {!showNewReview ? (
                        <button
                          type="button"
                          className="btn-secondary w-full text-sm"
                          onClick={() => setShowNewReview(true)}
                        >
                          Cadastrar cliente novo e associar
                        </button>
                      ) : (
                        <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2">
                          <input
                            className="field text-sm"
                            placeholder="Nome"
                            value={newReviewName}
                            onChange={(e) => setNewReviewName(e.target.value)}
                          />
                          <input
                            className="field text-sm"
                            placeholder="Telefone / WhatsApp"
                            value={newReviewPhone}
                            onChange={(e) => setNewReviewPhone(e.target.value)}
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="btn-primary flex-1 text-sm"
                              disabled={busy}
                              onClick={() =>
                                void createCustomerAndAssignReview(line.id)
                              }
                            >
                              Criar e associar
                            </button>
                            <button
                              type="button"
                              className="btn-secondary text-sm"
                              onClick={() => setShowNewReview(false)}
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()
              ) : null}
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
              <h3 className="mb-1 text-sm font-semibold text-zinc-900">
                Sem votos ({leilaoBuckets.noVotes.length})
              </h3>
              <p className="mb-2 text-xs text-zinc-500">
                Clique para associar dono (motivo obrigatório).
              </p>
              <input
                className="field mb-2 text-sm"
                placeholder="Buscar carta…"
                value={noVotesSearch}
                onChange={(e) => setNoVotesSearch(e.target.value)}
              />
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {filteredNoVotes.length === 0 ? (
                  <li className="text-sm text-zinc-500">Nenhuma</li>
                ) : (
                  filteredNoVotes.map((l) => (
                    <li key={l.id}>
                      <button
                        type="button"
                        className={`w-full rounded-md border px-2.5 py-2 text-left text-sm transition ${
                          orphanLineId === l.id
                            ? "border-zinc-500 bg-zinc-200 ring-1 ring-zinc-400"
                            : "border-zinc-100 bg-white text-zinc-800 hover:bg-zinc-50"
                        }`}
                        onClick={() => {
                          setOrphanLineId(
                            orphanLineId === l.id ? null : l.id,
                          );
                          setControlReason("");
                          setOrphanSearch("");
                        }}
                      >
                        {l.product_title}
                      </button>
                    </li>
                  ))
                )}
              </ul>
              {orphanLineId &&
              leilaoBuckets.noVotes.some((l) => l.id === orphanLineId) ? (
                (() => {
                  const line = leilaoBuckets.noVotes.find(
                    (l) => l.id === orphanLineId,
                  )!;
                  const q = orphanSearch.trim().toLowerCase();
                  const filtered = customers
                    .filter((c) => {
                      if (!q) return true;
                      return `${c.name} ${c.phone} ${c.phone_digits || ""}`
                        .toLowerCase()
                        .includes(q);
                    })
                    .slice(0, 40);
                  return (
                    <div className="mt-3 space-y-2 rounded-md border border-zinc-300 bg-white p-3">
                      <div className="font-semibold text-sm">
                        Associar: {line.product_title}
                      </div>
                      <textarea
                        className="field min-h-14 text-sm"
                        placeholder="Motivo (obrigatório)…"
                        value={controlReason}
                        onChange={(e) => setControlReason(e.target.value)}
                      />
                      <input
                        className="field text-sm"
                        placeholder="Buscar cliente…"
                        value={orphanSearch}
                        onChange={(e) => setOrphanSearch(e.target.value)}
                      />
                      <ul className="max-h-36 space-y-1 overflow-y-auto">
                        {filtered.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              className="flex w-full justify-between rounded px-2 py-1 text-left text-sm hover:bg-zinc-100"
                              disabled={busy}
                              onClick={() =>
                                void assignOwnerControlled(
                                  line.id,
                                  c,
                                  controlReason,
                                  ["no_votes"],
                                )
                              }
                            >
                              <span>
                                {labelWithPhone(c.name, c.phone || "")}
                              </span>
                              <span className="text-xs text-emerald-700">
                                Associar
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {event.kind === "encomenda" && productSummary.length > 0 ? (
        <section className="panel mb-6">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold">Resumo das encomendas</h2>
              <p className="mt-1 text-sm text-zinc-600">
                Cada voto em Eu quero… conta 1 un. por padrão. Votos 💙 ficam na aba
                retrátil e não entram neste resumo.
              </p>
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void markAllProductsFullyArrived()}
            >
              Chegou tudo desta rodada
            </button>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Pedidos</th>
                  <th>Un. encomendadas</th>
                  <th>Chegou no estoque</th>
                  <th>Falta</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {productSummary.map((row) => {
                  const falta = Math.max(0, row.ordered - row.arrived);
                  const open = Boolean(openProductTitles[row.title]);
                  return (
                    <Fragment key={row.title}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="flex w-full items-start gap-2 text-left"
                            onClick={() =>
                              setOpenProductTitles((s) => ({
                                ...s,
                                [row.title]: !s[row.title],
                              }))
                            }
                          >
                            <span className="mt-0.5 text-zinc-400">
                              {open ? "▾" : "▸"}
                            </span>
                            <span>
                              <span className="font-medium">{row.title}</span>
                              <span className="mt-0.5 block text-xs font-normal text-zinc-500">
                                {open
                                  ? "ocultar quem pediu"
                                  : "ver clientes e ajustar qtd"}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td>{row.people}</td>
                        <td>{row.ordered}</td>
                        <td>
                          <input
                            className="field w-24"
                            type="number"
                            min={0}
                            defaultValue={row.arrived}
                            key={`${row.title}-${row.arrived}`}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (v !== row.arrived) void saveArrived(row.title, v);
                            }}
                          />
                        </td>
                        <td>
                          {falta > 0 ? (
                            <Badge tone="warn">{falta}</Badge>
                          ) : (
                            <Badge tone="good">ok</Badge>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-secondary whitespace-nowrap px-2 py-1 text-xs"
                            disabled={falta === 0 || busy}
                            onClick={() =>
                              void markProductFullyArrived(row.title, row.ordered)
                            }
                          >
                            Chegaram todas
                          </button>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="bg-zinc-50">
                          <td colSpan={6} className="!py-3">
                            <ul className="space-y-2 px-2">
                              {row.lines.map((line) => {
                                const who =
                                  line.customers?.name ||
                                  line.customer_name_snapshot ||
                                  line.phone_digits ||
                                  "Sem cliente";
                                const phone =
                                  line.customers?.phone || line.phone_digits || "";
                                return (
                                  <li
                                    key={line.id}
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                                  >
                                    <div className="min-w-0">
                                      {line.customer_id ? (
                                        <Link
                                          href={`/clientes/${line.customer_id}`}
                                          className="font-medium underline decoration-zinc-300 underline-offset-2"
                                        >
                                          {who}
                                          {phone && who !== phone
                                            ? ` (${phone})`
                                            : ""}
                                        </Link>
                                      ) : (
                                        <span className="font-medium">{who}</span>
                                      )}
                                      <div className="text-xs text-zinc-500">
                                        {line.paid
                                          ? "pago"
                                          : line.charged
                                            ? "cobrado"
                                            : "em aberto"}
                                      </div>
                                    </div>
                                    <label className="flex items-center gap-2 text-xs text-zinc-600">
                                      Qtd
                                      <input
                                        className="field w-16 px-2 py-1"
                                        type="number"
                                        min={1}
                                        defaultValue={
                                          Number(line.qty) > 0
                                            ? Number(line.qty)
                                            : 1
                                        }
                                        key={`${line.id}-sum-${line.qty}`}
                                        onBlur={(e) => {
                                          const v = Number(e.target.value);
                                          const cur =
                                            Number(line.qty) > 0
                                              ? Number(line.qty)
                                              : 1;
                                          if (v !== cur) {
                                            void updateLineQty(line.id, v);
                                          }
                                        }}
                                      />
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {eventShelvedLines.length > 0 ? (
        <details
          className="panel mb-6"
          open={showShelvedEvent}
          onToggle={(e) =>
            setShowShelvedEvent((e.target as HTMLDetailsElement).open)
          }
        >
          <summary className="cursor-pointer font-semibold text-zinc-800">
            Arquivados / votos 💙 deste evento ({eventShelvedLines.length})
          </summary>
          <p className="mt-2 text-sm text-zinc-600">
            Não entram em cobrança, resumo nem envio. Dá para restaurar se foi
            arquivado por engano.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void archiveAllHeartsInEvent()}
            >
              Confirmar arquivo de todos os 💙
            </button>
          </div>
          <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto text-sm text-zinc-700">
            {eventShelvedLines.slice(0, 80).map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {l.customer_name_snapshot || l.phone_digits} · {l.product_title}{" "}
                  <span className="text-zinc-400">
                    ({l.valor_ou_opcao || "—"})
                  </span>
                </span>
                {l.archived || !isEncInterestOption(l.valor_ou_opcao || "") ? (
                  <button
                    type="button"
                    className="text-xs font-medium underline"
                    onClick={() => void setArchived([l.id], false)}
                  >
                    Restaurar
                  </button>
                ) : null}
              </li>
            ))}
            {eventShelvedLines.length > 80 ? (
              <li className="text-zinc-500">
                … e mais {eventShelvedLines.length - 80}
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}

      <div className="mb-6 grid gap-4 xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]">
        <section className="panel">
          <h2 className="mb-3 font-semibold">
            Participantes ({participants.length})
          </h2>
          {participants.length === 0 ? (
            <EmptyState
              title="Ninguém ainda"
              hint="Importe a planilha ou adicione item manual. Votos 💙 ficam arquivados."
            />
          ) : (
            <>
              <input
                className="field mb-2 text-sm"
                placeholder="Buscar participante (nome ou telefone)…"
                value={participantSearch}
                onChange={(e) => setParticipantSearch(e.target.value)}
              />
            <ul className="max-h-[min(70vh,40rem)] space-y-1 overflow-y-auto">
              {filteredParticipants.length === 0 ? (
                <li className="px-2 py-2 text-sm text-zinc-500">
                  Nenhum participante com esse filtro.
                </li>
              ) : null}
              {filteredParticipants.map((p) => {
                const urgent = p.urgency === "overdue" || p.urgency === "warn";
                const activeLines = p.lines.filter(
                  (l) => !isShelvedSaleLine(l, event.kind),
                );
                const activeCount = activeLines.length;
                const missingPrice = activeLines.filter(
                  (l) => lineUnitPrice(l) == null,
                ).length;
                return (
                  <li key={p.key}>
                    <button
                      type="button"
                      className={`flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm ${
                        selectedParticipant === p.key
                          ? "bg-zinc-900 text-white"
                          : urgent
                            ? "bg-red-50 text-red-800 hover:bg-red-100"
                            : "hover:bg-zinc-100"
                      }`}
                      onClick={() => {
                        setSelectedParticipant(p.key);
                        setSelectedLineIds({});
                        setShowShelved(false);
                      }}
                    >
                      <span className="font-medium">
                        {labelWithPhone(p.name, p.phone)}
                        {missingPrice > 0 && selectedParticipant !== p.key ? (
                          <span
                            className="ml-1 inline-block h-2 w-2 rounded-full bg-red-500"
                            title={`${missingPrice} sem valor`}
                          />
                        ) : null}
                      </span>
                      <span className="text-xs opacity-80">
                        {activeCount} item(ns)
                        {p.unpaid ? ` · ${p.unpaid} em aberto` : " · ok"}
                        {missingPrice ? ` · ${missingPrice} sem R$` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            </>
          )}
          {shelvedOnlyParticipants.length > 0 ? (
            <details className="mt-3 border-t border-zinc-100 pt-3">
              <summary className="cursor-pointer text-sm text-zinc-600">
                Só 💙 / arquivados ({shelvedOnlyParticipants.length})
              </summary>
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {shelvedOnlyParticipants.map((p) => (
                  <li key={p.key}>
                    <button
                      type="button"
                      className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                        selectedParticipant === p.key
                          ? "bg-zinc-900 text-white"
                          : "text-zinc-600 hover:bg-zinc-100"
                      }`}
                      onClick={() => {
                        setSelectedParticipant(p.key);
                        setSelectedLineIds({});
                        setShowShelved(true);
                      }}
                    >
                      {labelWithPhone(p.name, p.phone)}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>

        <section className="panel">
          {!activeParticipant ? (
            <EmptyState title="Selecione um participante" />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2
                    className={`text-lg font-semibold ${
                      activeParticipant.urgency === "overdue" ||
                      activeParticipant.urgency === "warn"
                        ? "text-red-700"
                        : ""
                    }`}
                  >
                    {labelWithPhone(
                      activeParticipant.name,
                      activeParticipant.phone,
                    )}
                  </h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary px-2 py-1 text-xs"
                    title="Copia a mensagem de cobrança (não aparece na tela)"
                    onClick={() => void copyBillingMessage()}
                    disabled={activeMainLines.length === 0}
                  >
                    Copiar cobrança
                  </button>
                  {activeParticipant.customer_id ? (
                    <>
                      <Link
                        className="btn-primary px-2 py-1 text-xs"
                        href={`/clientes/${activeParticipant.customer_id}?tab=garagem`}
                      >
                        Caixinha/garagem
                      </Link>
                      <Link
                        className="btn-secondary"
                        href={`/clientes/${activeParticipant.customer_id}`}
                      >
                        Abrir ficha
                      </Link>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={selectedCount === 0}
                  onClick={() =>
                    void markSeparated(selectedIdsFromParticipant(), true)
                  }
                >
                  Marcar como separado
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={selectedCount === 0}
                  onClick={() =>
                    void markCharged(selectedIdsFromParticipant(), true)
                  }
                >
                  Cobrança feita
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={selectedCount === 0}
                  onClick={() => void markPaid(selectedIdsFromParticipant(), true)}
                >
                  Marcar pago
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={selectedCount === 0}
                  onClick={() =>
                    void setArchived(selectedIdsFromParticipant(), true)
                  }
                >
                  Arquivar seleção
                </button>
                <ConfirmButton
                  label="Cancelar itens"
                  confirmLabel="Cancelar selecionados?"
                  className="btn-danger"
                  disabled={selectedCount === 0}
                  onConfirm={() => cancelLines(selectedIdsFromParticipant())}
                />
                {selectedCount > 0 ? (
                  <span className="text-xs text-zinc-500">
                    {selectedCount} selecionado(s)
                  </span>
                ) : (
                  <span className="text-xs text-zinc-400">
                    Selecione ao menos 1 item
                  </span>
                )}
              </div>

              {activeMainLines.length === 0 ? (
                <EmptyState
                  title="Nenhum item ativo"
                  hint="Os resultados deste participante estão na aba retrátil abaixo (💙 / arquivados)."
                />
              ) : (
                <div className="table-wrap">
                  <table className="data min-w-[640px]">
                    <thead>
                      <tr>
                        <th className="w-10">
                          <input
                            type="checkbox"
                            title="Selecionar todos"
                            checked={allActiveSelected}
                            disabled={activeMainLines.length === 0}
                            onChange={(e) => toggleSelectAll(e.target.checked)}
                          />
                        </th>
                        <th>Produto</th>
                        <th className="w-20">Qtd</th>
                        <th>Status</th>
                        <th>Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeMainLines.map((line) => {
                        const price = lineUnitPrice(line);
                        return (
                          <tr key={line.id}>
                            <td>
                              <input
                                type="checkbox"
                                checked={Boolean(selectedLineIds[line.id])}
                                onChange={(e) =>
                                  setSelectedLineIds((s) => ({
                                    ...s,
                                    [line.id]: e.target.checked,
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <div className="font-medium">{line.product_title}</div>
                              <div className="text-xs text-zinc-500">
                                {line.valor_ou_opcao || "—"}
                                {line.arremate ? " · arremate" : ""}
                                {line.certainty === "manual_review"
                                  ? " · revisão"
                                  : ""}
                              </div>
                            </td>
                            <td>
                              <input
                                className="field w-16 px-2 py-1"
                                type="number"
                                min={1}
                                defaultValue={
                                  Number(line.qty) > 0 ? Number(line.qty) : 1
                                }
                                key={`${line.id}-${line.qty}`}
                                onBlur={(e) => {
                                  const v = Number(e.target.value);
                                  const cur =
                                    Number(line.qty) > 0 ? Number(line.qty) : 1;
                                  if (v !== cur) void updateLineQty(line.id, v);
                                }}
                              />
                            </td>
                            <td>
                              <div className="flex flex-wrap gap-1">
                                <Badge
                                  tone={line.separated ? "info" : "neutral"}
                                  title="Clique para inverter separado"
                                  onClick={() =>
                                    void markSeparated([line.id], !line.separated)
                                  }
                                >
                                  {line.separated ? "Separado" : "Não separado"}
                                </Badge>
                                <Badge
                                  tone={line.charged ? "warn" : "neutral"}
                                  title="Clique para inverter cobrança"
                                  onClick={() =>
                                    void markCharged([line.id], !line.charged)
                                  }
                                >
                                  {line.charged ? "Cobrado" : "Não cobrado"}
                                </Badge>
                                <Badge
                                  tone={line.paid ? "good" : "bad"}
                                  title="Clique para inverter pagamento"
                                  onClick={() =>
                                    void markPaid([line.id], !line.paid)
                                  }
                                >
                                  {line.paid ? "Pago" : "Em aberto"}
                                </Badge>
                                {line.garage_item_id ? (
                                  <Badge
                                    tone="good"
                                    title="Caixinha/garagem = item guardado do cliente (criado ao marcar pago). Diferente de Separado (preparação física no evento)."
                                  >
                                    Caixinha/garagem
                                  </Badge>
                                ) : null}
                              </div>
                              {line.paid_at ? (
                                <div className="mt-1 text-xs text-zinc-500">
                                  Pago em{" "}
                                  {new Date(line.paid_at).toLocaleString("pt-BR")}
                                </div>
                              ) : null}
                              {line.charged_at && !line.paid ? (
                                <div className="mt-1 text-xs text-zinc-500">
                                  Cobrado em{" "}
                                  {new Date(line.charged_at).toLocaleString(
                                    "pt-BR",
                                  )}
                                </div>
                              ) : null}
                            </td>
                            <td className="text-sm">
                              {price != null &&
                              line.unit_price != null &&
                              Number.isFinite(Number(line.unit_price)) ? (
                                <input
                                  className="field w-24 px-2 py-1"
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  defaultValue={Number(line.unit_price)}
                                  key={`${line.id}-price-${line.unit_price}`}
                                  onBlur={(e) => {
                                    const v = Number(
                                      String(e.target.value).replace(",", "."),
                                    );
                                    if (
                                      Number.isFinite(v) &&
                                      v !== Number(line.unit_price)
                                    ) {
                                      void updateLinePrice(line.id, e.target.value);
                                    }
                                  }}
                                />
                              ) : (
                                <div className="flex flex-col gap-1">
                                  <Badge tone="bad" title="Preencha o valor">
                                    Falta valor
                                  </Badge>
                                  <input
                                    className="field w-24 border-red-300 px-2 py-1 ring-1 ring-red-200"
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    placeholder={
                                      price != null
                                        ? String(price.toFixed(2))
                                        : "R$"
                                    }
                                    defaultValue={
                                      price != null ? String(price) : ""
                                    }
                                    key={`${line.id}-price-missing`}
                                    onBlur={(e) => {
                                      if (e.target.value.trim()) {
                                        void updateLinePrice(
                                          line.id,
                                          e.target.value,
                                        );
                                      }
                                    }}
                                  />
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {activeShelvedLines.length > 0 ? (
                <details
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2"
                  open={showShelved}
                  onToggle={(e) =>
                    setShowShelved((e.target as HTMLDetailsElement).open)
                  }
                >
                  <summary className="cursor-pointer text-sm font-medium text-zinc-700">
                    Arquivados / 💙 deste participante ({activeShelvedLines.length})
                  </summary>
                  <ul className="mt-2 space-y-2 text-sm">
                    {activeShelvedLines.map((line) => (
                      <li
                        key={line.id}
                        className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 pb-2 last:border-0"
                      >
                        <div>
                          <div className="font-medium">{line.product_title}</div>
                          <div className="text-xs text-zinc-500">
                            {line.valor_ou_opcao || "—"}
                          </div>
                        </div>
                        {line.archived ||
                        !isEncInterestOption(line.valor_ou_opcao || "") ? (
                          <button
                            type="button"
                            className="text-xs font-medium underline"
                            onClick={() => void setArchived([line.id], false)}
                          >
                            Restaurar
                          </button>
                        ) : (
                          <span className="text-xs text-zinc-400">
                            interesse (💙)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <form onSubmit={addManual} className="panel mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <h2 className="sm:col-span-2 lg:col-span-6 font-semibold">
          Adicionar item manual (se a planilha não pegou / pedido extra no PV)
        </h2>
        <label className="text-sm lg:col-span-2">
          <span className="mb-1 block text-zinc-600">Cliente</span>
          <select
            className="field"
            required
            value={manualCustomerId}
            onChange={(e) => setManualCustomerId(e.target.value)}
          >
            <option value="">Selecione</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.phone}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm lg:col-span-2">
          <span className="mb-1 block text-zinc-600">Produto / carta</span>
          <input
            className="field"
            required
            value={manualTitle}
            onChange={(e) => setManualTitle(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Qtd</span>
          <input
            className="field"
            type="number"
            min={1}
            value={manualQty}
            onChange={(e) => setManualQty(Number(e.target.value))}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Valor R$ *</span>
          <input
            className="field"
            type="number"
            min={0}
            step="0.01"
            required
            value={manualPrice}
            onChange={(e) => setManualPrice(e.target.value)}
          />
        </label>
        <label className="text-sm lg:col-span-4">
          <span className="mb-1 block text-zinc-600">Opção / obs.</span>
          <input
            className="field"
            value={manualValor}
            onChange={(e) => setManualValor(e.target.value)}
          />
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn-primary">
            Adicionar
          </button>
        </div>
      </form>

      {showBox ? (
        <section className="panel mb-6">
          <h2 className="mb-2 font-semibold">Caixa física (opcional)</h2>
          <p className="mb-3 text-sm text-zinc-600">
            Só use se quiser espelhar cartas tiradas do estoque livre. Não é
            obrigatório para cobrança do leilão.
          </p>
          <form onSubmit={allocate} className="grid gap-3 sm:grid-cols-4">
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block text-zinc-600">Carta em estoque</span>
              <select
                className="field"
                required
                value={allocCardId}
                onChange={(e) => setAllocCardId(e.target.value)}
              >
                <option value="">Selecione</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {cardLabel(c)} — {c.qty_in_stock}
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
                value={allocQty}
                onChange={(e) => setAllocQty(Number(e.target.value))}
              />
            </label>
            <div className="flex items-end">
              <button type="submit" className="btn-secondary">
                Colocar na caixa
              </button>
            </div>
          </form>
          {allocations.length ? (
            <ul className="mt-3 text-sm text-zinc-700">
              {allocations.map((a) => (
                <li key={a.id}>
                  {a.cards ? cardLabel(a.cards) : a.card_id} × {a.qty}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
