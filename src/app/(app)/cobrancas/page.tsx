"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { createClient } from "@/lib/supabase/client";
import { formatMoneyBr } from "@/lib/cobranca-msg";
import { eventHappenedOn } from "@/lib/event-date";
import {
  BILLING_STATUS_LABEL,
  buildBillingDraft,
  fantasyBillingText,
  isBillableOpenLine,
  parseTestRecipients,
  type BillingDraftItem,
  type BillingDraftProblem,
  type BillingRun,
  type BillingSourceLine,
} from "@/lib/billing";
import {
  buildPhoneCustomerIndex,
  buildPhoneLookup,
  customerPhoneDigits,
  fetchAllQueryRows,
  fetchCustomersSharingPhone,
  fetchSaleLinesForCustomer,
  phoneInLookup,
} from "@/lib/customers";
import {
  buildSheetBillingDraft,
  parseBillingXlsxFile,
  type SheetBillingGroup,
} from "@/lib/billing-sheet";
import type { Customer } from "@/lib/types";
import { parseMoneyFromOption } from "@/lib/leilao-resultado";
import type { Event } from "@/lib/types";

type EventRow = Pick<Event, "id" | "name" | "opened_at" | "kind" | "status" | "payment_due_at">;

type PickCustomer = { id: string; name: string; phone: string; phone_digits?: string | null };

type JoinedRun = { name: string; status?: string; is_test: boolean };

const DUPLICATE_RECENT_DAYS = 3;

function draftKey(it: BillingDraftItem) {
  return `${it.phone_digits}|${it.event_ids.join(",")}`;
}

function sourceLinePrice(l: BillingSourceLine): number | null {
  if (l.unit_price != null && Number.isFinite(Number(l.unit_price))) return Number(l.unit_price);
  return parseMoneyFromOption(l.product_title) ?? parseMoneyFromOption(l.valor_ou_opcao || "");
}

function joinedRun(v: JoinedRun | JoinedRun[] | null | undefined): JoinedRun | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] || null : v;
}

type RunCounts = { total: number; sent: number; pending: number; failed: number; replies: number; hints: number };

const LINE_SELECT =
  "id, event_id, customer_id, phone_digits, customer_name_snapshot, product_title, valor_ou_opcao, unit_price, qty, import_status, certainty, cancelled, archived, charged, paid, notes, events(id, name, opened_at, payment_due_at, kind), customers(id, name, phone)";

function statusTone(s: BillingRun["status"]): "neutral" | "good" | "warn" | "bad" | "info" {
  if (s === "running") return "info";
  if (s === "paused") return "warn";
  if (s === "done") return "good";
  if (s === "stopped") return "bad";
  return "neutral";
}

function kindLabel(kind?: string | null) {
  return kind === "leilao"
    ? "Leilão"
    : kind === "encomenda"
      ? "Encomenda"
      : kind === "venda"
        ? "Venda"
        : "Outro";
}

function fmtDay(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("pt-BR");
}

export default function CobrancasPage() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [runs, setRuns] = useState<BillingRun[]>([]);
  const [counts, setCounts] = useState<Record<string, RunCounts>>({});
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"unificada" | "separada">("unificada");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeCharged, setIncludeCharged] = useState(false);
  const [isTest, setIsTest] = useState(false);
  const [testRaw, setTestRaw] = useState("");
  const [draft, setDraft] = useState<{
    items: BillingDraftItem[];
    problems: BillingDraftProblem[];
  } | null>(null);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [source, setSource] = useState<"eventos" | "clientes" | "planilha">("eventos");
  const [custQuery, setCustQuery] = useState("");
  const [custResults, setCustResults] = useState<PickCustomer[]>([]);
  const [picked, setPicked] = useState<PickCustomer[]>([]);
  const [custLines, setCustLines] = useState<Record<string, BillingSourceLine[]>>({});
  const [offEvents, setOffEvents] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [dupes, setDupes] = useState<Record<string, string[]>>({});
  const [draftSearch, setDraftSearch] = useState("");
  const sheetFile = useRef<File | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheetUsed, setSheetUsed] = useState("");
  const [sheetDate, setSheetDate] = useState("");
  const [paymentDue, setPaymentDue] = useState("");
  const [sheetGroups, setSheetGroups] = useState<SheetBillingGroup[] | null>(null);
  const [sheetMeta, setSheetMeta] = useState<{ lines: number; paid: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [runsRes, eventsRes] = await Promise.all([
      supabase
        .from("billing_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("events")
        .select("id, name, opened_at, kind, status, payment_due_at")
        .order("opened_at", { ascending: false })
        .limit(60),
    ]);
    if (runsRes.error) {
      setError(
        runsRes.error.message.includes("billing_runs")
          ? "Tabelas de cobrança não existem ainda. Rode supabase/migration_billing.sql no Supabase."
          : runsRes.error.message,
      );
      setLoading(false);
      return;
    }
    const runList = (runsRes.data || []) as BillingRun[];
    setRuns(runList);
    setEvents((eventsRes.data || []) as EventRow[]);

    if (runList.length) {
      const { data: items } = await supabase
        .from("billing_items")
        .select("run_id, status, reply_count, payment_status")
        .in(
          "run_id",
          runList.map((r) => r.id),
        );
      const c: Record<string, RunCounts> = {};
      for (const it of (items || []) as Array<{
        run_id: string;
        status: string;
        reply_count: number;
        payment_status: string;
      }>) {
        const row = (c[it.run_id] ||= { total: 0, sent: 0, pending: 0, failed: 0, replies: 0, hints: 0 });
        row.total++;
        if (it.status === "sent") row.sent++;
        if (it.status === "pending" || it.status === "sending") row.pending++;
        if (it.status === "failed") row.failed++;
        if (it.reply_count > 0) row.replies++;
        if (it.payment_status === "hint") row.hints++;
      }
      setCounts(c);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleEvent(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDraft(null);
  }

  async function fetchLines(eventIds: string[]): Promise<BillingSourceLine[]> {
    const out: BillingSourceLine[] = [];
    const pageSize = 1000;
    for (let from = 0; from < 50_000; from += pageSize) {
      const { data, error: err } = await supabase
        .from("event_sale_lines")
        .select(LINE_SELECT)
        .in("event_id", eventIds)
        .eq("cancelled", false)
        .eq("paid", false)
        .order("id")
        .range(from, from + pageSize - 1);
      if (err) throw err;
      const batch = (data || []) as unknown as BillingSourceLine[];
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    return out;
  }

  useEffect(() => {
    const q = custQuery.trim();
    if (source !== "clientes" || q.length < 2) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const digits = q.replace(/\D/g, "");
      const safe = q.replace(/[%,()]/g, " ");
      const orFilter =
        digits.length >= 4
          ? `name.ilike.%${safe}%,phone_digits.ilike.%${digits}%`
          : `name.ilike.%${safe}%`;
      const { data } = await supabase
        .from("customers")
        .select("id, name, phone, phone_digits")
        .or(orFilter)
        .order("name", { ascending: true })
        .limit(12);
      if (!cancelled) setCustResults((data || []) as PickCustomer[]);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [custQuery, source, supabase]);

  async function addCustomer(c: PickCustomer) {
    if (picked.some((p) => p.id === c.id)) return;
    setPicked((prev) => [...prev, c]);
    setCustQuery("");
    setDraft(null);
    try {
      const phone = customerPhoneDigits({ phone: c.phone, phone_digits: c.phone_digits });
      const related = await fetchCustomersSharingPhone(supabase, c.id, phone).catch(() => []);
      const ids = [...new Set([c.id, ...related.map((r) => r.id)])];
      const rows = await fetchSaleLinesForCustomer<BillingSourceLine>(supabase, {
        customerIds: ids,
        phoneDigits: phone,
        select: LINE_SELECT,
        cancelled: false,
      });
      const open = rows
        .filter((l) => !l.paid)
        .map((l) => ({
          ...l,
          customer_id: c.id,
          phone_digits: phone || l.phone_digits,
          customers: { id: c.id, name: c.name, phone: c.phone },
        }));
      setCustLines((prev) => ({ ...prev, [c.id]: open }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCustLines((prev) => ({ ...prev, [c.id]: [] }));
    }
  }

  function removeCustomer(id: string) {
    setPicked((prev) => prev.filter((p) => p.id !== id));
    setDraft(null);
  }

  function toggleCustomerEvent(customerId: string, eventId: string) {
    const key = `${customerId}:${eventId}`;
    setOffEvents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDraft(null);
  }

  function customerEventSummary(customerId: string) {
    const rows = custLines[customerId];
    if (!rows) return null;
    const byEvent = new Map<
      string,
      { eventId: string; name: string; kind: string; day: string | null; count: number; total: number; missing: number }
    >();
    for (const l of rows) {
      if (!isBillableOpenLine(l, includeCharged)) continue;
      let ev = byEvent.get(l.event_id);
      if (!ev) {
        ev = {
          eventId: l.event_id,
          name: l.events?.name || "Evento",
          kind: l.events?.kind || "outro",
          day: eventHappenedOn({ name: l.events?.name, opened_at: l.events?.opened_at }),
          count: 0,
          total: 0,
          missing: 0,
        };
        byEvent.set(l.event_id, ev);
      }
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
      const price = sourceLinePrice(l);
      ev.count += 1;
      if (price == null) ev.missing += 1;
      else ev.total += price * qty;
    }
    return [...byEvent.values()].sort((a, b) => (b.day || "").localeCompare(a.day || ""));
  }

  /** Cliente já numa lista que ainda não terminou, ou cobrado nos últimos dias. */
  async function findDuplicates(items: BillingDraftItem[]) {
    const since = new Date(Date.now() - DUPLICATE_RECENT_DAYS * 86_400_000).toISOString();
    const [act, rec] = await Promise.all([
      supabase
        .from("billing_items")
        .select("phone_digits, billing_runs!inner(name, status, is_test)")
        .in("status", ["pending", "sending"])
        .in("billing_runs.status", ["draft", "running", "paused"])
        .eq("billing_runs.is_test", false)
        .limit(5000),
      supabase
        .from("billing_items")
        .select("phone_digits, sent_at, billing_runs!inner(name, is_test)")
        .eq("status", "sent")
        .gte("sent_at", since)
        .eq("billing_runs.is_test", false)
        .limit(5000),
    ]);
    const active = (act.data || []) as unknown as Array<{
      phone_digits: string;
      billing_runs: JoinedRun | JoinedRun[] | null;
    }>;
    const recent = (rec.data || []) as unknown as Array<{
      phone_digits: string;
      sent_at: string;
      billing_runs: JoinedRun | JoinedRun[] | null;
    }>;
    const warnings: Record<string, string[]> = {};
    const blocked = new Set<string>();
    for (const it of items) {
      const lookup = buildPhoneLookup([it.phone_digits]);
      const msgs: string[] = [];
      for (const a of active) {
        if (!phoneInLookup(a.phone_digits, lookup)) continue;
        msgs.push(`Já está na lista "${joinedRun(a.billing_runs)?.name || "?"}" (ainda não enviada)`);
        blocked.add(draftKey(it));
      }
      for (const r of recent) {
        if (!phoneInLookup(r.phone_digits, lookup)) continue;
        msgs.push(
          `Cobrado em ${new Date(r.sent_at).toLocaleString("pt-BR")} na lista "${joinedRun(r.billing_runs)?.name || "?"}"`,
        );
      }
      if (msgs.length) warnings[draftKey(it)] = [...new Set(msgs)];
    }
    return { warnings, blocked };
  }

  async function loadSheet(file: File, sheetName?: string) {
    setError(null);
    setInfo(null);
    setDraft(null);
    const parsed = await parseBillingXlsxFile(file, sheetName);
    sheetFile.current = file;
    setSheetNames(parsed.sheets);
    setSheetUsed(parsed.sheetUsed);
    setSheetDate(parsed.eventDate || "");
    setSheetGroups(parsed.groups);
    setSheetMeta({ lines: parsed.lineCount, paid: parsed.paidSkipped });
    if (!parsed.sheets.length) {
      setError("Nenhuma aba com as colunas Item, Valor, Cliente e Contato.");
      return;
    }
    setName((prev) =>
      prev.trim() && !prev.startsWith("Pré-venda · ") ? prev : `Pré-venda · ${parsed.sheetUsed}`,
    );
  }

  async function buildPreview() {
    setError(null);
    setInfo(null);
    const recipients = parseTestRecipients(testRaw);
    if (isTest && !recipients.length) {
      setError("Lista de teste: coloque pelo menos 1 número (um por linha).");
      return;
    }
    if (!isTest && source === "eventos" && !selected.size) {
      setError("Escolha pelo menos 1 evento.");
      return;
    }
    if (!isTest && source === "clientes" && !picked.length) {
      setError("Escolha pelo menos 1 cliente.");
      return;
    }
    if (!isTest && source === "planilha" && !sheetGroups?.length) {
      setError("Envie a planilha da pré-venda (colunas Item, Valor, Cliente e Contato).");
      return;
    }
    if (source === "clientes" && picked.some((p) => !custLines[p.id])) {
      setError("Espere carregar as cartas de todos os clientes escolhidos.");
      return;
    }
    setBusy(true);
    try {
      let built = { items: [] as BillingDraftItem[], problems: [] as BillingDraftProblem[] };
      if (source === "eventos" && selected.size) {
        const lines = await fetchLines([...selected]);
        built = buildBillingDraft(lines, { mode, includeCharged });
      } else if (source === "clientes" && picked.length) {
        const lines = picked.flatMap((c) =>
          (custLines[c.id] || []).filter((l) => !offEvents.has(`${c.id}:${l.event_id}`)),
        );
        built = buildBillingDraft(lines, { mode, includeCharged });
      } else if (source === "planilha" && sheetGroups?.length) {
        const fromSheet = buildSheetBillingDraft(sheetGroups, {
          roundName: sheetUsed || "Pré-venda",
          eventDate: sheetDate || null,
          paymentDue: paymentDue || null,
        });
        built = { items: fromSheet.items, problems: fromSheet.problems };
        try {
          type PhoneCust = Pick<Customer, "id" | "name" | "phone" | "phone_digits" | "created_at">;
          const customers = await fetchAllQueryRows<PhoneCust>((from, to) =>
            supabase
              .from("customers")
              .select("id, name, phone, phone_digits, created_at")
              .order("id")
              .range(from, to) as PromiseLike<{
              data: PhoneCust[] | null;
              error: { message: string } | null;
            }>,
          );
          const index = buildPhoneCustomerIndex(customers as Customer[]);
          for (const it of built.items) {
            const hit = index.get(it.phone_digits);
            if (hit) it.customer_id = hit.id;
          }
        } catch {
          /* a lista segue sem vínculo com a ficha */
        }
        if (fromSheet.mergedNames) {
          setInfo(
            `${fromSheet.mergedNames} telefone(s) tinham mais de um nome na planilha. Ficaram na mesma cobrança.`,
          );
        }
      }
      if (isTest) {
        const models = built.items;
        built = {
          problems: built.problems,
          items: recipients.map((r, i) => {
            const model = models.length ? models[i % models.length]! : null;
            return {
              customer_id: null,
              customer_name: model
                ? `TESTE → ${r.name} (modelo: ${model.customer_name})`
                : `TESTE → ${r.name}`,
              phone_digits: r.phone,
              text: model ? model.text : fantasyBillingText(r.name),
              total: model ? model.total : 170,
              sale_line_ids: [],
              event_ids: model ? model.event_ids : [],
            };
          }),
        };
      }
      if (isTest) {
        setDupes({});
        setExcluded(new Set());
      } else {
        const { warnings, blocked } = await findDuplicates(built.items);
        setDupes(warnings);
        setExcluded(blocked);
      }
      setDraftSearch("");
      setDraft(built);
      setPreviewIdx(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createRun() {
    const chosen = (draft?.items || []).filter((it) => !excluded.has(draftKey(it)));
    if (!chosen.length) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await supabase.auth.getUser();
      const meId = auth.data.user?.id || null;
      const runEventIds =
        source === "eventos"
          ? [...selected]
          : source === "planilha"
            ? []
            : [...new Set(chosen.flatMap((it) => it.event_ids))];
      const evNames =
        source === "eventos"
          ? events
              .filter((e) => selected.has(e.id))
              .map((e) => e.name)
              .join(" + ")
          : source === "planilha"
            ? sheetUsed || "Planilha"
            : `Por cliente (${new Set(chosen.map((it) => it.phone_digits)).size})`;
      const runName =
        name.trim() ||
        `${isTest ? "TESTE · " : ""}${evNames || "Cobrança"} · ${new Date().toLocaleDateString("pt-BR")}`;
      const { data: run, error: runErr } = await supabase
        .from("billing_runs")
        .insert({
          name: runName,
          mode,
          status: "draft",
          is_test: isTest,
          event_ids: runEventIds,
          created_by: meId,
        })
        .select("*")
        .single();
      if (runErr) throw runErr;
      const rows = chosen.map((it, i) => ({
        run_id: (run as BillingRun).id,
        position: i + 1,
        customer_id: it.customer_id,
        customer_name: it.customer_name,
        phone_digits: it.phone_digits,
        text: it.text,
        total: it.total,
        sale_line_ids: it.sale_line_ids,
        event_ids: it.event_ids,
      }));
      for (let i = 0; i < rows.length; i += 200) {
        const { error: insErr } = await supabase
          .from("billing_items")
          .insert(rows.slice(i, i + 200));
        if (insErr) throw insErr;
      }
      router.push(`/cobrancas/${(run as BillingRun).id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const draftChosen = useMemo(
    () => (draft?.items || []).filter((it) => !excluded.has(draftKey(it))),
    [draft, excluded],
  );
  const draftTotal = useMemo(
    () => draftChosen.reduce((s, it) => s + (it.total || 0), 0),
    [draftChosen],
  );
  const draftVisible = useMemo(() => {
    const q = draftSearch.trim().toLowerCase();
    return (draft?.items || [])
      .map((it, idx) => ({ it, idx }))
      .filter(
        ({ it }) =>
          !q ||
          it.customer_name.toLowerCase().includes(q) ||
          it.phone_digits.includes(q.replace(/\D/g, "") || "\u0000"),
      );
  }, [draft, draftSearch]);

  function setDraftChecked(keys: string[], checked: boolean) {
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (checked) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }
  const preview = draft?.items[previewIdx];

  return (
    <div>
      <PageHeader
        title="Cobranças"
        description="Monte a lista, revise as mensagens e inicie. O bot envia 1 cobrança por vez (~1 por minuto) e as respostas aparecem aqui."
        actions={
          <button
            type="button"
            onClick={() => setShowNew((v) => !v)}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            {showNew ? "Fechar" : "Nova lista"}
          </button>
        }
      />

      {error ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}
      {info ? (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {info}
        </div>
      ) : null}

      {showNew ? (
        <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold text-zinc-900">Nova lista de cobranças</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <label className="block text-sm">
                <span className="font-medium text-zinc-700">Nome (opcional)</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex.: Leilão 05/10"
                  className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                />
              </label>

              {source === "planilha" ? null : (
              <>
              <div className="text-sm">
                <span className="font-medium text-zinc-700">Formato</span>
                <div className="mt-1 flex flex-wrap gap-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={mode === "unificada"}
                      onChange={() => {
                        setMode("unificada");
                        setDraft(null);
                      }}
                    />
                    Unificada (1 mensagem por cliente)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={mode === "separada"}
                      onChange={() => {
                        setMode("separada");
                        setDraft(null);
                      }}
                    />
                    Separada (1 por evento)
                  </label>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeCharged}
                  onChange={(e) => {
                    setIncludeCharged(e.target.checked);
                    setDraft(null);
                  }}
                />
                Incluir quem já foi marcado como cobrado (lembrete)
              </label>
              </>
              )}

              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                <label className="flex items-center gap-2 font-medium text-amber-900">
                  <input
                    type="checkbox"
                    checked={isTest}
                    onChange={(e) => {
                      setIsTest(e.target.checked);
                      setDraft(null);
                    }}
                  />
                  Lista de teste (não marca nada como cobrado)
                </label>
                {isTest ? (
                  <>
                    <p className="mt-2 text-xs text-amber-900/80">
                      Um número por linha (ex.: <code>Paulo - 5521999999999</code>). Se escolher
                      eventos, usa as cobranças reais como modelo; sem evento, manda uma
                      cobrança fantasia.
                    </p>
                    <textarea
                      value={testRaw}
                      onChange={(e) => {
                        setTestRaw(e.target.value);
                        setDraft(null);
                      }}
                      rows={4}
                      className="mt-2 w-full rounded-md border border-amber-300 bg-white px-3 py-2 font-mono text-xs"
                      placeholder={"Paulo - 5521999999999\nAdm 2 - 5521988888888"}
                    />
                  </>
                ) : null}
              </div>
            </div>

            <div>
              <div className="mb-2 flex gap-1">
                {(
                  [
                    ["eventos", "Por eventos"],
                    ["clientes", "Por clientes"],
                    ["planilha", "Por planilha"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setSource(key);
                      setDraft(null);
                    }}
                    className={
                      source === key
                        ? "rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white"
                        : "rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {source === "planilha" ? (
                <div className="text-sm">
                  <span className="font-medium text-zinc-700">Planilha da pré-venda</span>
                  <p className="text-xs text-zinc-500">
                    Aba com as colunas Item, Valor, Cliente e Contato. O valor é o total da linha. Telefone em
                    branco repete o do mesmo cliente na linha de cima. Quem estiver com Pagamento preenchido fica de
                    fora. A lista não marca cartas de evento como cobradas.
                  </p>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    className="mt-2 block w-full text-sm"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void loadSheet(file).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                    }}
                  />
                  {sheetNames.length > 1 ? (
                    <label className="mt-2 block text-xs">
                      <span className="mb-1 block text-zinc-600">Aba</span>
                      <select
                        value={sheetUsed}
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                        onChange={(e) => {
                          const file = sheetFile.current;
                          if (file) {
                            void loadSheet(file, e.target.value).catch((err) =>
                              setError(err instanceof Error ? err.message : String(err)),
                            );
                          }
                        }}
                      >
                        {sheetNames.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : sheetUsed ? (
                    <p className="mt-2 text-xs text-zinc-600">Aba: {sheetUsed}</p>
                  ) : null}
                  {sheetGroups ? (
                    <p className="mt-2 text-xs text-zinc-600">
                      {sheetGroups.length} cliente(s) · {sheetMeta?.lines ?? 0} item(ns)
                      {sheetMeta?.paid ? ` · ${sheetMeta.paid} linha(s) já paga(s), de fora` : ""}
                    </p>
                  ) : null}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="block text-xs">
                      <span className="mb-1 block text-zinc-600">Data da pré-venda</span>
                      <input
                        type="date"
                        value={sheetDate}
                        onChange={(e) => {
                          setSheetDate(e.target.value);
                          setDraft(null);
                        }}
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                      />
                    </label>
                    <label className="block text-xs">
                      <span className="mb-1 block text-zinc-600">Pagamento até</span>
                      <input
                        type="date"
                        value={paymentDue}
                        onChange={(e) => {
                          setPaymentDue(e.target.value);
                          setDraft(null);
                        }}
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                      />
                    </label>
                  </div>
                </div>
              ) : source === "clientes" ? (
                <div>
                  <span className="text-sm font-medium text-zinc-700">
                    Clientes ({picked.length} escolhido{picked.length === 1 ? "" : "s"})
                  </span>
                  <p className="text-xs text-zinc-500">
                    Busque e adicione. Aparecem os eventos em aberto de cada um (todas as rodadas) — desmarque o que não
                    quer cobrar.
                  </p>
                  <div className="relative mt-1">
                    <input
                      value={custQuery}
                      onChange={(e) => setCustQuery(e.target.value)}
                      placeholder="Nome ou telefone…"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                    />
                    {custQuery.trim().length >= 2 && custResults.length ? (
                      <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-zinc-200 bg-white text-sm shadow">
                        {custResults.map((c) => {
                          const already = picked.some((p) => p.id === c.id);
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                disabled={already}
                                onClick={() => void addCustomer(c)}
                                className="flex w-full justify-between px-3 py-1.5 text-left hover:bg-zinc-50 disabled:opacity-50"
                              >
                                <span className="truncate">{c.name}</span>
                                <span className="text-xs text-zinc-500">{already ? "já adicionado" : c.phone}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                  <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
                    {picked.map((c) => {
                      const evs = customerEventSummary(c.id);
                      return (
                        <div key={c.id} className="rounded-md border border-zinc-200 p-2 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-zinc-900">
                              {c.name} <span className="text-xs font-normal text-zinc-500">{c.phone}</span>
                            </span>
                            <button
                              type="button"
                              className="text-xs text-zinc-500 hover:text-red-700"
                              onClick={() => removeCustomer(c.id)}
                            >
                              remover
                            </button>
                          </div>
                          {evs == null ? (
                            <p className="mt-1 text-xs text-zinc-500">Carregando cartas…</p>
                          ) : evs.length === 0 ? (
                            <p className="mt-1 text-xs text-zinc-500">
                              Nada em aberto para cobrar
                              {includeCharged ? "" : " (quem já foi cobrado só entra marcando o lembrete)"}.
                            </p>
                          ) : (
                            <ul className="mt-1 space-y-0.5">
                              {evs.map((ev) => (
                                <li key={ev.eventId}>
                                  <label className="flex cursor-pointer items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={!offEvents.has(`${c.id}:${ev.eventId}`)}
                                      onChange={() => toggleCustomerEvent(c.id, ev.eventId)}
                                    />
                                    <span className="flex-1 truncate">
                                      {kindLabel(ev.kind)} · {fmtDay(ev.day)} · {ev.name}
                                    </span>
                                    <span className="text-zinc-500">
                                      {ev.count} item(ns) · R$ {formatMoneyBr(ev.total)}
                                      {ev.missing ? <span className="text-red-700"> · {ev.missing} sem preço</span> : null}
                                    </span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
              <>
              <span className="text-sm font-medium text-zinc-700">
                Eventos ({selected.size} escolhido{selected.size === 1 ? "" : "s"})
              </span>
              <div className="mt-1 max-h-80 overflow-y-auto rounded-md border border-zinc-200">
                {events.map((ev) => {
                  const day = eventHappenedOn({ name: ev.name, opened_at: ev.opened_at });
                  return (
                    <label
                      key={ev.id}
                      className="flex cursor-pointer items-center gap-2 border-b border-zinc-100 px-3 py-2 text-sm last:border-0 hover:bg-zinc-50"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(ev.id)}
                        onChange={() => toggleEvent(ev.id)}
                      />
                      <span className="flex-1 truncate">{ev.name}</span>
                      <span className="text-xs text-zinc-500">
                        {kindLabel(ev.kind)} · {fmtDay(day)}
                      </span>
                    </label>
                  );
                })}
              </div>
              </>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void buildPreview()}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
            >
              {busy ? "Montando…" : "Pré-visualizar"}
            </button>
            {draft?.items.length ? (
              <button
                type="button"
                disabled={busy || !draftChosen.length}
                onClick={() => void createRun()}
                className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                Criar lista ({draftChosen.length})
              </button>
            ) : null}
          </div>

          {draft ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="text-sm">
                <p className="font-medium text-zinc-800">
                  {draftChosen.length} de {draft.items.length} cobrança(s) marcadas · total R${" "}
                  {formatMoneyBr(draftTotal)}
                </p>
                {Object.keys(dupes).length ? (
                  <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                    {Object.keys(dupes).length} cliente(s) com aviso de cobrança dupla (em amarelo). Quem já está em
                    outra lista não enviada veio desmarcado.
                  </p>
                ) : null}
                {draft.problems.length ? (
                  <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                    <p className="font-semibold">
                      Fora da lista ({draft.problems.length}) —{" "}
                      {source === "planilha"
                        ? "corrija na planilha e monte de novo:"
                        : "corrija no evento e monte de novo:"}
                    </p>
                    <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-4">
                      {draft.problems.map((p, i) => (
                        <li key={i}>
                          {p.name}
                          {p.phone ? ` (${p.phone})` : ""} — {p.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={draftSearch}
                    onChange={(e) => setDraftSearch(e.target.value)}
                    placeholder="Buscar na prévia…"
                    className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    className="text-xs text-sky-800 underline"
                    onClick={() => setDraftChecked(draftVisible.map(({ it }) => draftKey(it)), true)}
                  >
                    marcar todos
                  </button>
                  <button
                    type="button"
                    className="text-xs text-sky-800 underline"
                    onClick={() => setDraftChecked(draftVisible.map(({ it }) => draftKey(it)), false)}
                  >
                    desmarcar todos
                  </button>
                </div>
                <ul className="mt-2 max-h-80 overflow-y-auto rounded-md border border-zinc-200 text-xs">
                  {draftVisible.map(({ it, idx }) => {
                    const key = draftKey(it);
                    const checked = !excluded.has(key);
                    const warn = dupes[key];
                    return (
                      <li
                        key={key + idx}
                        className={`flex items-start gap-2 border-b border-zinc-100 px-2 py-1 last:border-0 ${
                          idx === previewIdx ? "bg-zinc-100" : ""
                        } ${warn ? "bg-amber-50" : ""}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={checked}
                          onChange={(e) => setDraftChecked([key], e.target.checked)}
                        />
                        <button
                          type="button"
                          onClick={() => setPreviewIdx(idx)}
                          className={`min-w-0 flex-1 text-left ${checked ? "" : "text-zinc-400 line-through"}`}
                        >
                          <span className="flex justify-between gap-2">
                            <span className="truncate">
                              {idx + 1}. {it.customer_name}
                            </span>
                            <span className="text-zinc-500">R$ {formatMoneyBr(it.total)}</span>
                          </span>
                          {warn ? (
                            <span className="block text-amber-800 no-underline">{warn.join(" · ")}</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              {preview ? (
                <div>
                  <p className="text-xs text-zinc-500">
                    Prévia · {preview.customer_name} · {preview.phone_digits}
                  </p>
                  <pre className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-[#e7f6e0] p-3 text-xs text-zinc-900">
                    {preview.text}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {loading ? (
        <p className="text-sm text-zinc-500">Carregando…</p>
      ) : !runs.length ? (
        <EmptyState
          title="Nenhuma lista de cobrança ainda"
          hint="Clique em Nova lista. Comece com uma lista de teste para o seu número."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Lista</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Enviadas</th>
                <th className="px-3 py-2">Na fila</th>
                <th className="px-3 py-2">Falhas</th>
                <th className="px-3 py-2">Respostas</th>
                <th className="px-3 py-2">Criada</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const c = counts[r.id];
                return (
                  <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50">
                    <td className="px-3 py-2">
                      <Link href={`/cobrancas/${r.id}`} className="font-medium text-zinc-900 hover:underline">
                        {r.name || "Sem nome"}
                      </Link>
                      {r.is_test ? (
                        <span className="ml-2">
                          <Badge tone="warn">teste</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(r.status)}>{BILLING_STATUS_LABEL[r.status]}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      {c?.sent ?? 0}/{c?.total ?? 0}
                    </td>
                    <td className="px-3 py-2">{c?.pending ?? 0}</td>
                    <td className="px-3 py-2">{c?.failed ?? 0}</td>
                    <td className="px-3 py-2">
                      {c?.replies ?? 0}
                      {c?.hints ? (
                        <span className="ml-1">
                          <Badge tone="good">{c.hints} pag.?</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-zinc-500">
                      {new Date(r.created_at).toLocaleString("pt-BR")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
