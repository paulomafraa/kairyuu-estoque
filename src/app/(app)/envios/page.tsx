"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { createClient } from "@/lib/supabase/client";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import {
  daysSincePayment,
  leilaoGarageUrgency,
} from "@/lib/cobranca-msg";
import type { GarageItem, Event } from "@/lib/types";

type OwedRow = GarageItem & {
  customers?: { id: string; name: string; phone: string } | null;
  events?: Pick<Event, "id" | "name" | "opened_at" | "kind" | "status"> | null;
};

type ProductBucket = {
  title: string;
  totalQty: number;
  rows: OwedRow[];
};

type EventGroup = {
  key: string;
  eventId: string | null;
  eventName: string;
  eventDate: string | null;
  kind: string;
  products: ProductBucket[];
  totalQty: number;
};

type LeilaoAlertRow = OwedRow & {
  daysHeld: number;
  urgency: "ok" | "warn" | "overdue" | "none";
};

type LeilaoAlertGroup = {
  key: string;
  eventId: string | null;
  eventName: string;
  eventDate: string | null;
  rows: LeilaoAlertRow[];
  totalQty: number;
  worst: "ok" | "warn" | "overdue";
};

function formatDate(iso: string | null | undefined) {
  if (!iso) return "sem data";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("pt-BR");
}

function looksLikePhoneName(name: string): boolean {
  const digits = normalizePhoneDigits(name);
  return digits.length >= 10 && digits === name.replace(/\D/g, "");
}

function customerLabel(row: OwedRow): string {
  const name = row.customers?.name || "";
  const phone = row.customers?.phone || "";
  if (name && !looksLikePhoneName(name)) {
    return phone ? `${name} (${phone})` : name;
  }
  return phone || name || "—";
}

function isLeilaoRow(row: OwedRow): boolean {
  return row.events?.kind === "leilao" || row.origin === "leilao";
}

/** Janela ~2 meses: evento ou pagamento recente, ou já no prazo de alerta. */
function inLeilaoShipWindow(row: OwedRow, daysHeld: number | null): boolean {
  if (daysHeld != null && daysHeld >= 50) return true;
  const eventIso =
    row.events?.opened_at?.slice(0, 10) || row.event_date || null;
  if (eventIso) {
    const daysEvent = daysSincePayment(`${eventIso}T12:00:00`);
    if (daysEvent != null && daysEvent >= 0 && daysEvent <= 65) return true;
  }
  if (daysHeld != null && daysHeld >= 0 && daysHeld <= 65) return true;
  return false;
}

export default function EnviosPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<OwedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openProducts, setOpenProducts] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("customer_garage_items")
      .select(
        "*, customers(id, name, phone), events(id, name, opened_at, kind, status)",
      )
      .gt("qty_with_store", 0)
      .neq("status", "cancelled")
      .order("updated_at", { ascending: false });

    if (err) setError(err.message);
    else setRows((data as OwedRow[]) || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const byEvent = new Map<
      string,
      {
        meta: Omit<EventGroup, "products" | "totalQty">;
        byProduct: Map<string, ProductBucket>;
      }
    >();

    for (const row of rows) {
      const eventId = row.event_id || row.events?.id || null;
      const eventName =
        row.events?.name || row.event_name || "Sem evento (venda / manual)";
      const eventDate =
        row.events?.opened_at?.slice(0, 10) || row.event_date || null;
      const key = eventId || `manual:${eventName}:${eventDate || ""}`;
      let g = byEvent.get(key);
      if (!g) {
        g = {
          meta: {
            key,
            eventId,
            eventName,
            eventDate,
            kind: row.events?.kind || row.origin || "outro",
          },
          byProduct: new Map(),
        };
        byEvent.set(key, g);
      }
      const title = row.title || "Sem título";
      let bucket = g.byProduct.get(title);
      if (!bucket) {
        bucket = { title, totalQty: 0, rows: [] };
        g.byProduct.set(title, bucket);
      }
      bucket.rows.push(row);
      bucket.totalQty += Number(row.qty_with_store) || 0;
    }

    const list: EventGroup[] = [...byEvent.values()].map((g) => {
      const products = [...g.byProduct.values()];
      products.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
      for (const p of products) {
        p.rows.sort((a, b) =>
          customerLabel(a).localeCompare(customerLabel(b), "pt-BR"),
        );
      }
      return {
        ...g.meta,
        products,
        totalQty: products.reduce((s, p) => s + p.totalQty, 0),
      };
    });

    list.sort((a, b) => {
      const da = a.eventDate || "";
      const db = b.eventDate || "";
      return db.localeCompare(da) || a.eventName.localeCompare(b.eventName, "pt-BR");
    });
    return list;
  }, [rows]);

  const leilaoAlertGroups = useMemo(() => {
    const byEvent = new Map<string, LeilaoAlertGroup>();
    for (const row of rows) {
      if (!isLeilaoRow(row)) continue;
      const daysHeld = daysSincePayment(row.created_at);
      if (!inLeilaoShipWindow(row, daysHeld)) continue;
      const urgency = leilaoGarageUrgency(daysHeld);
      const eventId = row.event_id || row.events?.id || null;
      const eventName =
        row.events?.name || row.event_name || "Leilão sem nome";
      const eventDate =
        row.events?.opened_at?.slice(0, 10) || row.event_date || null;
      const key = eventId || `leilao:${eventName}:${eventDate || ""}`;
      let g = byEvent.get(key);
      if (!g) {
        g = {
          key,
          eventId,
          eventName,
          eventDate,
          rows: [],
          totalQty: 0,
          worst: "ok",
        };
        byEvent.set(key, g);
      }
      const alertRow: LeilaoAlertRow = {
        ...row,
        daysHeld: daysHeld ?? 0,
        urgency,
      };
      g.rows.push(alertRow);
      g.totalQty += Number(row.qty_with_store) || 0;
      if (urgency === "overdue") g.worst = "overdue";
      else if (urgency === "warn" && g.worst !== "overdue") g.worst = "warn";
    }

    const list = [...byEvent.values()];
    for (const g of list) {
      g.rows.sort((a, b) => b.daysHeld - a.daysHeld);
    }
    list.sort((a, b) => {
      const rank = { overdue: 0, warn: 1, ok: 2 };
      return (
        rank[a.worst] - rank[b.worst] ||
        (b.eventDate || "").localeCompare(a.eventDate || "")
      );
    });
    return list;
  }, [rows]);

  const leilaoAlertCount = leilaoAlertGroups.reduce(
    (s, g) => s + g.rows.length,
    0,
  );
  const leilaoUrgentCount = leilaoAlertGroups.reduce(
    (s, g) =>
      s + g.rows.filter((r) => r.urgency === "warn" || r.urgency === "overdue")
        .length,
    0,
  );

  const totalOwed = rows.reduce((s, r) => s + (Number(r.qty_with_store) || 0), 0);

  function toggleProduct(key: string) {
    setOpenProducts((s) => ({ ...s, [key]: !s[key] }));
  }

  return (
    <div>
      <PageHeader
        title="A enviar"
        description="Itens pagos que ainda estão com a loja. Leilão tem prazo de até 2 meses a partir do pagamento; encomendas ficam em lista separada no fluxo geral."
      />

      {error ? (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-zinc-600">
        <Badge tone="warn">{totalOwed} unidade(s) na loja</Badge>
        <Badge tone="neutral">{groups.length} evento(s)</Badge>
        {leilaoUrgentCount > 0 ? (
          <Badge tone="bad">
            {leilaoUrgentCount} leilão perto/passou 2 meses
          </Badge>
        ) : null}
        <button type="button" className="btn-secondary" onClick={() => void load()}>
          Atualizar
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-600">Carregando…</p>
      ) : (
        <>
          {leilaoAlertGroups.length > 0 ? (
            <section className="panel mb-6 border-amber-200 bg-amber-50/40">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">
                    Produtos a enviar · Leilão
                  </h2>
                  <p className="text-sm text-zinc-600">
                    Só leilão · pagos ainda na loja · janela de ~2 meses. O prazo
                    conta a partir da data do pagamento. Amarelo ≈ 50 dias; vermelho
                    ≥ 60 dias.
                  </p>
                </div>
                <Badge tone={leilaoUrgentCount > 0 ? "bad" : "warn"}>
                  {leilaoAlertCount} item(ns)
                </Badge>
              </div>

              <div className="space-y-4">
                {leilaoAlertGroups.map((g) => (
                  <div
                    key={g.key}
                    className="rounded-md border border-zinc-200 bg-white px-3 py-3"
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-medium text-zinc-900">
                          Produtos do leilão do dia {formatDate(g.eventDate)}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {g.eventName} · {g.totalQty} un.
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {g.worst === "overdue" ? (
                          <Badge tone="bad">Prazo estourado</Badge>
                        ) : g.worst === "warn" ? (
                          <Badge tone="warn">Perto do prazo</Badge>
                        ) : (
                          <Badge tone="neutral">No prazo</Badge>
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
                    <ul className="space-y-2">
                      {g.rows.map((item) => (
                        <li
                          key={item.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-100 px-2 py-2 text-sm"
                        >
                          <div>
                            <div className="font-medium">{item.title}</div>
                            <div className="text-xs text-zinc-500">
                              {item.customer_id ? (
                                <Link
                                  href={`/clientes/${item.customer_id}`}
                                  className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-700"
                                >
                                  {customerLabel(item)}
                                </Link>
                              ) : (
                                customerLabel(item)
                              )}
                              {" · "}
                              {item.qty_with_store} un. · há {item.daysHeld} dia(s)
                              na loja (desde o pagamento)
                            </div>
                          </div>
                          {item.urgency === "overdue" ? (
                            <Badge tone="bad">Enviar</Badge>
                          ) : item.urgency === "warn" ? (
                            <Badge tone="warn">Atenção</Badge>
                          ) : (
                            <Badge tone="info">{item.daysHeld}d</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {groups.length === 0 ? (
            <EmptyState
              title="Nada pendente de envio"
              hint="Quando marcar pago num evento, o item entra na Caixinha/garagem do cliente até você registrar o envio."
            />
          ) : (
            <div className="space-y-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                Todos os eventos (leilão + encomenda + outros)
              </h2>
              {groups.map((g) => (
                <section key={g.key} className="panel">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 className="text-lg font-semibold text-zinc-900">
                        {g.eventName}
                      </h2>
                      <p className="text-sm text-zinc-600">
                        {formatDate(g.eventDate)}
                        {g.kind ? ` · ${g.kind}` : ""} · {g.totalQty} un. a enviar ·{" "}
                        {g.products.length} produto(s)
                      </p>
                    </div>
                    {g.eventId ? (
                      <Link className="btn-secondary" href={`/eventos/${g.eventId}`}>
                        Abrir evento
                      </Link>
                    ) : null}
                  </div>

                  <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
                    {g.products.map((p) => {
                      const pk = `${g.key}::${p.title}`;
                      const open = Boolean(openProducts[pk]);
                      return (
                        <li key={pk}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-zinc-50"
                            onClick={() => toggleProduct(pk)}
                            aria-expanded={open}
                          >
                            <div>
                              <div className="font-medium text-zinc-900">
                                {p.title}
                              </div>
                              <div className="text-xs text-zinc-500">
                                {p.rows.length} cliente(s) · {p.totalQty} un. na loja
                                {open ? "" : " · clique para ver quem pediu"}
                              </div>
                            </div>
                            <span className="text-sm text-zinc-500">
                              {open ? "▾" : "▸"}
                            </span>
                          </button>
                          {open ? (
                            <ul className="space-y-2 bg-zinc-50 px-3 pb-3">
                              {p.rows.map((item) => (
                                <li
                                  key={item.id}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                                >
                                  <div>
                                    {item.customer_id ? (
                                      <Link
                                        href={`/clientes/${item.customer_id}`}
                                        className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-700"
                                      >
                                        {customerLabel(item)}
                                      </Link>
                                    ) : (
                                      <span className="font-medium">
                                        {customerLabel(item)}
                                      </span>
                                    )}
                                    <div className="text-xs text-zinc-500">
                                      Com a loja: {item.qty_with_store}
                                      {isLeilaoRow(item) ? (
                                        <>
                                          {" · "}
                                          {daysSincePayment(item.created_at) ?? "?"}d
                                          desde pagamento
                                        </>
                                      ) : null}
                                    </div>
                                  </div>
                                  {item.customer_id ? (
                                    <Link
                                      className="btn-secondary px-2 py-1 text-xs"
                                      href={`/clientes/${item.customer_id}?tab=garagem`}
                                    >
                                      Caixinha/garagem
                                    </Link>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
