"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/Badge";
import { EmptyState } from "@/components/EmptyState";
import type { CustomerShipment, GarageItem } from "@/lib/types";

export type EventBundle = {
  key: string;
  label: string;
  eventId: string | null;
  eventDate: string | null;
  items: GarageItem[];
  qtyStore: number;
  qtySent: number;
};

type Props = {
  garageItems: GarageItem[];
  sentItems: GarageItem[];
  shipments: CustomerShipment[];
  busy?: boolean;
  onCreateShipment: (shippedOn: string, label: string) => Promise<void>;
  onShipEventToShipment: (
    eventKey: string,
    shipmentId: string,
  ) => Promise<void>;
  onAttachSentEventToShipment: (
    eventKey: string,
    shipmentId: string,
  ) => Promise<void>;
  onShipEventAlone: (eventKey: string, shippedOn: string) => Promise<void>;
  onDeleteShipment: (shipmentId: string) => Promise<void>;
};

function fmtDay(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = iso.length <= 10 ? `${iso}T12:00:00` : iso;
  return new Date(d).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function eventBundleKey(item: GarageItem): string {
  if (item.event_id) return `id:${item.event_id}`;
  const name = (item.event_name || "").trim();
  if (name) return `name:${name}|${item.event_date || ""}`;
  return "none:sem-evento";
}

export function eventBundleLabel(item: GarageItem): string {
  const name = (item.event_name || "").trim();
  if (name) return name;
  if (item.event_id) return "Evento";
  return "Sem evento / avulso";
}

export function groupByEvent(items: GarageItem[]): EventBundle[] {
  const map = new Map<string, EventBundle>();
  for (const item of items) {
    const key = eventBundleKey(item);
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        label: eventBundleLabel(item),
        eventId: item.event_id || null,
        eventDate: item.event_date || null,
        items: [],
        qtyStore: 0,
        qtySent: 0,
      };
      map.set(key, row);
    }
    row.items.push(item);
    row.qtyStore += Number(item.qty_with_store) || 0;
    row.qtySent += Number(item.qty_sent) || 0;
  }
  return [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "pt-BR"),
  );
}

export function CustomerShipmentsBoard({
  garageItems,
  sentItems,
  shipments,
  busy,
  onCreateShipment,
  onShipEventToShipment,
  onAttachSentEventToShipment,
  onShipEventAlone,
  onDeleteShipment,
}: Props) {
  const [view, setView] = useState<"quadro" | "lista">("quadro");
  const [shippedOn, setShippedOn] = useState(todayISO());
  const [label, setLabel] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragKind, setDragKind] = useState<"garage" | "sent" | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const garageBundles = useMemo(
    () => groupByEvent(garageItems.filter((i) => i.qty_with_store > 0)),
    [garageItems],
  );

  const looseSentBundles = useMemo(
    () =>
      groupByEvent(
        sentItems.filter((i) => i.qty_sent > 0 && !i.shipment_id),
      ),
    [sentItems],
  );

  const shipmentsSorted = useMemo(
    () =>
      [...shipments].sort((a, b) =>
        b.shipped_on.localeCompare(a.shipped_on),
      ),
    [shipments],
  );

  const itemsByShipment = useMemo(() => {
    const map = new Map<string, GarageItem[]>();
    for (const item of sentItems) {
      if (!item.shipment_id || item.qty_sent <= 0) continue;
      const list = map.get(item.shipment_id) || [];
      list.push(item);
      map.set(item.shipment_id, list);
    }
    return map;
  }, [sentItems]);

  async function handleDropOnShipment(shipmentId: string) {
    if (!dragKey || !dragKind) return;
    setDropTarget(null);
    if (dragKind === "garage") {
      await onShipEventToShipment(dragKey, shipmentId);
    } else {
      await onAttachSentEventToShipment(dragKey, shipmentId);
    }
    setDragKey(null);
    setDragKind(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-zinc-900">Envios</h3>
          <p className="mt-0.5 text-sm text-zinc-600">
            Crie um pacote com a data do envio e arraste os eventos para dentro —
            vários eventos no mesmo dia ficam no mesmo pacote.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={view === "quadro" ? "btn-primary" : "btn-secondary"}
            onClick={() => setView("quadro")}
          >
            Quadro
          </button>
          <button
            type="button"
            className={view === "lista" ? "btn-primary" : "btn-secondary"}
            onClick={() => setView("lista")}
          >
            Lista
          </button>
        </div>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 bg-zinc-50/80 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onCreateShipment(shippedOn, label.trim());
          setLabel("");
        }}
      >
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Data do envio</span>
          <input
            className="field"
            type="date"
            required
            value={shippedOn}
            onChange={(e) => setShippedOn(e.target.value)}
          />
        </label>
        <label className="min-w-[12rem] flex-1 text-sm">
          <span className="mb-1 block text-zinc-600">
            Rótulo (opcional)
          </span>
          <input
            className="field"
            placeholder="Ex.: Correios / mão / reunião"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          Criar pacote de envio
        </button>
      </form>

      {view === "quadro" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
          <div className="space-y-4">
            <section className="rounded-xl border border-dashed border-teal-300/80 bg-gradient-to-b from-teal-50/60 to-white p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-teal-900">
                  Na caixinha (arrastar)
                </h4>
                <Badge tone="info">{garageBundles.length} evento(s)</Badge>
              </div>
              {garageBundles.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  Nada pendente na loja para este cliente.
                </p>
              ) : (
                <ul className="space-y-2">
                  {garageBundles.map((b) => (
                    <li key={b.key}>
                      <div
                        draggable
                        onDragStart={() => {
                          setDragKey(b.key);
                          setDragKind("garage");
                        }}
                        onDragEnd={() => {
                          setDragKey(null);
                          setDragKind(null);
                          setDropTarget(null);
                        }}
                        className="cursor-grab rounded-lg border border-teal-200/80 bg-white p-3 shadow-sm active:cursor-grabbing"
                      >
                        <div className="font-medium text-zinc-900">
                          {b.label}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
                          {b.eventDate ? (
                            <span>{fmtDay(b.eventDate)}</span>
                          ) : null}
                          <span>
                            {b.items.length} item(ns) · {b.qtyStore} un. na loja
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn-secondary px-2 py-1 text-xs"
                            disabled={busy || shipmentsSorted.length === 0}
                            title={
                              shipmentsSorted.length
                                ? "Envia para o pacote mais recente"
                                : "Crie um pacote primeiro"
                            }
                            onClick={() =>
                              void onShipEventToShipment(
                                b.key,
                                shipmentsSorted[0].id,
                              )
                            }
                          >
                            → Pacote mais recente
                          </button>
                          <button
                            type="button"
                            className="btn-primary px-2 py-1 text-xs"
                            disabled={busy}
                            onClick={() =>
                              void onShipEventAlone(b.key, shippedOn)
                            }
                          >
                            Enviar neste dia
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {looseSentBundles.length > 0 ? (
              <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
                <h4 className="mb-2 text-sm font-semibold text-amber-950">
                  Enviados soltos (sem pacote)
                </h4>
                <p className="mb-3 text-xs text-amber-900/80">
                  Já saíram da loja, mas ainda não estão em um pacote com data.
                  Arraste para um pacote para organizar.
                </p>
                <ul className="space-y-2">
                  {looseSentBundles.map((b) => (
                    <li
                      key={b.key}
                      draggable
                      onDragStart={() => {
                        setDragKey(b.key);
                        setDragKind("sent");
                      }}
                      onDragEnd={() => {
                        setDragKey(null);
                        setDragKind(null);
                        setDropTarget(null);
                      }}
                      className="cursor-grab rounded-lg border border-amber-200 bg-white p-3 active:cursor-grabbing"
                    >
                      <div className="font-medium">{b.label}</div>
                      <div className="text-xs text-zinc-500">
                        {b.items.length} item(ns) · {b.qtySent} un. enviadas
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <div className="space-y-3">
            {shipmentsSorted.length === 0 ? (
              <EmptyState
                title="Nenhum pacote ainda"
                hint="Crie um pacote com a data em que o envio saiu. Depois arraste os eventos para dentro."
              />
            ) : (
              shipmentsSorted.map((ship) => {
                const items = itemsByShipment.get(ship.id) || [];
                const bundles = groupByEvent(items);
                const active = dropTarget === ship.id;
                return (
                  <section
                    key={ship.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDropTarget(ship.id);
                    }}
                    onDragLeave={() =>
                      setDropTarget((t) => (t === ship.id ? null : t))
                    }
                    onDrop={(e) => {
                      e.preventDefault();
                      void handleDropOnShipment(ship.id);
                    }}
                    className={`rounded-2xl border-2 p-4 transition ${
                      active
                        ? "border-teal-500 bg-teal-50/70 shadow-md"
                        : "border-zinc-200 bg-white shadow-sm"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">
                          Pacote de envio
                        </p>
                        <h4 className="text-lg font-semibold text-zinc-900">
                          {fmtDay(ship.shipped_on)}
                          {ship.label ? (
                            <span className="ml-2 text-base font-normal text-zinc-500">
                              · {ship.label}
                            </span>
                          ) : null}
                        </h4>
                        <p className="mt-1 text-xs text-zinc-500">
                          {bundles.length} evento(s) · {items.length} item(ns)
                          {dragKey
                            ? " · solte aqui para incluir"
                            : " · arraste eventos para cá"}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        disabled={busy || items.length > 0}
                        title={
                          items.length
                            ? "Esvazie o pacote antes de excluir"
                            : "Excluir pacote vazio"
                        }
                        onClick={() => void onDeleteShipment(ship.id)}
                      >
                        Excluir
                      </button>
                    </div>

                    {bundles.length === 0 ? (
                      <div className="mt-4 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-8 text-center text-sm text-zinc-500">
                        Caixa vazia — solte um evento aqui
                      </div>
                    ) : (
                      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                        {bundles.map((b) => (
                          <li
                            key={b.key}
                            className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-3"
                          >
                            <div className="font-medium text-zinc-900">
                              {b.label}
                            </div>
                            {b.eventDate ? (
                              <div className="text-xs text-zinc-500">
                                Evento: {fmtDay(b.eventDate)}
                              </div>
                            ) : null}
                            <ul className="mt-2 space-y-1 text-sm text-zinc-700">
                              {b.items.map((it) => (
                                <li
                                  key={it.id}
                                  className="flex justify-between gap-2"
                                >
                                  <span className="truncate">{it.title}</span>
                                  <span className="shrink-0 font-mono text-xs text-zinc-500">
                                    ×{it.qty_sent}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {shipmentsSorted.map((ship) => {
            const items = itemsByShipment.get(ship.id) || [];
            const bundles = groupByEvent(items);
            return (
              <div
                key={ship.id}
                className="rounded-lg border border-zinc-200 bg-white p-4"
              >
                <div className="font-medium">
                  {fmtDay(ship.shipped_on)}
                  {ship.label ? ` · ${ship.label}` : ""}
                </div>
                {bundles.length === 0 ? (
                  <p className="mt-2 text-sm text-zinc-500">Vazio</p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm">
                    {bundles.map((b) => (
                      <li key={b.key}>
                        <span className="font-medium">{b.label}</span>
                        <span className="text-zinc-500">
                          {" "}
                          — {b.items.map((i) => i.title).join(", ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          {looseSentBundles.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
              <div className="font-medium">Enviados sem pacote</div>
              <ul className="mt-2 space-y-1 text-sm text-zinc-700">
                {looseSentBundles.map((b) => (
                  <li key={b.key}>
                    {b.label}: {b.items.map((i) => i.title).join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {shipmentsSorted.length === 0 && looseSentBundles.length === 0 ? (
            <EmptyState title="Nenhum envio registrado" />
          ) : null}
        </div>
      )}
    </div>
  );
}
