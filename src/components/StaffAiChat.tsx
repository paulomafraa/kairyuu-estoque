"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { ActionProposal, AiChatMessage } from "@/lib/ai/types";
import { formatMoneyBr } from "@/lib/cobranca-msg";

type UiMessage = AiChatMessage & {
  proposals?: ActionProposal[];
  confirmedIds?: string[];
};

const STORAGE_OPEN = "kairyuu_ai_panel_open";

function contextFromPath(pathname: string): {
  customerId?: string;
  eventId?: string;
} {
  const cust = pathname.match(/^\/clientes\/([^/]+)/);
  if (cust?.[1] && cust[1] !== "novo") return { customerId: cust[1] };
  const ev = pathname.match(/^\/eventos\/([^/]+)/);
  if (ev?.[1] && ev[1] !== "novo") return { eventId: ev[1] };
  return {};
}

function proposalLinesPreview(p: ActionProposal): string[] {
  if ("lines" in p && Array.isArray(p.lines)) {
    return p.lines.slice(0, 8).map((l) => {
      const title =
        "product_title" in l ? l.product_title : "title" in l ? String((l as { title?: string }).title) : "";
      const ev = "event_name" in l ? ` · ${l.event_name}` : "";
      return `${title}${ev}`;
    });
  }
  if (p.kind === "ship_garage_items") {
    return p.items.slice(0, 8).map((i) => `${i.title} ×${i.qty}`);
  }
  if (p.kind === "cancel_garage_item") return [p.item_title];
  if (p.kind === "add_customer_note") return [p.body.slice(0, 160)];
  if (p.kind === "set_encomenda_stock") return [p.product_title];
  return [];
}

export function StaffAiChat() {
  const pathname = usePathname();
  const ctx = useMemo(() => contextFromPath(pathname), [pathname]);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([
    {
      role: "assistant",
      content:
        "Oi! Posso consultar clientes, cobranças, caixinha, envios e estoque — e propor ações (pago, cancelar, enviar…). Alterações só valem depois que você confirmar no cartão.",
    },
  ]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_OPEN);
      if (v === "1") setOpen(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_OPEN, open ? "1" : "0");
    } catch {
      // ignore
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, open, busy]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    const nextMessages: UiMessage[] = [
      ...messages,
      { role: "user", content: text },
    ];
    setMessages(nextMessages);
    setBusy(true);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          pagePath: pathname,
          customerId: ctx.customerId,
          eventId: ctx.eventId,
        }),
      });
      const json = (await res.json()) as {
        reply?: string;
        proposals?: ActionProposal[];
        error?: string;
        provider?: string;
        model?: string;
      };
      if (!res.ok) {
        setError(json.error || "Falha na IA.");
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: json.error || "Não consegui responder agora.",
          },
        ]);
        return;
      }
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: json.reply || "",
          proposals: json.proposals || [],
          confirmedIds: [],
        },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function confirmProposal(proposal: ActionProposal, msgIndex: number) {
    if (confirming) return;
    setConfirming(proposal.id);
    setError(null);
    try {
      const res = await fetch("/api/ai/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal }),
      });
      const json = (await res.json()) as { ok?: boolean; message?: string };
      setMessages((prev) => {
        const copy = [...prev];
        const msg = copy[msgIndex];
        if (msg) {
          copy[msgIndex] = {
            ...msg,
            confirmedIds: [...(msg.confirmedIds || []), proposal.id],
          };
        }
        copy.push({
          role: "assistant",
          content: json.message || (json.ok ? "Feito." : "Não aplicado."),
        });
        return copy;
      });
      if (!json.ok) setError(json.message || "Falha ao confirmar.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(null);
    }
  }

  const hints = [
    "Quem deve até o dia 15?",
    "O que falta enviar?",
    "Monta cobrança em aberto",
    "Fulano pagou o leilão X",
  ];

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-40 rounded-full bg-zinc-900 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-zinc-800"
          title="Abrir assistente"
        >
          Assistente IA
        </button>
      ) : null}

      <aside
        className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-[400px] flex-col border-l border-zinc-200 bg-white shadow-xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full pointer-events-none"
        }`}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2.5">
          <div>
            <div className="text-sm font-semibold text-zinc-900">
              Assistente IA
            </div>
            <div className="text-[11px] text-zinc-500">
              {ctx.customerId
                ? "Contexto: ficha do cliente"
                : ctx.eventId
                  ? "Contexto: evento"
                  : "Contexto: geral"}
              {" · "}não bloqueia o site
            </div>
          </div>
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            onClick={() => setOpen(false)}
          >
            Fechar
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
          {messages.map((m, i) => (
            <div
              key={`${i}-${m.role}`}
              className={
                m.role === "user"
                  ? "ml-6 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white"
                  : "mr-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800"
              }
            >
              <div className="whitespace-pre-wrap">{m.content}</div>
              {m.proposals?.map((p) => {
                const done = m.confirmedIds?.includes(p.id);
                const preview = proposalLinesPreview(p);
                return (
                  <div
                    key={p.id}
                    className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-zinc-900"
                  >
                    <div className="text-xs font-semibold">{p.title}</div>
                    <p className="mt-0.5 text-xs text-zinc-700">{p.summary}</p>
                    {preview.length ? (
                      <ul className="mt-1 list-inside list-disc text-[11px] text-zinc-600">
                        {preview.map((line, idx) => (
                          <li key={idx}>{line}</li>
                        ))}
                        {"lines" in p &&
                        Array.isArray(p.lines) &&
                        p.lines.length > 8 ? (
                          <li>… +{p.lines.length - 8} mais</li>
                        ) : null}
                      </ul>
                    ) : null}
                    {p.kind === "mark_paid" && p.total != null ? (
                      <p className="mt-1 text-xs font-medium">
                        Total R$ {formatMoneyBr(p.total)}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-primary px-2 py-1 text-xs"
                        disabled={Boolean(done) || confirming === p.id}
                        onClick={() => void confirmProposal(p, i)}
                      >
                        {done
                          ? "Confirmado"
                          : confirming === p.id
                            ? "Aplicando…"
                            : "Confirmar"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {busy ? (
            <p className="text-xs text-zinc-500">Consultando dados…</p>
          ) : null}
          {error ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">
              {error}
            </p>
          ) : null}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-zinc-200 p-3">
          <div className="mb-2 flex flex-wrap gap-1">
            {hints.map((h) => (
              <button
                key={h}
                type="button"
                className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-50"
                disabled={busy}
                onClick={() => setInput(h)}
              >
                {h}
              </button>
            ))}
          </div>
          <form onSubmit={(e) => void send(e)} className="flex gap-2">
            <textarea
              className="field min-h-[72px] flex-1 resize-none"
              placeholder="Ex.: NooB pagou o leilão de ontem…"
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="submit"
              className="btn-primary self-end"
              disabled={busy || !input.trim()}
            >
              Enviar
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
