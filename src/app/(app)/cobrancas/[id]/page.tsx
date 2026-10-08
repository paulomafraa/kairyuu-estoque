"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { createClient } from "@/lib/supabase/client";
import { formatMoneyBr } from "@/lib/cobranca-msg";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import {
  BILLING_ITEM_STATUS_LABEL,
  BILLING_STATUS_LABEL,
  type BillingItem,
  type BillingReply,
  type BillingRun,
} from "@/lib/billing";

type Filter = "all" | "pending" | "sent" | "replied" | "hint" | "failed";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "pending", label: "Na fila" },
  { id: "sent", label: "Enviadas" },
  { id: "replied", label: "Com resposta" },
  { id: "hint", label: "Possível pagamento" },
  { id: "failed", label: "Falhas / puladas" },
];

function itemTone(s: BillingItem["status"]): "neutral" | "good" | "warn" | "bad" | "info" {
  if (s === "sent") return "good";
  if (s === "sending") return "info";
  if (s === "failed") return "bad";
  if (s === "skipped") return "warn";
  return "neutral";
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR");
}

const btn =
  "rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50";
const btnDark =
  "rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50";

export default function CobrancaDetailPage() {
  const params = useParams<{ id: string }>();
  const runId = params.id;
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [run, setRun] = useState<BillingRun | null>(null);
  const [items, setItems] = useState<BillingItem[]>([]);
  const [replies, setReplies] = useState<BillingReply[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [minS, setMinS] = useState(50);
  const [maxS, setMaxS] = useState(75);
  const [manual, setManual] = useState({ name: "", phone: "", text: "" });
  const [showManual, setShowManual] = useState(false);

  const load = useCallback(async () => {
    const [runRes, itemsRes, repliesRes] = await Promise.all([
      supabase.from("billing_runs").select("*").eq("id", runId).maybeSingle(),
      supabase
        .from("billing_items")
        .select("*")
        .eq("run_id", runId)
        .order("position", { ascending: true }),
      supabase
        .from("billing_replies")
        .select("*")
        .eq("run_id", runId)
        .order("received_at", { ascending: true }),
    ]);
    if (runRes.error) {
      setError(runRes.error.message);
      return;
    }
    const r = runRes.data as BillingRun | null;
    setRun(r);
    if (r) {
      setMinS((prev) => (prev === 50 ? r.min_interval_s : prev));
      setMaxS((prev) => (prev === 75 ? r.max_interval_s : prev));
    }
    setItems((itemsRes.data || []) as BillingItem[]);
    setReplies((repliesRes.data || []) as BillingReply[]);
  }, [supabase, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Atualiza sozinho enquanto a lista está ativa (ou teve envio recente)
  useEffect(() => {
    const t = setInterval(() => void load(), run?.status === "running" ? 8_000 : 20_000);
    return () => clearInterval(t);
  }, [load, run?.status]);

  const repliesByItem = useMemo(() => {
    const m = new Map<string, BillingReply[]>();
    for (const r of replies) {
      const list = m.get(r.item_id) || [];
      list.push(r);
      m.set(r.item_id, list);
    }
    return m;
  }, [replies]);

  const counts = useMemo(() => {
    const c = { total: items.length, sent: 0, pending: 0, failed: 0, skipped: 0, replied: 0, hint: 0 };
    for (const it of items) {
      if (it.status === "sent") c.sent++;
      if (it.status === "pending" || it.status === "sending") c.pending++;
      if (it.status === "failed") c.failed++;
      if (it.status === "skipped") c.skipped++;
      if (it.reply_count > 0) c.replied++;
      if (it.payment_status === "hint") c.hint++;
    }
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (filter === "pending") return it.status === "pending" || it.status === "sending";
      if (filter === "sent") return it.status === "sent";
      if (filter === "replied") return it.reply_count > 0;
      if (filter === "hint") return it.payment_status === "hint";
      if (filter === "failed") return it.status === "failed" || it.status === "skipped";
      return true;
    });
  }, [items, filter]);

  async function patchRun(patch: Partial<BillingRun>, okMsg: string) {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("billing_runs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", runId);
    setBusy(false);
    if (err) setError(err.message);
    else setInfo(okMsg);
    await load();
  }

  async function startRun() {
    if (!run) return;
    const { data: others } = await supabase
      .from("billing_runs")
      .select("id, name")
      .in("status", ["running", "paused"])
      .neq("id", runId);
    if (others?.length) {
      setError(
        `Já existe uma lista ativa: "${others[0]!.name}". Pare ou conclua ela antes de iniciar esta.`,
      );
      return;
    }
    if (!counts.pending) {
      setError("Nada na fila para enviar.");
      return;
    }
    const msg = run.is_test
      ? `Iniciar a lista de TESTE (${counts.pending} envio(s))?`
      : `Iniciar o envio de ${counts.pending} cobrança(s) para clientes reais?`;
    if (!window.confirm(msg)) return;
    const now = new Date().toISOString();
    await patchRun(
      {
        status: "running",
        started_at: run.started_at || now,
        next_send_at: now,
        fail_streak: 0,
        pause_reason: "",
        finished_at: null,
      },
      "Lista iniciada — o bot começa em até ~20 s.",
    );
  }

  async function saveInterval() {
    const lo = Math.max(30, Math.round(minS));
    const hi = Math.max(lo, Math.round(maxS));
    await patchRun({ min_interval_s: lo, max_interval_s: hi }, `Intervalo: ${lo}–${hi} s.`);
  }

  async function patchItem(id: string, patch: Partial<BillingItem>, onlyStatus?: BillingItem["status"][]) {
    setBusy(true);
    setError(null);
    let q = supabase
      .from("billing_items")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (onlyStatus?.length) q = q.in("status", onlyStatus);
    const { data, error: err } = await q.select("id");
    setBusy(false);
    if (err) setError(err.message);
    else if (onlyStatus && !data?.length) setError("Não deu: essa cobrança mudou de status (talvez já esteja sendo enviada).");
    await load();
  }

  async function saveText(it: BillingItem) {
    const text = (editing[it.id] ?? it.text).trim();
    if (!text) {
      setError("A mensagem não pode ficar vazia.");
      return;
    }
    await patchItem(it.id, { text, edited: true }, ["pending", "failed", "skipped"]);
    setEditing((e) => {
      const n = { ...e };
      delete n[it.id];
      return n;
    });
  }

  async function addManual() {
    const phone = normalizePhoneDigits(manual.phone);
    if (!phone || phone.length < 10) {
      setError("Telefone inválido (use DDI + DDD + número).");
      return;
    }
    if (!manual.text.trim()) {
      setError("Escreva a mensagem.");
      return;
    }
    setBusy(true);
    const pos = items.reduce((m, it) => Math.max(m, it.position), 0) + 1;
    const { error: err } = await supabase.from("billing_items").insert({
      run_id: runId,
      position: pos,
      customer_name: manual.name.trim() || phone,
      phone_digits: phone,
      text: manual.text.trim(),
      edited: true,
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setManual({ name: "", phone: "", text: "" });
    setShowManual(false);
    setInfo("Cobrança adicionada no fim da fila.");
    await load();
  }

  async function deleteRun() {
    if (!window.confirm("Excluir esta lista e todas as respostas guardadas?")) return;
    setBusy(true);
    const { error: err } = await supabase.from("billing_runs").delete().eq("id", runId);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    router.push("/cobrancas");
  }

  async function openMedia(path: string) {
    const { data, error: err } = await supabase.storage
      .from("billing-replies")
      .createSignedUrl(path, 300);
    if (err || !data?.signedUrl) {
      setError(err?.message || "Não consegui abrir o anexo.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  if (!run) {
    return (
      <div>
        <Link href="/cobrancas" className="text-sm text-zinc-500 hover:underline">
          ← Cobranças
        </Link>
        <p className="mt-4 text-sm text-zinc-500">{error || "Carregando…"}</p>
      </div>
    );
  }

  const progress = counts.total ? Math.round(((counts.sent + counts.failed + counts.skipped) / counts.total) * 100) : 0;
  const canEditList = run.status !== "done";

  return (
    <div>
      <Link href="/cobrancas" className="text-sm text-zinc-500 hover:underline">
        ← Cobranças
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {run.name || "Lista de cobranças"}
            <Badge tone={run.status === "running" ? "info" : run.status === "paused" ? "warn" : run.status === "done" ? "good" : run.status === "stopped" ? "bad" : "neutral"}>
              {BILLING_STATUS_LABEL[run.status]}
            </Badge>
            {run.is_test ? <Badge tone="warn">teste</Badge> : null}
          </span>
        }
        description={
          run.is_test
            ? "Lista de teste: envia de verdade, mas não marca nada como cobrado no estoque."
            : `Formato: ${run.mode}. Ao enviar, as vendas da cobrança ficam marcadas como cobradas.`
        }
        actions={
          <>
            {run.status === "draft" || run.status === "stopped" ? (
              <button type="button" disabled={busy} className={btnDark} onClick={() => void startRun()}>
                {run.status === "draft" ? "Iniciar" : "Retomar"}
              </button>
            ) : null}
            {run.status === "running" ? (
              <button
                type="button"
                disabled={busy}
                className={btnDark}
                onClick={() => void patchRun({ status: "paused", pause_reason: "Pausada no site" }, "Lista pausada.")}
              >
                Pausar
              </button>
            ) : null}
            {run.status === "paused" ? (
              <button
                type="button"
                disabled={busy}
                className={btnDark}
                onClick={() =>
                  void patchRun(
                    { status: "running", pause_reason: "", fail_streak: 0, next_send_at: new Date().toISOString() },
                    "Lista retomada.",
                  )
                }
              >
                Continuar
              </button>
            ) : null}
            {run.status === "running" || run.status === "paused" ? (
              <button
                type="button"
                disabled={busy}
                className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                onClick={() => {
                  if (!window.confirm("Parar a lista? O que estiver na fila não será enviado (dá para retomar depois).")) return;
                  void patchRun({ status: "stopped", pause_reason: "Parada no site" }, "Lista parada.");
                }}
              >
                Parar
              </button>
            ) : null}
            {run.status !== "running" ? (
              <button
                type="button"
                disabled={busy}
                className="rounded-md px-3 py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-100"
                onClick={() => void deleteRun()}
              >
                Excluir
              </button>
            ) : null}
          </>
        }
      />

      {error ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
      ) : null}
      {info ? (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{info}</div>
      ) : null}
      {run.pause_reason && run.status === "paused" ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Pausada: {run.pause_reason}
        </div>
      ) : null}

      <section className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 lg:col-span-2">
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              Enviadas: <strong>{counts.sent}</strong>/{counts.total}
            </span>
            <span>
              Na fila: <strong>{counts.pending}</strong>
            </span>
            <span>
              Falhas: <strong>{counts.failed}</strong>
            </span>
            <span>
              Puladas: <strong>{counts.skipped}</strong>
            </span>
            <span>
              Responderam: <strong>{counts.replied}</strong>
            </span>
            <span>
              Possível pagamento: <strong>{counts.hint}</strong>
            </span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded bg-zinc-100">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Última: {fmtTime(run.last_sent_at)}
            {run.status === "running" && run.next_send_at ? ` · próxima a partir de ${fmtTime(run.next_send_at)}` : ""}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
          <p className="font-medium text-zinc-800">Intervalo entre cobranças</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              min={30}
              value={minS}
              onChange={(e) => setMinS(Number(e.target.value))}
              className="w-20 rounded-md border border-zinc-300 px-2 py-1"
            />
            <span>a</span>
            <input
              type="number"
              min={30}
              value={maxS}
              onChange={(e) => setMaxS(Number(e.target.value))}
              className="w-20 rounded-md border border-zinc-300 px-2 py-1"
            />
            <span>s</span>
            <button type="button" disabled={busy} className={btn} onClick={() => void saveInterval()}>
              Salvar
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500">Mínimo 30 s. Padrão 50–75 s (~1 por minuto).</p>
          {canEditList ? (
            <button type="button" className={`${btn} mt-3`} onClick={() => setShowManual((v) => !v)}>
              {showManual ? "Fechar" : "+ Cobrança manual"}
            </button>
          ) : null}
        </div>
      </section>

      {showManual ? (
        <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              placeholder="Nome"
              value={manual.name}
              onChange={(e) => setManual((m) => ({ ...m, name: e.target.value }))}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
            <input
              placeholder="Telefone (5521999999999)"
              value={manual.phone}
              onChange={(e) => setManual((m) => ({ ...m, phone: e.target.value }))}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>
          <textarea
            placeholder="Mensagem"
            rows={6}
            value={manual.text}
            onChange={(e) => setManual((m) => ({ ...m, text: e.target.value }))}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <button type="button" disabled={busy} className={`${btnDark} mt-2`} onClick={() => void addManual()}>
            Adicionar no fim da fila
          </button>
        </section>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={
              filter === f.id
                ? "rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white"
                : "rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {filtered.map((it) => {
          const rs = repliesByItem.get(it.id) || [];
          const isOpen = open[it.id] || false;
          const isEditing = editing[it.id] != null;
          const editable = it.status === "pending" || it.status === "failed" || it.status === "skipped";
          return (
            <div key={it.id} className="rounded-lg border border-zinc-200 bg-white">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [it.id]: !isOpen }))}
                className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm"
              >
                <span className="w-8 text-zinc-400">{it.position}.</span>
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-900">{it.customer_name}</span>
                <span className="text-xs text-zinc-500">{it.phone_digits}</span>
                {it.total != null ? (
                  <span className="text-xs text-zinc-700">R$ {formatMoneyBr(Number(it.total))}</span>
                ) : null}
                <Badge tone={itemTone(it.status)}>{BILLING_ITEM_STATUS_LABEL[it.status]}</Badge>
                {it.edited ? <Badge>editada</Badge> : null}
                {it.reply_count > 0 ? <Badge tone="info">🟢 {it.reply_count} resp.</Badge> : null}
                {it.payment_status === "hint" ? <Badge tone="good">possível pagamento</Badge> : null}
                {it.payment_status === "confirmed" ? <Badge tone="good">✓ pago</Badge> : null}
              </button>

              {isOpen ? (
                <div className="border-t border-zinc-100 px-3 py-3 text-sm">
                  <div className="mb-2 flex flex-wrap gap-3 text-xs text-zinc-500">
                    <span>Enviada: {fmtTime(it.sent_at)}</span>
                    {it.error ? <span className="text-red-700">Erro: {it.error}</span> : null}
                    {it.customer_id ? (
                      <Link href={`/clientes/${it.customer_id}`} className="text-sky-700 hover:underline">
                        Abrir cliente (dar baixa no pagamento)
                      </Link>
                    ) : null}
                  </div>

                  <div className="grid gap-3 lg:grid-cols-2">
                    <div>
                      <p className="mb-1 text-xs font-medium text-zinc-600">Mensagem</p>
                      {isEditing ? (
                        <textarea
                          rows={14}
                          value={editing[it.id]}
                          onChange={(e) => setEditing((ed) => ({ ...ed, [it.id]: e.target.value }))}
                          className="w-full rounded-md border border-zinc-300 p-2 font-mono text-xs"
                        />
                      ) : (
                        <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-[#e7f6e0] p-3 text-xs text-zinc-900">
                          {it.text}
                        </pre>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {editable && !isEditing ? (
                          <button type="button" className={btn} onClick={() => setEditing((ed) => ({ ...ed, [it.id]: it.text }))}>
                            Editar
                          </button>
                        ) : null}
                        {isEditing ? (
                          <>
                            <button type="button" disabled={busy} className={btn} onClick={() => void saveText(it)}>
                              Salvar texto
                            </button>
                            <button
                              type="button"
                              className={btn}
                              onClick={() =>
                                setEditing((ed) => {
                                  const n = { ...ed };
                                  delete n[it.id];
                                  return n;
                                })
                              }
                            >
                              Cancelar
                            </button>
                          </>
                        ) : null}
                        {it.status === "pending" ? (
                          <button
                            type="button"
                            disabled={busy}
                            className={btn}
                            onClick={() => void patchItem(it.id, { status: "skipped" }, ["pending"])}
                          >
                            Pular
                          </button>
                        ) : null}
                        {it.status === "failed" || it.status === "skipped" ? (
                          <button
                            type="button"
                            disabled={busy}
                            className={btn}
                            onClick={() => {
                              if (
                                it.status === "failed" &&
                                it.error.startsWith("Incerto") &&
                                !window.confirm("Essa pode ter saído. Conferiu no WhatsApp? Voltar pra fila mesmo assim?")
                              ) {
                                return;
                              }
                              void patchItem(it.id, { status: "pending", error: "" }, ["failed", "skipped"]);
                            }}
                          >
                            Voltar pra fila
                          </button>
                        ) : null}
                        {it.status === "sent" && it.payment_status !== "confirmed" ? (
                          <button
                            type="button"
                            disabled={busy}
                            className={btn}
                            onClick={() =>
                              void patchItem(it.id, {
                                payment_status: "confirmed",
                                payment_confirmed_at: new Date().toISOString(),
                              })
                            }
                          >
                            Confirmar pagamento
                          </button>
                        ) : null}
                        {it.payment_status !== "none" ? (
                          <button
                            type="button"
                            disabled={busy}
                            className={btn}
                            onClick={() =>
                              void patchItem(it.id, { payment_status: "none", payment_confirmed_at: null })
                            }
                          >
                            Limpar marca de pagamento
                          </button>
                        ) : null}
                      </div>
                      {it.payment_status === "confirmed" ? (
                        <p className="mt-2 text-xs text-zinc-500">
                          Marca só nesta lista. Para dar baixa (pago + caixinha), use a ficha do cliente ou o evento.
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <p className="mb-1 text-xs font-medium text-zinc-600">Respostas ({rs.length})</p>
                      {!rs.length ? (
                        <p className="text-xs text-zinc-400">Nenhuma resposta ainda.</p>
                      ) : (
                        <ul className="space-y-2">
                          {rs.map((r) => (
                            <li key={r.id} className="rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs">
                              <div className="mb-1 flex justify-between text-zinc-500">
                                <span>{r.kind === "text" ? "Texto" : r.kind}</span>
                                <span>{fmtTime(r.received_at)}</span>
                              </div>
                              {r.text ? <p className="whitespace-pre-wrap text-zinc-900">{r.text}</p> : null}
                              {r.media_path ? (
                                <button
                                  type="button"
                                  className="mt-1 text-sky-700 hover:underline"
                                  onClick={() => void openMedia(r.media_path)}
                                >
                                  Abrir anexo
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {!filtered.length ? <p className="text-sm text-zinc-500">Nada neste filtro.</p> : null}
      </div>
    </div>
  );
}
