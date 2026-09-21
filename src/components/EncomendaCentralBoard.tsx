"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/EmptyState";
import { createClient } from "@/lib/supabase/client";
import { fetchAllQueryRows } from "@/lib/customers";
import { eventHappenedOn } from "@/lib/event-date";
import { isShelvedSaleLine } from "@/lib/leilao-resultado";
import type {
  Event,
  EventProductStock,
  EventSaleLine,
  GarageItem,
} from "@/lib/types";

type StockKey = string; // eventId|title

type ProductRow = {
  key: StockKey;
  eventId: string;
  eventName: string;
  eventDate: string | null;
  eventStatus: string;
  title: string;
  people: number;
  ordered: number;
  arrived: number;
  pedidoFeito: boolean;
  shipped: number;
  lines: EventSaleLine[];
};

type EventGroup = {
  eventId: string;
  eventName: string;
  eventDate: string | null;
  eventStatus: string;
  products: ProductRow[];
  ordered: number;
  arrived: number;
  shipped: number;
  pendingPedido: number;
  pendingChegada: number;
};

type Filter =
  | "todos"
  | "pedido_pendente"
  | "chegada_pendente"
  | "envio_pendente"
  | "ok";

function stockKey(eventId: string, title: string): StockKey {
  return `${eventId}|${title}`;
}

function fmtDay(iso: string | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("pt-BR");
}

function lineQty(line: EventSaleLine): number {
  return Number(line.qty) > 0 ? Number(line.qty) : 1;
}

function lineShippedQty(
  line: EventSaleLine,
  garageById: Record<string, GarageItem>,
): number {
  if (!line.garage_item_id) return 0;
  const g = garageById[line.garage_item_id];
  if (!g || g.status === "cancelled") return 0;
  const sent = Number(g.qty_sent) || 0;
  if (sent > 0) return Math.min(lineQty(line), sent);
  if (Number(g.qty_with_store) <= 0 && g.status === "shipped") {
    return lineQty(line);
  }
  if (g.status === "delivered") return lineQty(line);
  return 0;
}

export function EncomendaCentralBoard() {
  const supabase = useMemo(() => createClient(), []);
  const [events, setEvents] = useState<Event[]>([]);
  const [lines, setLines] = useState<EventSaleLine[]>([]);
  const [stock, setStock] = useState<EventProductStock[]>([]);
  const [garageById, setGarageById] = useState<Record<string, GarageItem>>({});
  const [meId, setMeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("todos");
  const [q, setQ] = useState("");
  const [openEvents, setOpenEvents] = useState<Record<string, boolean>>({});
  const [openProducts, setOpenProducts] = useState<Record<string, boolean>>({});
  const didInitOpen = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const auth = await supabase.auth.getUser();
    setMeId(auth.data.user?.id ?? null);

    const [ev, st] = await Promise.all([
      supabase
        .from("events")
        .select("*")
        .eq("kind", "encomenda")
        .order("opened_at", { ascending: false }),
      supabase.from("event_product_stock").select("*"),
    ]);

    const eventList = (ev.data as Event[]) || [];
    const eventIds = eventList.map((e) => e.id);
    let ln: {
      data: EventSaleLine[] | null;
      error: { message: string } | null;
    } = { data: [], error: null };
    if (eventIds.length) {
      try {
        const rows: EventSaleLine[] = [];
        for (let i = 0; i < eventIds.length; i += 80) {
          const chunk = eventIds.slice(i, i + 80);
          const part = await fetchAllQueryRows<EventSaleLine>((from, to) =>
            supabase
              .from("event_sale_lines")
              .select("*, customers(id, name, phone)")
              .in("event_id", chunk)
              .order("created_at", { ascending: true })
              .range(from, to),
          );
          rows.push(...part);
        }
        ln = { data: rows, error: null };
      } catch (e) {
        ln = {
          data: null,
          error: { message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    if (ev.error) setError(ev.error.message);
    if (ln.error) setError(ln.error.message);
    if (st.error && !String(st.error.message || "").includes("does not exist")) {
      setError(st.error.message);
    }

    const saleLines = (ln.data as EventSaleLine[]) || [];
    setEvents(eventList);
    setLines(saleLines);
    setStock((st.data as EventProductStock[]) || []);

    if (!didInitOpen.current && eventList.length) {
      didInitOpen.current = true;
      const first: Record<string, boolean> = {};
      for (const e of eventList.slice(0, 3)) first[e.id] = true;
      setOpenEvents(first);
    }

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
      for (const g of (garageRows as GarageItem[]) || []) map[g.id] = g;
      setGarageById(map);
    } else {
      setGarageById({});
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const stockMap = useMemo(() => {
    const map = new Map<StockKey, EventProductStock>();
    for (const s of stock) {
      map.set(stockKey(s.event_id, s.product_title), s);
    }
    return map;
  }, [stock]);

  const groups = useMemo(() => {
    const byEvent = new Map<string, EventGroup>();
    const eventById = new Map(events.map((e) => [e.id, e]));

    for (const line of lines) {
      if (line.cancelled || isShelvedSaleLine(line, "encomenda")) continue;
      const ev = eventById.get(line.event_id);
      if (!ev) continue;
      let group = byEvent.get(ev.id);
      if (!group) {
        group = {
          eventId: ev.id,
          eventName: ev.name,
          eventDate: eventHappenedOn({
            name: ev.name,
            opened_at: ev.opened_at,
          }),
          eventStatus: ev.status,
          products: [],
          ordered: 0,
          arrived: 0,
          shipped: 0,
          pendingPedido: 0,
          pendingChegada: 0,
        };
        byEvent.set(ev.id, group);
      }

      const title = line.product_title;
      let product = group.products.find((p) => p.title === title);
      if (!product) {
        const st = stockMap.get(stockKey(ev.id, title));
        product = {
          key: stockKey(ev.id, title),
          eventId: ev.id,
          eventName: ev.name,
          eventDate: eventHappenedOn({
            name: ev.name,
            opened_at: ev.opened_at,
          }),
          eventStatus: ev.status,
          title,
          people: 0,
          ordered: 0,
          arrived: 0,
          pedidoFeito: Boolean(st?.pedido_feito),
          shipped: 0,
          lines: [],
        };
        group.products.push(product);
      }
      product.ordered += lineQty(line);
      product.people += 1;
      product.shipped += lineShippedQty(line, garageById);
      const lineArr = Math.max(
        0,
        Math.min(lineQty(line), Number(line.qty_arrived) || 0),
      );
      product.arrived += lineArr;
      product.lines.push(line);
    }

    const list = [...byEvent.values()];
    for (const g of list) {
      g.products.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
      for (const p of g.products) {
        p.lines.sort((a, b) => {
          const na =
            a.customers?.name || a.customer_name_snapshot || a.phone_digits || "";
          const nb =
            b.customers?.name || b.customer_name_snapshot || b.phone_digits || "";
          return na.localeCompare(nb, "pt-BR");
        });
        // Se ainda ninguém marcou por linha, cai no total antigo do produto
        if (p.arrived === 0) {
          const st = stockMap.get(stockKey(g.eventId, p.title));
          p.arrived = Math.min(p.ordered, st?.qty_arrived ?? 0);
        }
        g.ordered += p.ordered;
        g.arrived += p.arrived;
        g.shipped += p.shipped;
        if (!p.pedidoFeito) g.pendingPedido += 1;
        if (p.arrived < p.ordered) g.pendingChegada += 1;
      }
    }
    return list;
  }, [events, lines, stockMap, garageById]);

  const filteredGroups = useMemo(() => {
    const query = q.trim().toLowerCase();
    return groups
      .map((g) => {
        const products = g.products.filter((p) => {
          if (query) {
            const hay = `${g.eventName} ${p.title}`.toLowerCase();
            if (!hay.includes(query)) return false;
          }
          const falta = Math.max(0, p.ordered - p.arrived);
          const envioPendente = p.shipped < p.ordered;
          if (filter === "pedido_pendente") return !p.pedidoFeito;
          if (filter === "chegada_pendente") return falta > 0;
          if (filter === "envio_pendente") return envioPendente;
          if (filter === "ok") {
            return p.pedidoFeito && falta === 0 && p.shipped >= p.ordered;
          }
          return true;
        });
        return { ...g, products };
      })
      .filter((g) => g.products.length > 0);
  }, [groups, filter, q]);

  const totals = useMemo(() => {
    let products = 0;
    let pendingPedido = 0;
    let pendingChegada = 0;
    let pendingEnvio = 0;
    for (const g of groups) {
      for (const p of g.products) {
        products += 1;
        if (!p.pedidoFeito) pendingPedido += 1;
        if (p.arrived < p.ordered) pendingChegada += 1;
        if (p.shipped < p.ordered) pendingEnvio += 1;
      }
    }
    return { products, pendingPedido, pendingChegada, pendingEnvio };
  }, [groups]);

  async function upsertStock(
    eventId: string,
    title: string,
    patch: Partial<EventProductStock>,
  ) {
    setBusy(true);
    setError(null);
    const current = stockMap.get(stockKey(eventId, title));
    const payload: Record<string, unknown> = {
      event_id: eventId,
      product_title: title,
      qty_arrived: current?.qty_arrived ?? 0,
      notes: current?.notes ?? "",
      updated_at: new Date().toISOString(),
      updated_by: meId,
      pedido_feito: current?.pedido_feito ?? false,
      pedido_feito_at: current?.pedido_feito_at ?? null,
      pedido_feito_by: current?.pedido_feito_by ?? null,
      ...patch,
    };
    const { error: err } = await supabase.from("event_product_stock").upsert(
      payload,
      { onConflict: "event_id,product_title" },
    );
    setBusy(false);
    if (err) {
      setError(
        err.message.includes("pedido_feito")
          ? `${err.message} — rode supabase/migration_encomenda_pedido_feito.sql`
          : err.message,
      );
      return;
    }
    setInfo("Atualizado.");
    await load();
  }

  async function setPedidoFeito(
    eventId: string,
    title: string,
    value: boolean,
  ) {
    await upsertStock(eventId, title, {
      pedido_feito: value,
      pedido_feito_at: value ? new Date().toISOString() : null,
      pedido_feito_by: value ? meId : null,
    });
  }

  async function setArrived(eventId: string, title: string, qty: number) {
    await upsertStock(eventId, title, {
      qty_arrived: Math.max(0, Math.floor(qty) || 0),
    });
  }

  if (loading) {
    return <p className="text-sm text-zinc-600">Carregando central…</p>;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {info}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
          <div className="text-xs text-zinc-500">Produtos nas rodadas</div>
          <div className="text-xl font-semibold text-zinc-900">
            {totals.products}
          </div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="text-xs text-amber-800">Pedido JP pendente</div>
          <div className="text-xl font-semibold text-amber-950">
            {totals.pendingPedido}
          </div>
        </div>
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
          <div className="text-xs text-sky-800">Chegada pendente</div>
          <div className="text-xl font-semibold text-sky-950">
            {totals.pendingChegada}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
          <div className="text-xs text-zinc-600">Envio pendente</div>
          <div className="text-xl font-semibold text-zinc-900">
            {totals.pendingEnvio}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[14rem] flex-1 text-sm">
          <span className="mb-1 block text-zinc-600">Buscar</span>
          <input
            className="field"
            placeholder="Rodada ou carta…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        {(
          [
            ["todos", "Todos"],
            ["pedido_pendente", "Falta pedir"],
            ["chegada_pendente", "Falta chegar"],
            ["envio_pendente", "Falta enviar"],
            ["ok", "Tudo ok"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={
              filter === id
                ? "btn-primary px-3 py-2 text-sm"
                : "btn-secondary px-3 py-2 text-sm"
            }
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {filteredGroups.length === 0 ? (
        <EmptyState
          title="Nada por aqui"
          hint="Importe a planilha nas rodadas de encomenda ou ajuste o filtro."
        />
      ) : (
        <ul className="space-y-4">
          {filteredGroups.map((g) => {
            const open = openEvents[g.eventId] !== false;
            return (
              <li
                key={g.eventId}
                className="overflow-hidden rounded-lg border border-zinc-200 bg-white"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 bg-zinc-50 px-4 py-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() =>
                      setOpenEvents((s) => ({
                        ...s,
                        [g.eventId]: !(s[g.eventId] !== false),
                      }))
                    }
                  >
                    <span className="mr-2 text-zinc-400">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="font-semibold text-zinc-900">
                      {g.eventName}
                    </span>
                    <span className="ml-2 text-sm text-zinc-500">
                      {fmtDay(g.eventDate)} · {g.products.length} carta(s)
                    </span>
                  </button>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {!g.pendingPedido && !g.pendingChegada ? (
                      <Badge tone="good">rodada ok</Badge>
                    ) : (
                      <>
                        {g.pendingPedido > 0 ? (
                          <Badge tone="warn">
                            {g.pendingPedido} sem pedido
                          </Badge>
                        ) : null}
                        {g.pendingChegada > 0 ? (
                          <Badge tone="info">
                            {g.pendingChegada} sem chegar
                          </Badge>
                        ) : null}
                      </>
                    )}
                    <Link
                      href={`/eventos/${g.eventId}`}
                      className="btn-secondary px-2 py-1 text-xs"
                    >
                      Abrir rodada
                    </Link>
                  </div>
                </div>

                {open ? (
                  <ul className="divide-y divide-zinc-100">
                    {g.products.map((p) => {
                      const falta = Math.max(0, p.ordered - p.arrived);
                      const prodOpen = Boolean(openProducts[p.key]);
                      return (
                        <li key={p.key} className="px-4 py-3">
                          <div className="flex flex-wrap items-start gap-3">
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() =>
                                setOpenProducts((s) => ({
                                  ...s,
                                  [p.key]: !s[p.key],
                                }))
                              }
                            >
                              <span className="mr-2 text-zinc-400">
                                {prodOpen ? "▾" : "▸"}
                              </span>
                              <span className="font-medium text-zinc-900">
                                {p.title}
                              </span>
                              <span className="mt-0.5 block pl-5 text-xs text-zinc-500">
                                {p.people} pedido(s) · {p.ordered} un.
                                {prodOpen
                                  ? " · ocultar clientes"
                                  : " · ver clientes"}
                              </span>
                            </button>

                            <div className="flex flex-wrap items-center gap-2">
                              <label className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700">
                                <input
                                  type="checkbox"
                                  checked={p.pedidoFeito}
                                  disabled={busy}
                                  onChange={(e) =>
                                    void setPedidoFeito(
                                      p.eventId,
                                      p.title,
                                      e.target.checked,
                                    )
                                  }
                                />
                                Pedido feito
                              </label>

                              <label className="flex items-center gap-1 text-xs text-zinc-600">
                                Chegou
                                <input
                                  className="field w-16 px-2 py-1"
                                  type="number"
                                  min={0}
                                  defaultValue={p.arrived}
                                  key={`${p.key}-arr-${p.arrived}`}
                                  disabled={busy}
                                  onBlur={(e) => {
                                    const v = Number(e.target.value);
                                    if (v !== p.arrived) {
                                      void setArrived(p.eventId, p.title, v);
                                    }
                                  }}
                                />
                              </label>

                              {falta > 0 ? (
                                <Badge tone="warn">falta {falta}</Badge>
                              ) : (
                                <Badge tone="good">chegou</Badge>
                              )}

                              <Badge
                                tone={
                                  p.shipped >= p.ordered
                                    ? "good"
                                    : p.shipped > 0
                                      ? "info"
                                      : "neutral"
                                }
                              >
                                enviado {p.shipped}/{p.ordered}
                              </Badge>

                              <button
                                type="button"
                                className="btn-secondary px-2 py-1 text-xs"
                                disabled={falta === 0 || busy}
                                onClick={() =>
                                  void setArrived(p.eventId, p.title, p.ordered)
                                }
                              >
                                Chegaram todas
                              </button>
                            </div>
                          </div>

                          {prodOpen ? (
                            <ul className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
                              {p.lines.map((line) => {
                                const who =
                                  line.customers?.name ||
                                  line.customer_name_snapshot ||
                                  line.phone_digits ||
                                  "Sem cliente";
                                const phone =
                                  line.customers?.phone ||
                                  line.phone_digits ||
                                  "";
                                const shipped = lineShippedQty(
                                  line,
                                  garageById,
                                );
                                return (
                                  <li
                                    key={line.id}
                                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
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
                                        <span className="font-medium">
                                          {who}
                                        </span>
                                      )}
                                      <div className="text-xs text-zinc-500">
                                        {line.paid
                                          ? "pago"
                                          : line.charged
                                            ? "cobrado"
                                            : "em aberto"}
                                        {shipped > 0
                                          ? ` · enviado ${shipped}`
                                          : ""}
                                      </div>
                                    </div>
                                    <span className="text-xs text-zinc-600">
                                      Qtd {lineQty(line)}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
