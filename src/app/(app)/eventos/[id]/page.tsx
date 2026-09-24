"use client";

import Link from "next/link";
import {
  FormEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmButton } from "@/components/ConfirmButton";
import { TypeToConfirmDialog } from "@/components/TypeToConfirmDialog";
import { deleteEventKeepingBackup } from "@/lib/event-backup";
import { EventResumoPanel } from "@/components/EventResumoPanel";
import { FileDropZone } from "@/components/FileDropZone";
import { createClient } from "@/lib/supabase/client";
import { eventHappenedAtIso, eventHappenedOn } from "@/lib/event-date";
import { EVENT_STATUS_LABEL, cardLabel } from "@/lib/labels";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import {
  buildPhoneCustomerIndex,
  customerPhoneDigits,
  ensureCustomerByPhone,
  fetchAllCustomers,
  fetchAllQueryRows,
  looksLikePhoneName,
  matchesCustomerQuery,
} from "@/lib/customers";
import { logStaffAction } from "@/lib/audit";
import {
  parseResultadoFile,
  paymentUrgency,
  filterLinesForKind,
  isShelvedSaleLine,
  isEncInterestOption,
  parseMoneyFromOption,
  classifyStoredLeilaoLine,
  isActiveBillableSaleLine,
  saleLineImportDedupeKey,
  type ParsedSaleLine,
} from "@/lib/leilao-resultado";
import {
  buildBillingMessage,
  buildEncomendaPedidoMessages,
  greetingName,
} from "@/lib/cobranca-msg";
import {
  looksLikeEncomendaCostWorkbook,
  parseEncomendaTemplateCsv,
  parseEncomendaXlsx,
  productMatchKey,
  type EncomendaCostRow,
} from "@/lib/encomenda-template";
import { buildEventResumo, saleLineHasOwner } from "@/lib/evento-resumo";
import { cardTitleToJa } from "@/lib/card-title-ja";
import {
  embedCardOrder,
  orderMapFromTitles,
  parseEmbeddedCardOrder,
} from "@/lib/card-order";
import {
  cardSortMs,
  compareByCardSort,
  type CardSortMode,
} from "@/lib/card-sort";
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
  GarageItem,
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

/** Estágio do fluxo: vermelho → laranja → amarelo → azul → verde. */
type ParticipantFlowStage = 0 | 1 | 2 | 3 | 4;

const PARTICIPANT_FLOW_LEGEND: Array<{
  stage: ParticipantFlowStage;
  label: string;
  swatch: string;
}> = [
  { stage: 0, label: "Nada feito", swatch: "bg-red-400" },
  { stage: 1, label: "Cobrado", swatch: "bg-orange-400" },
  { stage: 2, label: "Pago", swatch: "bg-amber-300" },
  { stage: 3, label: "Separado", swatch: "bg-sky-400" },
  { stage: 4, label: "Enviado", swatch: "bg-emerald-400" },
];

function lineAlreadyShippedWithGarage(
  line: EventSaleLine,
  garageById: Record<string, GarageItem>,
): boolean {
  if (!line.garage_item_id) return false;
  const g = garageById[line.garage_item_id];
  if (!g) return false;
  return (
    Number(g.qty_with_store) <= 0 &&
    Number(g.qty_sent) > 0 &&
    g.status !== "cancelled"
  );
}

/** Estágio da linha: o mais alto vale sozinho (os anteriores estão implícitos). */
function saleLineFlowStage(
  line: EventSaleLine,
  garageById: Record<string, GarageItem>,
): ParticipantFlowStage {
  if (lineAlreadyShippedWithGarage(line, garageById)) return 4;
  if (line.separated) return 3;
  if (line.paid) return 2;
  if (line.charged) return 1;
  return 0;
}

/** Pior estágio entre as cartas ativas do participante. */
function participantFlowStage(
  lines: EventSaleLine[],
  kind: Event["kind"] | null | undefined,
  garageById: Record<string, GarageItem>,
): ParticipantFlowStage {
  const active = lines.filter(
    (l) => !l.cancelled && !isShelvedSaleLine(l, kind),
  );
  if (!active.length) return 0;
  let min: ParticipantFlowStage = 4;
  for (const l of active) {
    const s = saleLineFlowStage(l, garageById);
    if (s < min) min = s;
  }
  return min;
}

function participantFlowCardClass(
  stage: ParticipantFlowStage,
  selected: boolean,
): string {
  if (selected) {
    const selectedByStage: Record<ParticipantFlowStage, string> = {
      0: "bg-red-800 text-white ring-2 ring-red-950",
      1: "bg-orange-700 text-white ring-2 ring-orange-950",
      2: "bg-amber-600 text-white ring-2 ring-amber-900",
      3: "bg-sky-700 text-white ring-2 ring-sky-950",
      4: "bg-emerald-700 text-white ring-2 ring-emerald-950",
    };
    return selectedByStage[stage];
  }
  const idleByStage: Record<ParticipantFlowStage, string> = {
    0: "bg-red-50 text-red-900 hover:bg-red-100",
    1: "bg-orange-50 text-orange-950 hover:bg-orange-100",
    2: "bg-amber-50 text-amber-950 hover:bg-amber-100",
    3: "bg-sky-50 text-sky-950 hover:bg-sky-100",
    4: "bg-emerald-50 text-emerald-950 hover:bg-emerald-100",
  };
  return idleByStage[stage];
}

/** Nome de cadastro que ainda é só o telefone (import bruto). */
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

function saleLinePhone(line: EventSaleLine): string {
  return normalizePhoneDigits(
    line.phone_digits || line.customers?.phone || "",
  );
}

function findCustomerOnProduct(
  productLines: EventSaleLine[],
  customer: Pick<Customer, "phone" | "phone_digits"> & { id?: string | null },
): EventSaleLine | undefined {
  const phone = customerPhoneDigits(customer);
  return productLines.find((l) => {
    if (customer.id && l.customer_id === customer.id) return true;
    const lp = saleLinePhone(l);
    return Boolean(phone && lp && phone === lp);
  });
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
  const router = useRouter();
  const eventId = params.id;
  const supabase = useMemo(() => createClient(), []);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [event, setEvent] = useState<(Event & { profiles?: Profile | null }) | null>(null);
  const [lines, setLines] = useState<EventSaleLine[]>([]);
  const [garageById, setGarageById] = useState<Record<string, GarageItem>>({});
  const [productStock, setProductStock] = useState<EventProductStock[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [allocations, setAllocations] = useState<EventAllocation[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState("Staff");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Evita clique duplo em “Pago” criar vários itens na caixinha. */
  const markPaidInFlight = useRef(false);
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
  const [eventHeldOn, setEventHeldOn] = useState("");
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
  const [addVoteSearchByTitle, setAddVoteSearchByTitle] = useState<
    Record<string, string>
  >({});
  const [addVoteQtyByTitle, setAddVoteQtyByTitle] = useState<
    Record<string, number>
  >({});
  const [addVoteShowNewFor, setAddVoteShowNewFor] = useState<string | null>(null);
  const [addVoteNewName, setAddVoteNewName] = useState("");
  const [addVoteNewPhone, setAddVoteNewPhone] = useState("");
  const [importDragging, setImportDragging] = useState(false);

  /** Revisão ❓: atribuir dono sem mexer em itens já pagos/organizados. */
  const [reviewLineId, setReviewLineId] = useState<string | null>(null);
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewScope, setReviewScope] = useState<"event" | "all">("all");
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
  const [reassignScope, setReassignScope] = useState<"event" | "all">("all");
  const [showReassignNew, setShowReassignNew] = useState(false);
  const [reassignNewName, setReassignNewName] = useState("");
  const [reassignNewPhone, setReassignNewPhone] = useState("");

  const [productCosts, setProductCosts] = useState<EventProductCost[]>([]);
  const [cardSort, setCardSort] = useState<CardSortMode>("enquete");
  const [cardOrder, setCardOrder] = useState<Record<string, number>>({});
  const [orphanDeleteOpen, setOrphanDeleteOpen] = useState(false);
  const [orphanDeleteReason, setOrphanDeleteReason] = useState("");
  const [orphanDeleteIds, setOrphanDeleteIds] = useState<string[]>([]);
  const [controlReason, setControlReason] = useState("");
  const [orphanLineId, setOrphanLineId] = useState<string | null>(null);
  const [orphanSearch, setOrphanSearch] = useState("");
  const [showOrphanNew, setShowOrphanNew] = useState(false);
  const [orphanNewName, setOrphanNewName] = useState("");
  const [orphanNewPhone, setOrphanNewPhone] = useState("");
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

    const customersPromise = fetchAllCustomers(supabase).catch((e) => {
      console.error(e);
      return [] as Customer[];
    });

    const [ev, ln, al, cd, ps, costs] = await Promise.all([
      supabase
        .from("events")
        .select("*, profiles!owner_id(id, name, role, created_at)")
        .eq("id", eventId)
        .single(),
      (async () => {
        try {
          const rows = await fetchAllQueryRows<EventSaleLine>((from, to) =>
            supabase
              .from("event_sale_lines")
              .select("*, customers(id, name, phone)")
              .eq("event_id", eventId)
              .order("created_at", { ascending: true })
              .range(from, to),
          );
          return { data: rows, error: null as { message: string } | null };
        } catch (e) {
          return {
            data: null,
            error: { message: e instanceof Error ? e.message : String(e) },
          };
        }
      })(),
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
        .order("created_at", { ascending: true }),
    ]);

    if (ev.error) setError(ev.error.message);
    else {
      setEvent(ev.data as typeof event);
      setPaymentDue((ev.data as Event).payment_due_at || "");
      setEventHeldOn(
        eventHappenedOn({
          name: (ev.data as Event).name,
          opened_at: (ev.data as Event).opened_at,
        }) || "",
      );
      setEventNameEdit((ev.data as Event).name || "");
      setShowBox(Boolean((ev.data as Event).use_stock_box));
      setCardOrder(parseEmbeddedCardOrder((ev.data as Event).notes));
    }

    if (ln.error) setError(ln.error.message);
    else {
      const saleLines = (ln.data as EventSaleLine[]) || [];
      setLines(saleLines);
      const garageIds = [
        ...new Set(
          saleLines
            .map((l) => l.garage_item_id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (garageIds.length) {
        const { data: garageRows } = await supabase
          .from("customer_garage_items")
          .select("*")
          .in("id", garageIds);
        const map: Record<string, GarageItem> = {};
        for (const g of (garageRows as GarageItem[]) || []) {
          map[g.id] = g;
        }
        setGarageById(map);
      } else {
        setGarageById({});
      }
    }

    if (ps.error && !String(ps.error.message || "").includes("does not exist")) {
      setError(ps.error.message);
    } else {
      setProductStock((ps.data as EventProductStock[]) || []);
    }

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
    setCustomers(await customersPromise);
  }, [supabase, eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const phoneToCustomer = useMemo(
    () => buildPhoneCustomerIndex(customers),
    [customers],
  );

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
      const byPhone = phone ? phoneToCustomer.get(phone) : undefined;
      const byId = line.customer_id
        ? customers.find((c) => c.id === line.customer_id)
        : undefined;
      const cust = byPhone || byId;
      const owned = saleLineHasOwner({
        customer_id: cust?.id || line.customer_id,
        phone: cust?.phone || phone,
        phone_digits: phone,
      });
      const key = owned ? cust?.id || phone || line.id : "__sem_cliente__";
      const name = owned
        ? displayCustomerName(cust, line.customer_name_snapshot, phone)
        : "Sem cliente";
      let p = byKey.get(key);
      if (!p) {
        p = {
          key,
          customer_id: owned ? cust?.id || line.customer_id || null : null,
          name,
          phone: owned ? cust?.phone || phone : "",
          lines: [],
          unpaid: 0,
          urgency: "none",
        };
        byKey.set(key, p);
      }
      p.lines.push(line);
      if (isActiveBillableSaleLine(line, kind) && !line.paid) p.unpaid += 1;
    }

    const due = event?.payment_due_at;
    const list = [...byKey.values()]
      .map((p) => {
        const active = p.lines.filter((l) => isActiveBillableSaleLine(l, kind));
        const anyUnpaid = active.some((l) => !l.paid && !l.cancelled);
        return {
          ...p,
          urgency: anyUnpaid
            ? paymentUrgency(false, false, due)
            : ("ok" as const),
        };
      })
      .filter((p) => p.lines.some((l) => isActiveBillableSaleLine(l, kind)));
    list.sort((a, b) => {
      if (a.key === "__sem_cliente__") return -1;
      if (b.key === "__sem_cliente__") return 1;
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
      const byPhone = phone ? phoneToCustomer.get(phone) : undefined;
      const byId = line.customer_id
        ? customers.find((c) => c.id === line.customer_id)
        : undefined;
      const cust = byPhone || byId;
      const key = cust?.id || phone || line.id;
      if (activeKeys.has(key)) continue;
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

  const selectedActiveLines = useMemo(
    () => activeMainLines.filter((l) => selectedLineIds[l.id]),
    [activeMainLines, selectedLineIds],
  );

  function lineReadyForShip(line: EventSaleLine): boolean {
    return Boolean(line.separated && line.charged && line.paid);
  }

  function lineGarageShippable(line: EventSaleLine): boolean {
    if (!line.garage_item_id) return false;
    const g = garageById[line.garage_item_id];
    if (!g) return line.paid; // pago com caixinha; status ainda carregando
    if (g.status === "cancelled") return false;
    return Number(g.qty_with_store) > 0;
  }

  function lineAlreadyShipped(line: EventSaleLine): boolean {
    if (!line.garage_item_id) return false;
    const g = garageById[line.garage_item_id];
    if (!g) return false;
    return (
      Number(g.qty_with_store) <= 0 &&
      Number(g.qty_sent) > 0 &&
      g.status !== "cancelled"
    );
  }

  const canMarkShipped = useMemo(() => {
    if (selectedActiveLines.length === 0) return false;
    if (!selectedActiveLines.every(lineReadyForShip)) return false;
    return selectedActiveLines.some(lineGarageShippable);
  }, [selectedActiveLines, garageById]);

  const shipBlockedHint = useMemo(() => {
    if (selectedActiveLines.length === 0) {
      return "Selecione itens separados, cobrados e pagos";
    }
    if (!selectedActiveLines.every(lineReadyForShip)) {
      return "Só habilita quando todos os selecionados estiverem separados, cobrados e pagos";
    }
    if (selectedActiveLines.every(lineAlreadyShipped)) {
      return "Seleção já marcada como enviada";
    }
    if (!selectedActiveLines.some(lineGarageShippable)) {
      return "Itens ainda sem caixinha — marque pago de novo se precisar";
    }
    return "Marca a caixinha como enviada";
  }, [selectedActiveLines, garageById]);

  const allActiveSelected =
    activeMainLines.length > 0 && selectedCount === activeMainLines.length;

  const costIndex = useMemo(() => {
    const map = new Map<string, EventProductCost>();
    for (const c of productCosts) {
      const key = productMatchKey(c.product_title);
      if (key) map.set(key, c);
    }
    return map;
  }, [productCosts]);

  const firstSeenIndex = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    for (const line of lines) {
      const key = productMatchKey(line.product_title);
      if (!key || map.has(key)) continue;
      i += 1;
      map.set(key, i);
    }
    return map;
  }, [lines]);

  const ownerlessLines = useMemo(
    () =>
      lines.filter(
        (l) =>
          !l.cancelled &&
          !isShelvedSaleLine(l, event?.kind) &&
          !saleLineHasOwner({
            customer_id: l.customer_id,
            phone: l.customers?.phone,
            phone_digits: l.phone_digits,
          }),
      ),
    [lines, event?.kind],
  );

  function lineCardSortMs(line: EventSaleLine): number {
    const key = productMatchKey(line.product_title);
    const cost = key ? costIndex.get(key) : undefined;
    const fromSheet =
      cost?.sort_index ?? (key && cardOrder[key] != null ? cardOrder[key] : null);
    return cardSortMs({
      pollCreatedAt: line.poll_created_at,
      sortIndex: fromSheet ?? (key ? firstSeenIndex.get(key) : null) ?? null,
      createdAt: null,
    });
  }

  const productSummary = useMemo(() => {
    const pedidoMap = new Map(
      productStock.map((s) => [s.product_title, Boolean(s.pedido_feito)] as const),
    );
    const stockArrivedMap = new Map(
      productStock.map((s) => [s.product_title, s.qty_arrived] as const),
    );
    const map = new Map<
      string,
      {
        title: string;
        ordered: number;
        arrived: number;
        lineArrived: number;
        pedidoFeito: boolean;
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
          arrived: 0,
          lineArrived: 0,
          pedidoFeito: pedidoMap.get(title) ?? false,
          people: 0,
          lines: [],
        };
        map.set(title, row);
      }
      const q = Number(line.qty) > 0 ? Number(line.qty) : 1;
      const a = Math.max(
        0,
        Math.min(q, Number(line.qty_arrived) > 0 ? Number(line.qty_arrived) : 0),
      );
      row.ordered += q;
      row.lineArrived += a;
      row.people += 1;
      row.lines.push(line);
    }
    for (const row of map.values()) {
      // Prefere soma por cliente; se ninguém marcou ainda, usa o total antigo do produto
      const stockArrived = stockArrivedMap.get(row.title) ?? 0;
      row.arrived =
        row.lineArrived > 0 ? row.lineArrived : Math.min(row.ordered, stockArrived);
      row.lines.sort((a, b) => {
        const na =
          a.customers?.name || a.customer_name_snapshot || a.phone_digits || "";
        const nb =
          b.customers?.name || b.customer_name_snapshot || b.phone_digits || "";
        return na.localeCompare(nb, "pt-BR");
      });
    }
    return [...map.values()].sort((a, b) => {
      const aMs = Math.min(...a.lines.map((l) => lineCardSortMs(l)));
      const bMs = Math.min(...b.lines.map((l) => lineCardSortMs(l)));
      return compareByCardSort(a.title, aMs, b.title, bMs, cardSort);
    });
  }, [lines, productStock, event?.kind, cardSort, costIndex, cardOrder, firstSeenIndex]);

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
    const byCard = (a: EventSaleLine, b: EventSaleLine) =>
      compareByCardSort(
        a.product_title,
        lineCardSortMs(a),
        b.product_title,
        lineCardSortMs(b),
        cardSort,
      );
    certain.sort(byCard);
    review.sort(byCard);
    noVotes.sort(byCard);
    return { certain, review, noVotes };
  }, [lines, event?.kind, cardSort, costIndex, cardOrder, firstSeenIndex]);

  const eventResumo = useMemo(() => {
    const costRows: EncomendaCostRow[] = productCosts.map((c) => ({
      product_title: c.product_title,
      cost_jp: c.cost_jp != null ? Number(c.cost_jp) : null,
      price_sale: c.price_sale != null ? Number(c.price_sale) : null,
      price_liga: c.price_liga != null ? Number(c.price_liga) : null,
      link: c.link || "",
      sort_index: c.sort_index ?? undefined,
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
        phone_digits: l.phone_digits,
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

  const pedidoMsgs = useMemo(() => {
    if (event?.kind !== "encomenda") return { pt: "", ja: "" };
    return buildEncomendaPedidoMessages({
      eventDate: eventHappenedOn({
        name: event.name,
        opened_at: event.opened_at,
      }),
      items: productSummary.map((r) => ({ title: r.title, qty: r.ordered })),
      titleJa: cardTitleToJa,
    });
  }, [event, productSummary]);

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
    const q = participantSearch.trim();
    if (!q) return participants;
    return participants.filter((p) =>
      matchesCustomerQuery(
        {
          name: p.name,
          phone: p.phone,
          phone_digits: normalizePhoneDigits(p.phone),
        },
        q,
      ),
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
    const patch: {
      payment_due_at: string | null;
      opened_at?: string;
    } = { payment_due_at: paymentDue || null };
    if (eventHeldOn) patch.opened_at = eventHappenedAtIso(eventHeldOn);
    const { error: err } = await supabase
      .from("events")
      .update(patch)
      .eq("id", eventId);
    if (err) setError(err.message);
    else {
      setInfo("Datas do evento atualizadas.");
      await load();
    }
  }

  async function deleteEventConfirmed() {
    if (!event) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const backup = await deleteEventKeepingBackup(supabase, {
        event,
        deletedBy: meId,
      });
      await logStaffAction(supabase, {
        action: "delete_event",
        detail: `${meName} excluiu o evento “${event.name}” · backup ${backup.id} · ${lines.length} linha(s)`,
        created_by: meId,
        entity_type: "event",
        entity_id: event.id,
        event_id: null,
      });
      router.push("/eventos?apagado=1");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function onPickFile(file: File) {
    if (event?.kind === "encomenda" && /\.xlsx?$/i.test(file.name)) {
      try {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const hasResultado = wb.SheetNames.some((s) =>
          /resultado/i.test(s),
        );
        if (!hasResultado && looksLikeEncomendaCostWorkbook(wb.SheetNames)) {
          await uploadEncomendaTemplate(file);
          return;
        }
      } catch {
        // segue como planilha de resultado
      }
    }
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
      // Leilão: revisão e sem votos vêm por padrão.
      // Encomenda: revisão ❓ também (o bot grava clique sem opção lida).
      if (kind === "leilao") {
        setIncludeReview(true);
        setIncludeNoVotes(true);
      } else {
        setIncludeReview(review.length > 0);
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
    try {
      const { customer } = await ensureCustomerByPhone(supabase, {
        name: line.customer_name_snapshot || line.phone_digits,
        phoneDigits: line.phone_digits,
        source: "whatsapp_group",
      });
      return customer.id;
    } catch {
      const existing = phoneToCustomer.get(line.phone_digits);
      return existing?.id ?? null;
    }
  }

  async function insertSaleLineChunk(chunk: Record<string, unknown>[]) {
    const first = await supabase.from("event_sale_lines").insert(chunk);
    if (!first.error) return;
    if (/poll_created_at/i.test(first.error.message)) {
      const fallback = chunk.map(({ poll_created_at: _p, ...rest }) => rest);
      const retry = await supabase.from("event_sale_lines").insert(fallback);
      if (retry.error) throw retry.error;
      return;
    }
    throw first.error;
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

      // Leilão: 1 linha por enquete. Encomenda: 1 linha por (carta + cliente).
      const existingKeys = new Set(
        lines.map((l) => saleLineImportDedupeKey(l, event?.kind)),
      );

      let inserted = 0;
      let skipped = 0;
      let insertedReview = 0;
      let insertedNoVotes = 0;
      const chunk: Record<string, unknown>[] = [];

      for (const row of toImport) {
        const key = saleLineImportDedupeKey(row, event?.kind);
        if (existingKeys.has(key)) {
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
          poll_created_at: row.poll_created_at || null,
          notes:
            row.import_status === "verificar_manual"
              ? "Revisão manual (❓) — bot não definiu ganhador"
              : row.import_status === "sem_voto"
                ? "Sem votos na enquete"
                : "",
          created_by: meId,
        });
        existingKeys.add(key);
        if (row.import_status === "verificar_manual") insertedReview += 1;
        if (row.import_status === "sem_voto") insertedNoVotes += 1;
        if (chunk.length >= 80) {
          await insertSaleLineChunk(chunk);
          inserted += chunk.length;
          chunk.length = 0;
        }
      }
      if (chunk.length) {
        await insertSaleLineChunk(chunk);
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

  /** Cópia sem dono p/ multi-unidade (pessoas diferentes na mesma enquete). */
  async function duplicateSaleLine(line: EventSaleLine) {
    setBusy(true);
    setError(null);
    try {
      const price = lineUnitPrice(line);
      const { data, error: err } = await supabase
        .from("event_sale_lines")
        .insert({
          event_id: eventId,
          customer_id: null,
          phone_digits: "",
          customer_name_snapshot: "Atribuir dono",
          product_title: line.product_title,
          valor_ou_opcao: line.valor_ou_opcao || "",
          unit_price: price,
          qty: 1,
          import_status:
            line.import_status === "manual" ? "manual" : line.import_status,
          certainty: "certain",
          arremate: Boolean(line.arremate),
          poll_id: line.poll_id || "",
          notes: `Duplicado · multi-unidade · de ${line.id.slice(0, 8)}`,
          separated: false,
          charged: false,
          paid: false,
          cancelled: false,
          created_by: meId,
        })
        .select("id")
        .single();
      if (err) throw err;
      await logStaffAction(supabase, {
        action: "Duplicar item",
        detail: `Duplicou ${line.product_title} · multi-unidade · por ${meName}`,
        created_by: meId,
        entity_type: "event_sale_lines",
        entity_id: data?.id || "",
        event_id: eventId,
      });
      setInfo(
        `Cópia criada: ${line.product_title}. Atribua o dono (Trocar dono / painel sem cliente).`,
      );
      if (data?.id) {
        setReassignLineId(data.id);
        setDetachLineId(null);
        setReassignReason("Multi-unidade · segundo ganhador");
        setReassignSearch("");
        setShowReassignNew(false);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao duplicar");
    } finally {
      setBusy(false);
    }
  }

  async function duplicateSelectedLines() {
    const ids = selectedIdsFromParticipant();
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    try {
      let n = 0;
      for (const id of ids) {
        const line = lines.find((l) => l.id === id);
        if (!line || line.cancelled) continue;
        const price = lineUnitPrice(line);
        const { error: err } = await supabase.from("event_sale_lines").insert({
          event_id: eventId,
          customer_id: null,
          phone_digits: "",
          customer_name_snapshot: "Atribuir dono",
          product_title: line.product_title,
          valor_ou_opcao: line.valor_ou_opcao || "",
          unit_price: price,
          qty: 1,
          import_status:
            line.import_status === "manual" ? "manual" : line.import_status,
          certainty: "certain",
          arremate: Boolean(line.arremate),
          poll_id: line.poll_id || "",
          notes: `Duplicado · multi-unidade · de ${line.id.slice(0, 8)}`,
          separated: false,
          charged: false,
          paid: false,
          cancelled: false,
          created_by: meId,
        });
        if (err) throw err;
        n += 1;
      }
      setInfo(`Duplicados · ${n} item(ns) sem dono · atribua cada um.`);
      setSelectedLineIds({});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao duplicar");
    } finally {
      setBusy(false);
    }
  }

  async function patchLines(
    ids: string[],
    patch: Record<string, unknown>,
    label: string,
  ) {
    if (!ids.length) return;
    setError(null);
    const { data, error: err } = await supabase
      .from("event_sale_lines")
      .update(patch)
      .in("id", ids)
      .select("id");
    if (err) {
      setError(err.message);
      return;
    }
    const updated = data?.length ?? 0;
    if (updated !== ids.length) {
      setError(
        `Atualização incompleta: ${updated} de ${ids.length} item(ns). Recarregue a página e confira o estado.`,
      );
      await load();
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

  async function claimGarageItemForSaleLine(
    saleLineId: string,
    garageItemId: string,
    opts?: { deleteOrphanIfUnclaimed?: boolean },
  ): Promise<boolean> {
    const { data: claimed } = await supabase
      .from("event_sale_lines")
      .update({ garage_item_id: garageItemId })
      .eq("id", saleLineId)
      .is("garage_item_id", null)
      .select("id");
    if (!claimed?.length) {
      // Só apaga se ESTE insert acabou de criar o órfão. Nunca apagar o item
      // que já existia (unique / outra aba) — senão a caixinha vencedora some.
      if (opts?.deleteOrphanIfUnclaimed) {
        await supabase
          .from("customer_garage_items")
          .delete()
          .eq("id", garageItemId);
      }
      return false;
    }
    setLines((prev) =>
      prev.map((l) =>
        l.id === saleLineId ? { ...l, garage_item_id: garageItemId } : l,
      ),
    );
    return true;
  }

  async function markPaid(ids: string[], value: boolean) {
    if (!ids.length) return;
    if (markPaidInFlight.current) return;
    markPaidInFlight.current = true;
    setBusy(true);
    try {
      if (!value) {
        // Desfazer pago: só se a caixinha ainda estiver intacta (nada enviado).
        for (const id of ids) {
          const line = lines.find((l) => l.id === id);
          const garageId = line?.garage_item_id;
          if (!garageId) continue;
          const { data: g } = await supabase
            .from("customer_garage_items")
            .select("id, status, qty_sent, qty_delivered")
            .eq("id", garageId)
            .maybeSingle();
          if (
            g &&
            (Number(g.qty_sent) > 0 || Number(g.qty_delivered) > 0)
          ) {
            setError(
              "Não dá para desfazer pagamento: já houve envio/entrega na caixinha. Desfaça o envio na ficha do cliente antes.",
            );
            return;
          }
          if (g && g.status !== "cancelled") {
            await supabase
              .from("customer_garage_items")
              .update({
                status: "cancelled",
                cancelled_at: new Date().toISOString(),
                cancelled_by: meId,
                cancel_reason: "Pagamento desfeito",
              })
              .eq("id", garageId);
          }
          await supabase
            .from("event_sale_lines")
            .update({ garage_item_id: null })
            .eq("id", id);
        }
        await patchLines(
          ids,
          {
            paid: false,
            paid_at: null,
            paid_by: null,
          },
          "Pagamento desfeito",
        );
        return;
      }

      // Ao pagar: cria item na garagem só se a linha ainda não tiver vínculo ativo.
      const payableIds: string[] = [];
      for (const id of ids) {
        const line = lines.find((l) => l.id === id);
        if (!line || line.cancelled) continue;
        if (!line.customer_id) {
          setError(
            `Não dá para marcar pago sem cliente vinculado: ${line.product_title}`,
          );
          continue;
        }

        const { data: fresh } = await supabase
          .from("event_sale_lines")
          .select("garage_item_id, cancelled, customer_id")
          .eq("id", id)
          .maybeSingle();
        if (!fresh || fresh.cancelled || !fresh.customer_id) continue;

        if (fresh.garage_item_id) {
          const { data: existingG } = await supabase
            .from("customer_garage_items")
            .select("id, status")
            .eq("id", fresh.garage_item_id)
            .maybeSingle();
          if (existingG && existingG.status !== "cancelled") {
            payableIds.push(id);
            continue;
          }
          // Vínculo morto (cancelado/apagado): limpa e recria
          await supabase
            .from("event_sale_lines")
            .update({ garage_item_id: null })
            .eq("id", id);
        }

        const qty = Number(line.qty) > 0 ? Number(line.qty) : 1;
        const basePayload = {
          customer_id: fresh.customer_id,
          title: line.product_title,
          category: "carta",
          qty,
          qty_with_store: qty,
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
          event_date:
            eventHappenedOn({
              name: event?.name,
              opened_at: event?.opened_at,
            }) || null,
          event_id: eventId,
          unit_price: lineUnitPrice(line),
          notes: line.valor_ou_opcao || "",
          created_by: meId,
        };

        let insert = await supabase
          .from("customer_garage_items")
          .insert({ ...basePayload, event_sale_line_id: id })
          .select("id")
          .single();

        if (
          insert.error &&
          (insert.error.message.includes("event_sale_line_id") ||
            insert.error.code === "PGRST204")
        ) {
          insert = await supabase
            .from("customer_garage_items")
            .insert(basePayload)
            .select("id")
            .single();
        }

        if (insert.error?.code === "23505") {
          const { data: existing } = await supabase
            .from("customer_garage_items")
            .select("id, status")
            .eq("event_sale_line_id", id)
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
            await claimGarageItemForSaleLine(id, existing.id);
            payableIds.push(id);
          }
          continue;
        }

        if (insert.error || !insert.data) continue;
        const linked = await claimGarageItemForSaleLine(id, insert.data.id, {
          deleteOrphanIfUnclaimed: true,
        });
        if (linked) payableIds.push(id);
        else {
          // Outra aba já vinculou — ainda pode marcar pago
          const { data: again } = await supabase
            .from("event_sale_lines")
            .select("garage_item_id")
            .eq("id", id)
            .maybeSingle();
          if (again?.garage_item_id) payableIds.push(id);
        }
      }

      if (!payableIds.length) {
        setError(
          "Nenhum item pôde ser marcado como pago (falta cliente ou caixinha).",
        );
        return;
      }
      await patchLines(
        payableIds,
        {
          paid: true,
          paid_at: new Date().toISOString(),
          paid_by: meId,
          charged: true,
          charged_at: new Date().toISOString(),
          charged_by: meId,
        },
        "Pago (foi pra caixinha)",
      );
    } finally {
      markPaidInFlight.current = false;
      setBusy(false);
    }
  }

  async function markShipped(ids: string[]) {
    if (!ids.length) return;
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
    const ready = ids
      .map((id) => lines.find((l) => l.id === id))
      .filter((l): l is EventSaleLine => Boolean(l))
      .filter(
        (l) =>
          lineReadyForShip(l) &&
          lineGarageShippable(l) &&
          Boolean(l.garage_item_id),
      );
    if (!ready.length) {
      setError(
        "Nada para enviar — selecione itens separados, cobrados e pagos (ainda na caixinha).",
      );
      return;
    }

    const shippedOn = new Date().toISOString().slice(0, 10);
    const shipmentByCustomer = new Map<string, string>();

    async function shipmentForCustomer(customerId: string): Promise<string | null> {
      const cached = shipmentByCustomer.get(customerId);
      if (cached) return cached;
      const { data: existing } = await supabase
        .from("customer_shipments")
        .select("id")
        .eq("customer_id", customerId)
        .eq("shipped_on", shippedOn)
        .eq("label", "")
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        shipmentByCustomer.set(customerId, existing.id);
        return existing.id;
      }
      const { data: created, error: cErr } = await supabase
        .from("customer_shipments")
        .insert({
          customer_id: customerId,
          shipped_on: shippedOn,
          label: "",
          notes: "",
          created_by: meId,
        })
        .select("id")
        .single();
      if (cErr || !created) return null;
      shipmentByCustomer.set(customerId, created.id);
      return created.id as string;
    }

    let shipped = 0;
    for (const line of ready) {
      const garageId = line.garage_item_id!;
      const g =
        garageById[garageId] ||
        (
          await supabase
            .from("customer_garage_items")
            .select("*")
            .eq("id", garageId)
            .maybeSingle()
        ).data;
      if (!g || Number(g.qty_with_store) <= 0) continue;

      const n = Number(g.qty_with_store);
      const nextQtyStore = 0;
      const nextQtySent = Number(g.qty_sent) + n;
      let nextStatus = g.status;
      if (nextQtyStore === 0 && Number(g.qty_delivered) === 0) {
        nextStatus = "shipped";
      } else if (nextQtyStore > 0) {
        nextStatus = "in_garage";
      }

      const shipmentId = line.customer_id
        ? await shipmentForCustomer(line.customer_id)
        : null;

      const patch: Record<string, unknown> = {
        qty_with_store: nextQtyStore,
        qty_sent: nextQtySent,
        status: nextStatus,
        shipped_on: shippedOn,
      };
      if (shipmentId) patch.shipment_id = shipmentId;

      const { error: err } = await supabase
        .from("customer_garage_items")
        .update(patch)
        .eq("id", garageId);
      if (err) {
        setError(
          err.message.includes("shipment") || err.message.includes("shipped_on")
            ? "Rode a migration migration_customer_shipments.sql no Supabase."
            : err.message,
        );
        return;
      }
      shipped += 1;
      await logStaffAction(supabase, {
        action: "send",
        detail: `${line.product_title}: ${n} enviado(s) pelo evento ${event?.name || eventId} · por ${meName}`,
        created_by: meId,
        entity_type: "customer_garage_items",
        entity_id: garageId,
        event_id: eventId,
        customer_id: line.customer_id,
      });
    }

    if (!shipped) {
      setError("Nenhum item pôde ser marcado como enviado.");
      return;
    }
    setInfo(
      `Marcado como enviado · ${shipped} item(ns) · ${meName}. Pacote do dia na ficha → Enviados.`,
    );
    setSelectedLineIds({});
    await load();
    } finally {
      setBusy(false);
    }
  }

  async function cancelLines(ids: string[], reasonText?: string) {
    if (!ids.length) return;
    const reason =
      reasonText ??
      window.prompt(
        "Motivo do cancelamento (obrigatório): cliente não pagou, desistiu, etc.",
      );
    if (reason == null) return;
    if (!reason.trim()) {
      setError("Informe o motivo do cancelamento.");
      return;
    }
    setBusy(true);
    try {
      const { data: freshLines } = await supabase
        .from("event_sale_lines")
        .select("id, garage_item_id")
        .in("id", ids);
      for (const row of freshLines || []) {
        if (!row.garage_item_id) continue;
        await supabase
          .from("customer_garage_items")
          .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
            cancelled_by: meId,
            cancel_reason: reason.trim(),
          })
          .eq("id", row.garage_item_id);
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
    } finally {
      setBusy(false);
    }
  }

  function openOrphanDelete(ids: string[]) {
    if (!ids.length) return;
    setOrphanDeleteIds(ids);
    setOrphanDeleteReason("");
    setOrphanDeleteOpen(true);
    setError(null);
  }

  async function confirmOrphanDelete() {
    const reason = orphanDeleteReason.trim();
    if (reason.length < 3) {
      setError("Escreva o motivo na caixa de observação (obrigatório).");
      return;
    }
    await cancelLines(orphanDeleteIds, reason);
    setOrphanDeleteOpen(false);
    setOrphanDeleteReason("");
    setOrphanDeleteIds([]);
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
    const line = lines.find((l) => l.id === lineId);
    const prevArrived = Math.max(0, Number(line?.qty_arrived) || 0);
    const nextArrived = Math.min(prevArrived, n);
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({ qty: n, qty_arrived: nextArrived })
      .eq("id", lineId);
    if (err) {
      setError(
        err.message.includes("qty_arrived")
          ? `${err.message} — rode supabase/migration_encomenda_line_arrived.sql`
          : err.message,
      );
      return;
    }
    if (line?.product_title) {
      await syncProductArrivedFromLines(line.product_title);
    }
    // Se já está na caixinha e ainda não saiu, alinha a quantidade
    if (line?.garage_item_id) {
      const g =
        garageById[line.garage_item_id] ||
        (
          await supabase
            .from("customer_garage_items")
            .select("id, status, qty_sent, qty_delivered")
            .eq("id", line.garage_item_id)
            .maybeSingle()
        ).data;
      if (
        g &&
        g.status !== "cancelled" &&
        Number(g.qty_sent) === 0 &&
        Number(g.qty_delivered) === 0
      ) {
        const { error: gErr } = await supabase
          .from("customer_garage_items")
          .update({ qty: n, qty_with_store: n })
          .eq("id", g.id);
        if (gErr) {
          setError(
            `Qtd da linha atualizada, mas a caixinha não acompanhou: ${gErr.message}`,
          );
        }
      }
    }
    await load();
  }

  async function syncProductArrivedFromLines(title: string) {
    const kind = event?.kind;
    const related = lines.filter(
      (l) =>
        l.product_title === title &&
        !l.cancelled &&
        !isShelvedSaleLine(l, kind),
    );
    // Relê do banco para não usar estado stale após updates
    const { data: fresh } = await supabase
      .from("event_sale_lines")
      .select("id, qty, qty_arrived, cancelled, archived, valor_ou_opcao")
      .eq("event_id", eventId)
      .eq("product_title", title)
      .eq("cancelled", false);
    const rows = (fresh || []).filter(
      (l) => !isShelvedSaleLine(l, kind),
    );
    const total = rows.reduce((sum, l) => {
      const q = Number(l.qty) > 0 ? Number(l.qty) : 1;
      const a = Math.max(0, Math.min(q, Number(l.qty_arrived) || 0));
      return sum + a;
    }, 0);
    const current = productStock.find((s) => s.product_title === title);
    await supabase.from("event_product_stock").upsert(
      {
        event_id: eventId,
        product_title: title,
        qty_arrived: total,
        pedido_feito: current?.pedido_feito ?? false,
        pedido_feito_at: current?.pedido_feito_at ?? null,
        pedido_feito_by: current?.pedido_feito_by ?? null,
        updated_at: new Date().toISOString(),
        updated_by: meId,
      },
      { onConflict: "event_id,product_title" },
    );
    void related;
  }

  async function setLineArrived(lineId: string, qtyArrived: number) {
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    const q = Number(line.qty) > 0 ? Number(line.qty) : 1;
    const n = Math.max(0, Math.min(q, Math.floor(qtyArrived) || 0));
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("event_sale_lines")
      .update({ qty_arrived: n })
      .eq("id", lineId);
    if (err) {
      setBusy(false);
      setError(
        err.message.includes("qty_arrived")
          ? `${err.message} — rode supabase/migration_encomenda_line_arrived.sql`
          : err.message,
      );
      return;
    }
    await syncProductArrivedFromLines(line.product_title);
    setBusy(false);
    setInfo(
      n >= q
        ? `Chegou · ${line.product_title} (${n}/${q})`
        : n > 0
          ? `Chegada parcial · ${line.product_title} (${n}/${q})`
          : `Chegada desmarcada · ${line.product_title}`,
    );
    await load();
  }

  function productSalePrice(
    title: string,
    siblingLines: EventSaleLine[],
  ): number | null {
    for (const l of siblingLines) {
      const p = lineUnitPrice(l);
      if (p != null) return p;
    }
    const fromTitle = parseMoneyFromOption(title);
    if (fromTitle != null) return fromTitle;
    const cost = productCosts.find((c) => c.product_title === title);
    if (cost?.price_sale != null && Number.isFinite(Number(cost.price_sale))) {
      return Number(cost.price_sale);
    }
    return null;
  }

  async function withScrollKeep(fn: () => Promise<void>) {
    const y = typeof window !== "undefined" ? window.scrollY : 0;
    await fn();
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => window.scrollTo({ top: y }));
    }
  }

  async function removeVoteFromProduct(lineId: string) {
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    if (line.paid || line.garage_item_id) {
      setError(
        "Esse pedido já está pago ou na caixinha — não dá para excluir por aqui.",
      );
      return;
    }
    await withScrollKeep(async () => {
      await patchLines(
        [lineId],
        {
          cancelled: true,
          cancel_reason: "Removido da carta (correção de voto)",
          cancelled_at: new Date().toISOString(),
          cancelled_by: meId,
        },
        "Removido da carta",
      );
    });
  }

  async function addCustomerToProduct(
    productTitle: string,
    customer: Pick<Customer, "id" | "name" | "phone" | "phone_digits">,
    qty: number,
  ) {
    const n = Math.max(1, Math.floor(qty) || 1);
    const productLines = lines.filter(
      (l) =>
        l.product_title === productTitle &&
        !l.cancelled &&
        !isShelvedSaleLine(l, event?.kind),
    );
    if (findCustomerOnProduct(productLines, customer)) {
      setError(
        "Esse número já está nesta carta. Ajuste a quantidade na linha, ou exclua se foi engano.",
      );
      return;
    }

    const siblings = lines.filter(
      (l) => l.product_title === productTitle && !l.cancelled,
    );
    const phone =
      customer.phone_digits || normalizePhoneDigits(customer.phone || "");
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("event_sale_lines")
      .insert({
        event_id: eventId,
        customer_id: customer.id,
        phone_digits: phone,
        customer_name_snapshot: customer.name || phone,
        product_title: productTitle,
        valor_ou_opcao: "Eu quero",
        unit_price: productSalePrice(productTitle, siblings),
        qty: n,
        import_status: "voto",
        certainty: "certain",
        arremate: false,
        poll_id: siblings[0]?.poll_id || "",
        notes: "Voto corrigido na mão — planilha não leu",
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
      action: "corrigir_voto",
      detail: `Voto corrigido · ${productTitle} → ${customer.name || phone} ×${n} · ${meName}`,
      created_by: meId,
      entity_type: "event_sale_line",
      entity_id: data?.id || "",
      customer_id: customer.id,
      event_id: eventId,
    });
    setAddVoteSearchByTitle((s) => ({ ...s, [productTitle]: "" }));
    setAddVoteQtyByTitle((s) => ({ ...s, [productTitle]: 1 }));
    setAddVoteShowNewFor(null);
    setAddVoteNewName("");
    setAddVoteNewPhone("");
    setInfo(`Cliente adicionado em ${productTitle}.`);
    await withScrollKeep(() => load());
  }

  async function createCustomerAndAddToProduct(productTitle: string) {
    const phone = normalizePhoneDigits(addVoteNewPhone);
    const name = addVoteNewName.trim() || phone;
    if (!phone || phone.length < 10) {
      setError("Informe um telefone válido (10–15 dígitos).");
      return;
    }
    const productLines = lines.filter(
      (l) =>
        l.product_title === productTitle &&
        !l.cancelled &&
        !isShelvedSaleLine(l, event?.kind),
    );
    if (
      findCustomerOnProduct(productLines, {
        phone,
        phone_digits: phone,
      })
    ) {
      setError(
        "Esse número já está nesta carta. Ajuste a quantidade na linha, ou exclua se foi engano.",
      );
      return;
    }
    const qty = Math.max(1, Number(addVoteQtyByTitle[productTitle]) || 1);
    setBusy(true);
    setError(null);
    try {
      const { customer, created, renamed } = await ensureCustomerByPhone(
        supabase,
        { name, phoneDigits: phone },
      );
      setCustomers((prev) => {
        if (prev.some((c) => c.id === customer.id)) {
          return prev.map((c) => (c.id === customer.id ? { ...c, ...customer } : c));
        }
        return [...prev, customer];
      });
      if (!created && !renamed) {
        setInfo(
          `Telefone já cadastrado como ${customer.name}. Adicionando na carta.`,
        );
      } else if (renamed) {
        setInfo(`Nome atualizado para ${customer.name}.`);
      }
      setAddVoteNewName("");
      setAddVoteNewPhone("");
      setAddVoteShowNewFor(null);
      await addCustomerToProduct(productTitle, customer, qty);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
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
      eventDate: eventHappenedOn({
        name: event.name,
        opened_at: event.opened_at,
      }),
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

  async function copyPedidoMsg(which: "pt" | "ja") {
    const text = which === "pt" ? pedidoMsgs.pt : pedidoMsgs.ja;
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setInfo(
        which === "pt"
          ? "Mensagem do pedido em português copiada."
          : "Mensagem do pedido em japonês copiada.",
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
    const orphan = !saleLineHasOwner({
      customer_id: line.customer_id,
      phone: line.customers?.phone,
      phone_digits: line.phone_digits,
    });
    if (!orphan && !allowed.includes(bucket as "review" | "no_votes")) {
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
      const name = file.name.toLowerCase();
      let rows: EncomendaCostRow[] = [];
      let sheetNote = "";
      if (name.endsWith(".csv") || name.endsWith(".txt")) {
        rows = parseEncomendaTemplateCsv(await file.text());
      } else {
        const day = eventHappenedOn({
          name: event?.name,
          opened_at: event?.opened_at,
        });
        const parsed = await parseEncomendaXlsx(file, day);
        rows = parsed.rows;
        sheetNote = parsed.sheetUsed
          ? ` aba “${parsed.sheetUsed}”`
          : "";
      }
      if (!rows.length) {
        setError(
          "Planilha sem cartas válidas. Use encomendas.xlsx (abas tipo Encomendas - 2608) ou o CSV com coluna Carta.",
        );
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
        sort_index: r.sort_index ?? null,
      }));
      let { error: err } = await supabase
        .from("event_product_costs")
        .insert(payload);
      let missingSortCol = false;
      if (err && /sort_index/i.test(err.message)) {
        missingSortCol = true;
        const fallback = payload.map(({ sort_index: _s, ...rest }) => rest);
        const retry = await supabase.from("event_product_costs").insert(fallback);
        err = retry.error;
      }
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
        detail: `Custos encomenda · ${rows.length} carta(s)${sheetNote} · ${meName}`,
        created_by: meId,
        entity_type: "event",
        entity_id: eventId,
        event_id: eventId,
      });
      const order = orderMapFromTitles(rows.map((r) => r.product_title));
      setCardOrder(order);
      await supabase
        .from("events")
        .update({ notes: embedCardOrder(event?.notes, order) })
        .eq("id", eventId);
      setInfo(
        missingSortCol
          ? `Custos importados: ${rows.length} carta(s)${sheetNote}. Rode supabase/migration_event_money_sort.sql para guardar a ordem da aba.`
          : `Custos importados: ${rows.length} carta(s)${sheetNote}.`,
      );
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
    if (reviewReason.trim().length < 3) {
      setError("Informe o motivo da associação (obrigatório).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { customer, created, renamed } = await ensureCustomerByPhone(
        supabase,
        { name, phoneDigits: phone },
      );
      setCustomers((prev) => {
        if (prev.some((c) => c.id === customer.id)) {
          return prev.map((c) => (c.id === customer.id ? { ...c, ...customer } : c));
        }
        return [...prev, customer];
      });
      if (!created && !renamed) {
        setInfo(
          `Telefone já cadastrado como ${customer.name}. Associando nesta carta.`,
        );
      } else if (renamed) {
        setInfo(`Nome atualizado para ${customer.name}.`);
      }
      setNewReviewName("");
      setNewReviewPhone("");
      setShowNewReview(false);
      await assignReviewToCustomer(lineId, customer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
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
            ? event?.kind === "encomenda"
              ? "voto"
              : "arrematado"
            : line.import_status ||
              (event?.kind === "encomenda" ? "voto" : "arrematado"),
        certainty: "certain",
      })
      .eq("id", lineId)
      .eq("event_id", eventId);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    const wasOrphan = !saleLineHasOwner({
      customer_id: line.customer_id,
      phone: line.customers?.phone,
      phone_digits: line.phone_digits,
    });
    await logStaffAction(supabase, {
      action: wasOrphan ? "owner_assign" : "change_owner",
      detail: wasOrphan
        ? `Associar dono · ${line.product_title} → ${customer.name || phone} · motivo: ${motivo} · ${meName}`
        : `Troca de dono · ${line.product_title} · de ${prevWho} → ${customer.name || phone} · motivo: ${motivo} · ${meName}`,
      created_by: meId,
      entity_type: "event_sale_line",
      entity_id: lineId,
      customer_id: customer.id,
      event_id: eventId,
    });
    setInfo(
      wasOrphan
        ? `Associado: ${line.product_title} → ${customer.name || phone}`
        : `Dono alterado: ${line.product_title} → ${customer.name || phone}`,
    );
    setReassignLineId(null);
    setReassignReason("");
    setReassignSearch("");
    setShowReassignNew(false);
    if (customer.id) setSelectedParticipant(customer.id);
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
    setBusy(true);
    setError(null);
    try {
      const { customer, created, renamed } = await ensureCustomerByPhone(
        supabase,
        { name, phoneDigits: phone },
      );
      setCustomers((prev) => {
        if (prev.some((c) => c.id === customer.id)) {
          return prev.map((c) => (c.id === customer.id ? { ...c, ...customer } : c));
        }
        return [...prev, customer];
      });
      if (!created && !renamed) {
        setInfo(
          `Telefone já cadastrado como ${customer.name}. Trocando dono para esse cadastro.`,
        );
      } else if (renamed) {
        setInfo(`Nome atualizado para ${customer.name}.`);
      }
      setReassignNewName("");
      setReassignNewPhone("");
      setShowReassignNew(false);
      await changeLineOwner(lineId, customer, reassignReason);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function createCustomerAndAssignOrphan(lineId: string) {
    const phone = normalizePhoneDigits(orphanNewPhone);
    const name = orphanNewName.trim() || phone;
    if (!phone || phone.length < 10) {
      setError("Informe um telefone válido (10–15 dígitos).");
      return;
    }
    if (controlReason.trim().length < 3) {
      setError("Informe o motivo da associação (obrigatório).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { customer, created, renamed } = await ensureCustomerByPhone(
        supabase,
        { name, phoneDigits: phone },
      );
      setCustomers((prev) => {
        if (prev.some((c) => c.id === customer.id)) {
          return prev.map((c) => (c.id === customer.id ? { ...c, ...customer } : c));
        }
        return [...prev, customer];
      });
      if (!created && !renamed) {
        setInfo(
          `Telefone já cadastrado como ${customer.name}. Associando nesta carta.`,
        );
      } else if (renamed) {
        setInfo(`Nome atualizado para ${customer.name}.`);
      }
      setOrphanNewName("");
      setOrphanNewPhone("");
      setShowOrphanNew(false);
      await assignOwnerControlled(lineId, customer, controlReason, ["no_votes"]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function setPedidoFeito(title: string, value: boolean) {
    const current = productStock.find((s) => s.product_title === title);
    const { error: err } = await supabase.from("event_product_stock").upsert(
      {
        event_id: eventId,
        product_title: title,
        qty_arrived: current?.qty_arrived ?? 0,
        pedido_feito: value,
        pedido_feito_at: value ? new Date().toISOString() : null,
        pedido_feito_by: value ? meId : null,
        updated_at: new Date().toISOString(),
        updated_by: meId,
      },
      { onConflict: "event_id,product_title" },
    );
    if (err) {
      setError(
        err.message.includes("pedido_feito")
          ? `${err.message} — rode supabase/migration_encomenda_pedido_feito.sql`
          : err.message,
      );
    } else {
      setInfo(
        value
          ? `Pedido JP marcado: ${title}`
          : `Pedido JP desmarcado: ${title}`,
      );
      await load();
    }
  }

  async function markProductFullyArrived(title: string, _ordered: number) {
    const kind = event?.kind;
    const targets = lines.filter(
      (l) =>
        l.product_title === title &&
        !l.cancelled &&
        !isShelvedSaleLine(l, kind),
    );
    if (!targets.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const line of targets) {
        const q = Number(line.qty) > 0 ? Number(line.qty) : 1;
        const { error: err } = await supabase
          .from("event_sale_lines")
          .update({ qty_arrived: q })
          .eq("id", line.id);
        if (err) throw err;
      }
      await syncProductArrivedFromLines(title);
      setInfo(`Chegaram todas · ${title}`);
      await load();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.includes("qty_arrived")
            ? `${e.message} — rode supabase/migration_encomenda_line_arrived.sql`
            : e.message
          : "Falha ao marcar chegada",
      );
    } finally {
      setBusy(false);
    }
  }

  async function markAllProductsFullyArrived() {
    if (!productSummary.length) return;
    setBusy(true);
    setError(null);
    try {
      const kind = event?.kind;
      const targets = lines.filter(
        (l) => !l.cancelled && !isShelvedSaleLine(l, kind),
      );
      for (const line of targets) {
        const q = Number(line.qty) > 0 ? Number(line.qty) : 1;
        const { error: err } = await supabase
          .from("event_sale_lines")
          .update({ qty_arrived: q })
          .eq("id", line.id);
        if (err) throw err;
      }
      const titles = [...new Set(targets.map((l) => l.product_title))];
      for (const title of titles) {
        await syncProductArrivedFromLines(title);
      }
      setInfo(`Chegou tudo da rodada · ${titles.length} produto(s)`);
      await load();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.includes("qty_arrived")
            ? `${e.message} — rode supabase/migration_encomenda_line_arrived.sql`
            : e.message
          : "Falha ao marcar chegada",
      );
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
            <button
              type="button"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
              onClick={() => {
                setDeleteError(null);
                setShowDeleteConfirm(true);
              }}
            >
              Excluir evento
            </button>
          </div>
        }
      />
      <TypeToConfirmDialog
        open={showDeleteConfirm}
        title="Excluir este evento?"
        warning={`Isso apaga a rodada “${event.name}” da operação (cartas, cobranças e estoque do evento).\n\nA caixinha dos clientes permanece. Antes de apagar, um backup permanente da rodada é gravado — esse backup não pode ser excluído e dá para restaurar depois em Eventos.`}
        confirmLabel="Excluir evento"
        busy={deleteBusy}
        error={deleteError}
        onCancel={() => {
          if (!deleteBusy) setShowDeleteConfirm(false);
        }}
        onConfirm={() => void deleteEventConfirmed()}
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

      <div className="panel mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Badge tone={event.status === "open" ? "good" : "neutral"}>
            {EVENT_STATUS_LABEL[event.status]}
          </Badge>
        </div>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">
            Data do evento (dia do leilão/encomenda)
          </span>
          <input
            className="field"
            type="date"
            value={eventHeldOn}
            onChange={(e) => setEventHeldOn(e.target.value)}
          />
        </label>
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
            className="btn-secondary"
            disabled={lines.length === 0}
            onClick={() => downloadCorrectedCsv()}
          >
            Baixar CSV corrigido
          </button>
          {event.kind === "encomenda" ? (
            <label className="btn-secondary cursor-pointer">
              Encomendas.xlsx / CSV
              <input
                type="file"
                accept=".xlsx,.xls,.csv,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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

      <div
        className={`grid gap-4 mb-6 ${event.kind === "encomenda" ? "lg:grid-cols-2" : ""}`}
      >
      <div
        className={`panel space-y-3 ${importDragging ? "ring-2 ring-zinc-900 ring-offset-2" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          if ([...e.dataTransfer.types].includes("Files")) setImportDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setImportDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setImportDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (!f || busy) return;
          const name = f.name.toLowerCase();
          if (event.kind === "encomenda" && name.endsWith(".csv")) {
            void uploadEncomendaTemplate(f);
            return;
          }
          setShowImport(true);
          void onPickFile(f);
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Importar planilha do bot
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Arraste o arquivo pra esta área ou escolha no botão. Aceita{" "}
              <strong>.xlsx</strong> / <strong>.xls</strong> do{" "}
              <code className="rounded bg-zinc-100 px-1">!planilha</code>
              {event.kind === "encomenda" ? (
                <> (encomenda) e CSV de template JP/venda.</>
              ) : (
                <> (leilão / resultado).</>
              )}
            </p>
          </div>
          {!showImport ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowImport(true)}
            >
              Abrir importação
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowImport(false)}
            >
              Recolher
            </button>
          )}
        </div>

        {showImport || importDragging ? (
          <div className="space-y-3">
            <FileDropZone
              accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              disabled={busy}
              title={
                importDragging ? "Solte pra importar" : "Solte a planilha aqui"
              }
              hint={
                event.kind === "encomenda"
                  ? "Resultado do bot (.xlsx) ou template de custos (.csv)."
                  : "Arquivo Resultado do bot (.xlsx / .xls / .csv)."
              }
              onFile={async (f) => {
                const name = f.name.toLowerCase();
                if (event.kind === "encomenda" && name.endsWith(".csv")) {
                  await uploadEncomendaTemplate(f);
                  return;
                }
                await onPickFile(f);
              }}
            />
            <p className="text-sm text-zinc-600">
              {event.kind === "encomenda" ? (
                <>
                  Em <strong>encomenda</strong> entram votos em{" "}
                  <strong>Eu quero…</strong> e linhas de <strong>revisão ❓</strong>{" "}
                  (clique que o bot não leu). A opção 💙 é ignorada. Vários
                  clientes na mesma carta entram normalmente. Reimportar só
                  adiciona quem ainda faltava.
                </>
              ) : event.kind === "leilao" ? (
                <>
                  Em <strong>leilão</strong> entram os 3 blocos: dono certo,
                  revisão ❓ e sem votos.
                </>
              ) : (
                <>Importe a aba Resultado do bot.</>
              )}
            </p>
            {event.kind === "leilao" ? (
              <p className="text-sm text-emerald-800">
                Neste leilão a importação <strong>sempre</strong> inclui os 3
                blocos. Se reimportar a mesma planilha, só entram cartas que
                ainda faltam.
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
                    <ul className="mt-1 max-h-32 overflow-y-auto overscroll-contain text-xs text-emerald-900/80">
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
                    <ul className="mt-1 max-h-32 overflow-y-auto overscroll-contain text-xs text-amber-900/80">
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
                    <ul className="mt-1 max-h-32 overflow-y-auto overscroll-contain text-xs text-zinc-600">
                      {importPreview.noVotes.slice(0, 40).map((l, i) => (
                        <li key={`n-${i}`}>{l.product_title}</li>
                      ))}
                      {importPreview.noVotes.length > 40 ? (
                        <li>… +{importPreview.noVotes.length - 40}</li>
                      ) : null}
                    </ul>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => void confirmImport()}
                >
                  Confirmar importação
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">
            Dica: dá pra arrastar o arquivo direto em cima deste bloco, sem
            abrir nada.
          </p>
        )}
      </div>

      {event.kind === "encomenda" ? (
        <div className="panel space-y-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Planilha Encomendas.xlsx
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              O mesmo arquivo do lote automático. Cruza <strong>nome da carta +
              data da aba</strong> (ex.: Encomendas - 2608) com esta rodada para
              custo JP, venda e lucro.
            </p>
          </div>
          <FileDropZone
            accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            disabled={busy}
            title="Solte o encomendas.xlsx aqui"
            hint="Abas tipo Encomendas - 2608. Também aceita o CSV antigo (Carta / ValorJP / venda)."
            onFile={async (f) => {
              await uploadEncomendaTemplate(f);
            }}
          />
          {productCosts.length > 0 ? (
            <p className="text-sm text-zinc-600">
              Custos carregados: <strong>{productCosts.length}</strong> carta(s).
            </p>
          ) : null}
        </div>
      ) : null}
      </div>

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
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={cardSort === "enquete" ? "btn-primary text-xs" : "btn-secondary text-xs"}
                onClick={() => setCardSort("enquete")}
              >
                Ordem da enquete
              </button>
              <button
                type="button"
                className={cardSort === "nome" ? "btn-primary text-xs" : "btn-secondary text-xs"}
                onClick={() => setCardSort("nome")}
              >
                A–Z
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => void healLeilaoStatuses()}
              >
                Corrigir status legado (lance sem dono → sem votos)
              </button>
            </div>
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
                          <button
                            type="button"
                            className="text-xs font-medium text-sky-800 underline"
                            disabled={busy}
                            title="Cria outra unidade sem dono (multi-unidade / pessoas diferentes)"
                            onClick={() => void duplicateSaleLine(l)}
                          >
                            Duplicar
                          </button>
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
                                    .map((p) => {
                                      if (!p.customer_id) return null;
                                      const existing = customers.find(
                                        (c) => c.id === p.customer_id,
                                      );
                                      if (existing) return existing;
                                      return {
                                        id: p.customer_id,
                                        name: p.name,
                                        phone: p.phone,
                                        phone_digits: normalizePhoneDigits(
                                          p.phone,
                                        ),
                                        notes: "",
                                        created_at: "",
                                      } as Customer;
                                    })
                                    .filter(Boolean)
                                : customers
                              )
                                .filter((c): c is Customer => {
                                  if (!c || c.id === l.customer_id) return false;
                                  return matchesCustomerQuery(
                                    c,
                                    reassignSearch,
                                  );
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
                                <p className="text-[11px] text-zinc-500">
                                  Precisa de nome + WhatsApp. Se o número já
                                  existir, usa o cadastro antigo (e atualiza o
                                  nome se ainda for só o telefone).
                                </p>
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
                      const existing = customers.find(
                        (x) => x.id === p.customer_id,
                      );
                      if (existing) return existing;
                      return {
                        id: p.customer_id,
                        name: p.name,
                        phone: p.phone,
                        phone_digits: normalizePhoneDigits(p.phone),
                        notes: "",
                        created_at: "",
                      } as Customer;
                    })
                    .filter(Boolean) as Customer[];
                  const pool =
                    reviewScope === "event" ? eventCustomers : customers;
                  const filtered = pool
                    .filter((c) => matchesCustomerQuery(c, q))
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
                          setShowOrphanNew(false);
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
                  const fromParticipants = participants
                    .filter((p) => p.customer_id)
                    .map((p) => {
                      const existing = customers.find(
                        (c) => c.id === p.customer_id,
                      );
                      if (existing) return existing;
                      return {
                        id: p.customer_id!,
                        name: p.name,
                        phone: p.phone,
                        phone_digits: normalizePhoneDigits(p.phone),
                        notes: "",
                        created_at: "",
                      } as Customer;
                    });
                  const poolMap = new Map<string, Customer>();
                  for (const c of [...fromParticipants, ...customers]) {
                    poolMap.set(c.id, c);
                  }
                  const filtered = [...poolMap.values()]
                    .filter((c) => matchesCustomerQuery(c, q))
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
                        placeholder="Buscar cliente (nome ou WhatsApp)…"
                        value={orphanSearch}
                        onChange={(e) => setOrphanSearch(e.target.value)}
                      />
                      {!orphanSearch.trim() ? (
                        <p className="text-[11px] text-zinc-500">
                          Digite nome ou telefone — lista inclui participantes
                          deste leilão e o cadastro completo.
                        </p>
                      ) : null}
                      <ul className="max-h-36 space-y-1 overflow-y-auto">
                        {filtered.length === 0 ? (
                          <li className="px-2 py-1 text-xs text-zinc-500">
                            Nenhum cliente encontrado com esse filtro.
                          </li>
                        ) : null}
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
                      {!showOrphanNew ? (
                        <button
                          type="button"
                          className="btn-secondary w-full text-xs"
                          onClick={() => setShowOrphanNew(true)}
                        >
                          Cadastrar cliente novo e associar
                        </button>
                      ) : (
                        <div className="space-y-1 rounded-md border border-zinc-200 bg-zinc-50 p-2">
                          <input
                            className="field text-sm"
                            placeholder="Nome"
                            value={orphanNewName}
                            onChange={(e) => setOrphanNewName(e.target.value)}
                          />
                          <input
                            className="field text-sm"
                            placeholder="Telefone / WhatsApp (obrigatório)"
                            value={orphanNewPhone}
                            onChange={(e) => setOrphanNewPhone(e.target.value)}
                          />
                          <button
                            type="button"
                            className="btn-primary w-full text-xs"
                            disabled={busy}
                            onClick={() =>
                              void createCustomerAndAssignOrphan(line.id)
                            }
                          >
                            Criar e associar
                          </button>
                        </div>
                      )}
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
                retrátil e não entram neste resumo. A ordem da enquete segue a
                aba do encomendas.xlsx (a mesma do lote). Sem o arquivo, A–Z e
                enquete ficam iguais.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={cardSort === "enquete" ? "btn-primary text-xs" : "btn-secondary text-xs"}
                onClick={() => setCardSort("enquete")}
              >
                Ordem da enquete
              </button>
              <button
                type="button"
                className={cardSort === "nome" ? "btn-primary text-xs" : "btn-secondary text-xs"}
                onClick={() => setCardSort("nome")}
              >
                A–Z
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => void markAllProductsFullyArrived()}
              >
                Chegou tudo desta rodada
              </button>
            </div>
          </div>
          <ul className="space-y-3">
            {productSummary.map((row) => {
              const falta = Math.max(0, row.ordered - row.arrived);
              const open = Boolean(openProductTitles[row.title]);
              const voteSearch = addVoteSearchByTitle[row.title] || "";
              const voteQty = Math.max(1, Number(addVoteQtyByTitle[row.title]) || 1);
              const alreadyIds = new Set(
                row.lines
                  .map((l) => l.customer_id)
                  .filter((id): id is string => Boolean(id)),
              );
              const alreadyPhones = new Set(
                row.lines.map((l) => saleLinePhone(l)).filter(Boolean),
              );
              const isAlreadyOnCard = (c: Customer) =>
                alreadyIds.has(c.id) ||
                alreadyPhones.has(customerPhoneDigits(c));
              const q = voteSearch.trim();
              const eventCustomers = participants
                .map((p) => {
                  if (!p.customer_id) return null;
                  const existing = customers.find((x) => x.id === p.customer_id);
                  if (existing) return existing;
                  return {
                    id: p.customer_id,
                    name: p.name,
                    phone: p.phone,
                    phone_digits: normalizePhoneDigits(p.phone),
                    notes: "",
                    created_at: "",
                  } as Customer;
                })
                .filter(Boolean) as Customer[];
              const pool = q ? customers : eventCustomers;
              const filtered = pool
                .filter((c) => {
                  const already = isAlreadyOnCard(c);
                  if (already && !q) return false;
                  return matchesCustomerQuery(c, q);
                })
                .slice(0, 30);
              return (
                <li
                  key={row.title}
                  className="rounded-lg border border-zinc-200 bg-white"
                >
                  <div className="flex flex-wrap items-start gap-3 px-3 py-3">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() =>
                        setOpenProductTitles((s) => ({
                          ...s,
                          [row.title]: !s[row.title],
                        }))
                      }
                    >
                      <span className="mr-2 text-zinc-400">{open ? "▾" : "▸"}</span>
                      <span className="font-medium text-zinc-900">{row.title}</span>
                      <span className="mt-0.5 block pl-5 text-xs text-zinc-500">
                        {open
                          ? "ocultar quem pediu · outras cartas continuam abertas"
                          : "ver clientes e ajustar qtd"}
                      </span>
                    </button>
                    <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-700">
                      <label className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700">
                        <input
                          type="checkbox"
                          checked={row.pedidoFeito}
                          disabled={busy}
                          onChange={(e) =>
                            void setPedidoFeito(row.title, e.target.checked)
                          }
                        />
                        Pedido feito
                      </label>
                      <span>
                        <span className="text-zinc-500">Pedidos</span> {row.people}
                      </span>
                      <span>
                        <span className="text-zinc-500">Un.</span> {row.ordered}
                      </span>
                      <span>
                        <span className="text-zinc-500">Chegou</span>{" "}
                        {row.arrived}/{row.ordered}
                      </span>
                      {falta > 0 ? (
                        <Badge tone="warn">falta {falta}</Badge>
                      ) : (
                        <Badge tone="good">ok</Badge>
                      )}
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
                    </div>
                  </div>
                  {open ? (
                    <div className="space-y-3 border-t border-zinc-100 bg-zinc-50 px-3 py-3">
                      <ul className="space-y-2">
                        {row.lines.map((line) => {
                          const who =
                            line.customers?.name ||
                            line.customer_name_snapshot ||
                            line.phone_digits ||
                            "Sem cliente";
                          const phone =
                            line.customers?.phone || line.phone_digits || "";
                          const canRemove = !line.paid && !line.garage_item_id;
                          const lineQty =
                            Number(line.qty) > 0 ? Number(line.qty) : 1;
                          const lineArrived = Math.max(
                            0,
                            Math.min(
                              lineQty,
                              Number(line.qty_arrived) || 0,
                            ),
                          );
                          const lineOk = lineArrived >= lineQty;
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
                                    {phone && who !== phone ? ` (${phone})` : ""}
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
                                  {" · "}
                                  {lineOk
                                    ? "chegou"
                                    : lineArrived > 0
                                      ? `parcial ${lineArrived}/${lineQty}`
                                      : "ainda não chegou"}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-3">
                                <label className="flex items-center gap-2 text-xs text-zinc-600">
                                  Qtd
                                  <input
                                    className="field w-16 px-2 py-1"
                                    type="number"
                                    min={1}
                                    defaultValue={lineQty}
                                    key={`${line.id}-sum-${line.qty}`}
                                    onBlur={(e) => {
                                      const v = Number(e.target.value);
                                      if (v !== lineQty) {
                                        void withScrollKeep(() =>
                                          updateLineQty(line.id, v),
                                        );
                                      }
                                    }}
                                  />
                                </label>
                                {lineQty === 1 ? (
                                  <label className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700">
                                    <input
                                      type="checkbox"
                                      checked={lineOk}
                                      disabled={busy}
                                      onChange={(e) =>
                                        void withScrollKeep(() =>
                                          setLineArrived(
                                            line.id,
                                            e.target.checked ? 1 : 0,
                                          ),
                                        )
                                      }
                                    />
                                    Chegou
                                  </label>
                                ) : (
                                  <label className="flex items-center gap-1 text-xs text-zinc-600">
                                    Chegou
                                    <input
                                      className="field w-16 px-2 py-1"
                                      type="number"
                                      min={0}
                                      max={lineQty}
                                      defaultValue={lineArrived}
                                      key={`${line.id}-arr-${lineArrived}`}
                                      disabled={busy}
                                      onBlur={(e) => {
                                        const v = Number(e.target.value);
                                        if (v !== lineArrived) {
                                          void withScrollKeep(() =>
                                            setLineArrived(line.id, v),
                                          );
                                        }
                                      }}
                                    />
                                    <span className="text-zinc-400">
                                      /{lineQty}
                                    </span>
                                  </label>
                                )}
                                {canRemove ? (
                                  <ConfirmButton
                                    label="Excluir"
                                    confirmLabel="Confirmar exclusão?"
                                    className="text-xs font-medium text-red-700 underline decoration-red-200 underline-offset-2"
                                    disabled={busy}
                                    onConfirm={() =>
                                      removeVoteFromProduct(line.id)
                                    }
                                  />
                                ) : null}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="rounded-md border border-dashed border-zinc-300 bg-white p-3">
                        <div className="text-sm font-medium text-zinc-800">
                          Adicionar cliente (voto que a planilha não leu)
                        </div>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          Cada número entra só uma vez nesta carta. Para mais
                          unidades, use a quantidade na linha.
                        </p>
                        <div className="mt-2 flex flex-wrap items-end gap-2">
                          <label className="min-w-[12rem] flex-1 text-xs text-zinc-600">
                            Buscar
                            <input
                              className="field mt-1 text-sm"
                              placeholder="Nome ou telefone…"
                              value={voteSearch}
                              onChange={(e) =>
                                setAddVoteSearchByTitle((s) => ({
                                  ...s,
                                  [row.title]: e.target.value,
                                }))
                              }
                            />
                          </label>
                          <label className="text-xs text-zinc-600">
                            Qtd
                            <input
                              className="field mt-1 w-16 px-2 py-1"
                              type="number"
                              min={1}
                              value={voteQty}
                              onChange={(e) =>
                                setAddVoteQtyByTitle((s) => ({
                                  ...s,
                                  [row.title]: Number(e.target.value),
                                }))
                              }
                            />
                          </label>
                        </div>
                        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto overscroll-contain">
                          {filtered.length === 0 ? (
                            <li className="text-xs text-zinc-500">
                              {q
                                ? "Nenhum cliente encontrado."
                                : "Digite para buscar em todos os clientes, ou cadastre um novo."}
                            </li>
                          ) : (
                            filtered.map((c) => {
                              const already = isAlreadyOnCard(c);
                              return (
                                <li key={c.id}>
                                  <button
                                    type="button"
                                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                                    disabled={busy || already}
                                    onClick={() =>
                                      void addCustomerToProduct(
                                        row.title,
                                        c,
                                        voteQty,
                                      )
                                    }
                                  >
                                    <span>
                                      {labelWithPhone(c.name, c.phone || "")}
                                    </span>
                                    <span
                                      className={`text-xs ${already ? "text-zinc-500" : "text-emerald-700"}`}
                                    >
                                      {already
                                        ? "Já está nesta carta"
                                        : "Adicionar"}
                                    </span>
                                  </button>
                                </li>
                              );
                            })
                          )}
                        </ul>
                        {addVoteShowNewFor !== row.title ? (
                          <button
                            type="button"
                            className="btn-secondary mt-2 w-full text-sm"
                            onClick={() => setAddVoteShowNewFor(row.title)}
                          >
                            Cadastrar cliente novo e adicionar
                          </button>
                        ) : (
                          <div className="mt-2 space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2">
                            <input
                              className="field text-sm"
                              placeholder="Nome"
                              value={addVoteNewName}
                              onChange={(e) =>
                                setAddVoteNewName(e.target.value)
                              }
                            />
                            <input
                              className="field text-sm"
                              placeholder="Telefone / WhatsApp"
                              value={addVoteNewPhone}
                              onChange={(e) =>
                                setAddVoteNewPhone(e.target.value)
                              }
                            />
                            <div className="flex gap-2">
                              <button
                                type="button"
                                className="btn-primary flex-1 text-sm"
                                disabled={busy}
                                onClick={() =>
                                  void createCustomerAndAddToProduct(row.title)
                                }
                              >
                                Criar e adicionar
                              </button>
                              <button
                                type="button"
                                className="btn-secondary text-sm"
                                onClick={() => setAddVoteShowNewFor(null)}
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
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
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <h2 className="font-semibold">
            Participantes ({participants.length})
          </h2>
          {event.kind === "encomenda" && ownerlessLines.length > 0 ? (
            <button
              type="button"
              className="btn-danger px-2 py-1 text-xs"
              disabled={busy}
              onClick={() => openOrphanDelete(ownerlessLines.map((l) => l.id))}
            >
              Excluir {ownerlessLines.length} sem dono
            </button>
          ) : null}
          </div>
          {event.kind === "encomenda" && ownerlessLines.length > 0 ? (
            <p className="mb-2 text-xs text-zinc-600">
              Cartas que o bot não identificou ficam juntas em{" "}
              <strong>Sem cliente</strong>. Abra essa ficha e use{" "}
              <strong>Associar dono</strong> em cada carta.
            </p>
          ) : null}
          {participants.length === 0 ? (
            <EmptyState
              title="Ninguém ainda"
              hint="Importe a planilha ou adicione item manual. Votos 💙 ficam arquivados."
            />
          ) : (
            <>
              <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-2">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  Legenda do status
                </p>
                <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-zinc-700">
                  {PARTICIPANT_FLOW_LEGEND.map((item) => (
                    <li key={item.stage} className="inline-flex items-center gap-1.5">
                      <span
                        className={`inline-block h-2.5 w-2.5 rounded-sm ${item.swatch}`}
                        aria-hidden
                      />
                      {item.label}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] text-zinc-500">
                  O estágio mais alto já conta os anteriores (separado = cobrado e
                  pago). A cor da ficha é a carta mais atrasada da pessoa.
                </p>
              </div>
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
                const activeLines = p.lines.filter(
                  (l) => !isShelvedSaleLine(l, event.kind),
                );
                const activeCount = activeLines.length;
                const missingPrice = activeLines.filter(
                  (l) => lineUnitPrice(l) == null,
                ).length;
                const flowStage = participantFlowStage(
                  p.lines,
                  event.kind,
                  garageById,
                );
                const selected = selectedParticipant === p.key;
                return (
                  <li key={p.key}>
                    <button
                      type="button"
                      className={`flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm ${
                        p.key === "__sem_cliente__"
                          ? selected
                            ? "bg-rose-800 text-white ring-2 ring-rose-950"
                            : "bg-rose-50 text-rose-950 hover:bg-rose-100"
                          : participantFlowCardClass(flowStage, selected)
                      }`}
                      onClick={() => {
                        setSelectedParticipant(p.key);
                        setSelectedLineIds({});
                        setShowShelved(false);
                      }}
                    >
                      <span className="font-medium">
                        {labelWithPhone(p.name, p.phone)}
                        {missingPrice > 0 && !selected ? (
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
                    disabled={
                      activeMainLines.length === 0 ||
                      !activeParticipant.customer_id
                    }
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

              {activeParticipant.key === "__sem_cliente__" ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  O bot não identificou o dono destas cartas. Em cada linha,
                  clique em <strong>Associar dono</strong>, busque o cliente
                  (nome ou telefone) e confirme. O motivo já vem preenchido
                  para auditoria.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={selectedCount === 0 || busy}
                  title="Cria cópia sem dono de cada selecionado (multi-unidade)"
                  onClick={() => void duplicateSelectedLines()}
                >
                  Duplicar seleção
                </button>
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
                  disabled={selectedCount === 0 || busy}
                  onClick={() => void markPaid(selectedIdsFromParticipant(), true)}
                >
                  Marcar pago
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  title={shipBlockedHint}
                  disabled={!canMarkShipped || busy}
                  onClick={() =>
                    void markShipped(selectedIdsFromParticipant())
                  }
                >
                  Marcar como enviado
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
                {activeParticipant &&
                !saleLineHasOwner({
                  customer_id: activeParticipant.customer_id,
                  phone: activeParticipant.phone,
                }) ? (
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy || activeMainLines.length === 0}
                    onClick={() =>
                      openOrphanDelete(activeMainLines.map((l) => l.id))
                    }
                  >
                    Excluir carta sem dono
                  </button>
                ) : (
                  <ConfirmButton
                    label="Cancelar itens"
                    confirmLabel="Cancelar selecionados?"
                    className="btn-danger"
                    disabled={selectedCount === 0}
                    onConfirm={() => {
                      const ids = selectedIdsFromParticipant();
                      const allOrphan = ids.every((id) => {
                        const l = lines.find((x) => x.id === id);
                        return (
                          l &&
                          !saleLineHasOwner({
                            customer_id: l.customer_id,
                            phone: l.customers?.phone,
                            phone_digits: l.phone_digits,
                          })
                        );
                      });
                      if (allOrphan) openOrphanDelete(ids);
                      else void cancelLines(ids);
                    }}
                  />
                )}
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
                        const lineOrphan = !saleLineHasOwner({
                          customer_id: line.customer_id,
                          phone: line.customers?.phone,
                          phone_digits: line.phone_digits,
                        });
                        const canAssign =
                          lineOrphan && !line.paid && !line.garage_item_id;
                        return (
                          <Fragment key={line.id}>
                          <tr>
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
                              <div className="mt-1 flex flex-wrap gap-x-2">
                              <button
                                type="button"
                                className="text-xs font-medium text-sky-800 underline"
                                disabled={busy}
                                title="Cria outra unidade sem dono"
                                onClick={() => void duplicateSaleLine(line)}
                              >
                                Duplicar
                              </button>
                              {canAssign ? (
                                <button
                                  type="button"
                                  className="text-xs font-medium text-amber-800 underline"
                                  disabled={busy}
                                  onClick={() => {
                                    const open = reassignLineId !== line.id;
                                    setReassignLineId(open ? line.id : null);
                                    setReassignReason(
                                      open
                                        ? "Bot não identificou o dono"
                                        : "",
                                    );
                                    setReassignSearch("");
                                    setShowReassignNew(false);
                                  }}
                                >
                                  {reassignLineId === line.id
                                    ? "Cancelar"
                                    : "Associar dono"}
                                </button>
                              ) : null}
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
                                  onClick={() => {
                                    if (busy) return;
                                    void markPaid([line.id], !line.paid);
                                  }}
                                >
                                  {line.paid ? "Pago" : "Em aberto"}
                                </Badge>
                                {line.garage_item_id && !lineAlreadyShipped(line) ? (
                                  <Badge
                                    tone="good"
                                    title="Caixinha/garagem = item guardado do cliente (criado ao marcar pago). Diferente de Separado (preparação física no evento)."
                                  >
                                    Caixinha/garagem
                                  </Badge>
                                ) : null}
                                {lineAlreadyShipped(line) ? (
                                  <Badge tone="info" title="Já saiu da caixinha">
                                    Enviado
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
                          {reassignLineId === line.id && canAssign ? (
                            <tr>
                              <td colSpan={5} className="bg-amber-50/70">
                                <div className="space-y-2 rounded-md border border-amber-200 p-2">
                                  <p className="text-xs text-amber-950">
                                    Busque o cliente e confirme. Motivo vai
                                    para a Auditoria.
                                  </p>
                                  <textarea
                                    className="field min-h-16 text-sm"
                                    placeholder="Motivo da associação…"
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
                                      Deste evento
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
                                          .map((p) => {
                                            if (!p.customer_id) return null;
                                            const existing = customers.find(
                                              (c) => c.id === p.customer_id,
                                            );
                                            if (existing) return existing;
                                            return {
                                              id: p.customer_id,
                                              name: p.name,
                                              phone: p.phone,
                                              phone_digits:
                                                normalizePhoneDigits(p.phone),
                                              notes: "",
                                              created_at: "",
                                            } as Customer;
                                          })
                                          .filter(Boolean)
                                      : customers
                                    )
                                      .filter((c): c is Customer => {
                                        if (!c || c.id === line.customer_id)
                                          return false;
                                        return matchesCustomerQuery(
                                          c,
                                          reassignSearch,
                                        );
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
                                                line.id,
                                                c,
                                                reassignReason,
                                              )
                                            }
                                          >
                                            <span>
                                              {labelWithPhone(
                                                c.name,
                                                c.phone || "",
                                              )}
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
                                      Novo cliente + associar
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
                                          void createCustomerAndChangeOwner(
                                            line.id,
                                          )
                                        }
                                      >
                                        Criar e associar
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ) : null}
                          </Fragment>
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
        <p className="sm:col-span-2 lg:col-span-6 -mt-2 text-xs text-zinc-500">
          Para multi-unidade (ex.: “2 unidades” com pessoas diferentes), use{" "}
          <strong>Duplicar</strong> na carta e depois <strong>Trocar dono</strong>{" "}
          na cópia — ou crie aqui do zero se faltar totalmente.
        </p>
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

      {event.kind === "encomenda" && productSummary.length > 0 ? (
        <section className="panel mb-6">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold">Controle do pedido ao Japão</h2>
              <p className="mt-1 text-sm text-zinc-600">
                Uma linha por modelo de carta. Se pediram 9 da mesma, encomende
                as 9 de uma vez e marque <strong>Pedido feito</strong>.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={cardSort === "enquete" ? "btn-primary text-xs" : "btn-secondary text-xs"}
                onClick={() => setCardSort("enquete")}
              >
                Ordem da enquete
              </button>
              <button
                type="button"
                className={cardSort === "nome" ? "btn-primary text-xs" : "btn-secondary text-xs"}
                onClick={() => setCardSort("nome")}
              >
                A–Z
              </button>
            </div>
          </div>
          <div className="mb-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-800">
                  Mensagem pronta (português)
                </h3>
                <button
                  type="button"
                  className="btn-secondary px-2 py-1 text-xs"
                  onClick={() => void copyPedidoMsg("pt")}
                >
                  Copiar
                </button>
              </div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-xs text-zinc-800">
                {pedidoMsgs.pt}
              </pre>
            </div>
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-800">
                  Mensagem pronta (japonês)
                </h3>
                <button
                  type="button"
                  className="btn-secondary px-2 py-1 text-xs"
                  onClick={() => void copyPedidoMsg("ja")}
                >
                  Copiar
                </button>
              </div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-xs text-zinc-800">
                {pedidoMsgs.ja}
              </pre>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data text-sm">
              <thead>
                <tr>
                  <th>Carta</th>
                  <th>Qtd</th>
                  <th>Pedido ao JP</th>
                  <th>Falta pedir</th>
                </tr>
              </thead>
              <tbody>
                {productSummary.map((row) => (
                  <tr key={`ctrl-${row.title}`}>
                    <td className="font-medium">{row.title}</td>
                    <td>{row.ordered}</td>
                    <td>
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={row.pedidoFeito}
                          disabled={busy}
                          onChange={(e) =>
                            void setPedidoFeito(row.title, e.target.checked)
                          }
                        />
                        {row.pedidoFeito ? "feito" : "pendente"}
                      </label>
                    </td>
                    <td>
                      {row.pedidoFeito ? (
                        <Badge tone="good">ok</Badge>
                      ) : (
                        <Badge tone="warn">{row.ordered} un.</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {orphanDeleteOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl"
          >
            <h2 className="text-base font-semibold text-zinc-900">
              Excluir carta(s) sem dono
            </h2>
            <p className="mt-2 text-sm text-zinc-600">
              {orphanDeleteIds.length} carta(s) sem cliente. Isso tira elas da
              rodada e do a receber. Escreva o motivo (obrigatório).
            </p>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-zinc-600">Observação / motivo</span>
              <textarea
                className="field min-h-24"
                value={orphanDeleteReason}
                onChange={(e) => setOrphanDeleteReason(e.target.value)}
                placeholder="Ex.: enquete sem voto, bot não leu o dono, carta de teste…"
              />
            </label>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => {
                  setOrphanDeleteOpen(false);
                  setOrphanDeleteReason("");
                  setOrphanDeleteIds([]);
                }}
              >
                Voltar
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={busy || orphanDeleteReason.trim().length < 3}
                onClick={() => void confirmOrphanDelete()}
              >
                Excluir
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
