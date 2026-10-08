"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  parseTestRecipients,
  type BillingDraftItem,
  type BillingDraftProblem,
  type BillingRun,
  type BillingSourceLine,
} from "@/lib/billing";
import type { Event } from "@/lib/types";

type EventRow = Pick<Event, "id" | "name" | "opened_at" | "kind" | "status" | "payment_due_at">;

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
  return kind === "leilao" ? "Leilão" : kind === "encomenda" ? "Encomenda" : "Outro";
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

  async function buildPreview() {
    setError(null);
    setInfo(null);
    const recipients = parseTestRecipients(testRaw);
    if (isTest && !recipients.length) {
      setError("Lista de teste: coloque pelo menos 1 número (um por linha).");
      return;
    }
    if (!isTest && !selected.size) {
      setError("Escolha pelo menos 1 evento.");
      return;
    }
    setBusy(true);
    try {
      let built = { items: [] as BillingDraftItem[], problems: [] as BillingDraftProblem[] };
      if (selected.size) {
        const lines = await fetchLines([...selected]);
        built = buildBillingDraft(lines, { mode, includeCharged });
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
      setDraft(built);
      setPreviewIdx(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createRun() {
    if (!draft?.items.length) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await supabase.auth.getUser();
      const meId = auth.data.user?.id || null;
      const evNames = events
        .filter((e) => selected.has(e.id))
        .map((e) => e.name)
        .join(" + ");
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
          event_ids: [...selected],
          created_by: meId,
        })
        .select("*")
        .single();
      if (runErr) throw runErr;
      const rows = draft.items.map((it, i) => ({
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

  const draftTotal = useMemo(
    () => (draft?.items || []).reduce((s, it) => s + (it.total || 0), 0),
    [draft],
  );
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
                disabled={busy}
                onClick={() => void createRun()}
                className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                Criar lista ({draft.items.length})
              </button>
            ) : null}
          </div>

          {draft ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="text-sm">
                <p className="font-medium text-zinc-800">
                  {draft.items.length} cobrança(s) · total R$ {formatMoneyBr(draftTotal)}
                </p>
                {draft.problems.length ? (
                  <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                    <p className="font-semibold">
                      Fora da lista ({draft.problems.length}) — corrija no evento e monte de novo:
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
                <ul className="mt-2 max-h-64 overflow-y-auto rounded-md border border-zinc-200 text-xs">
                  {draft.items.map((it, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => setPreviewIdx(i)}
                        className={`flex w-full justify-between px-2 py-1 text-left hover:bg-zinc-50 ${
                          i === previewIdx ? "bg-zinc-100" : ""
                        }`}
                      >
                        <span className="truncate">
                          {i + 1}. {it.customer_name}
                        </span>
                        <span className="text-zinc-500">R$ {formatMoneyBr(it.total)}</span>
                      </button>
                    </li>
                  ))}
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
