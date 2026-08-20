"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { createClient } from "@/lib/supabase/client";
import { ORDER_STATUS_FLOW, ORDER_STATUS_LABEL, cardLabel } from "@/lib/labels";
import type { Card, Customer, Order, OrderStatus, Profile } from "@/lib/types";

function toneFor(status: OrderStatus) {
  if (status === "entregue") return "good" as const;
  if (status === "enviado" || status === "sede_kairyuu") return "info" as const;
  if (status === "chegou_brasil") return "warn" as const;
  return "neutral" as const;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR");
}

function fmtDay(iso: string | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("pt-BR");
}

type GroupMode = "status" | "customer";

export default function EncomendasPage() {
  const supabase = useMemo(() => createClient(), []);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState("Staff");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [cardId, setCardId] = useState("");
  const [cardName, setCardName] = useState("");
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  const [groupMode, setGroupMode] = useState<GroupMode>("status");
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editQty, setEditQty] = useState(1);
  const [editNotes, setEditNotes] = useState("");

  const load = useCallback(async () => {
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

    const [or, cu, cd, profiles] = await Promise.all([
      supabase
        .from("orders")
        .select("*, customers(*), cards(*)")
        .order("created_at", { ascending: false }),
      supabase.from("customers").select("*").order("name"),
      supabase.from("cards").select("*").order("name"),
      supabase.from("profiles").select("id, name"),
    ]);

    const nameById = new Map(
      ((profiles.data || []) as Profile[]).map((p) => [p.id, p.name]),
    );

    if (or.error) setError(or.error.message);
    else {
      setOrders(
        ((or.data as Order[]) || []).map((o) => ({
          ...o,
          created_by_profile: o.created_by
            ? { id: o.created_by, name: nameById.get(o.created_by) || "Staff" }
            : null,
        })),
      );
    }
    setCustomers((cu.data as Customer[]) || []);
    setCards((cd.data as Card[]) || []);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredOrders = useMemo(() => {
    if (!showDateFilter || (!dateFrom && !dateTo)) return orders;
    return orders.filter((o) => {
      const day = o.created_at.slice(0, 10);
      if (dateFrom && day < dateFrom) return false;
      if (dateTo && day > dateTo) return false;
      return true;
    });
  }, [orders, showDateFilter, dateFrom, dateTo]);

  function onPickCard(id: string) {
    setCardId(id);
    const card = cards.find((c) => c.id === id);
    if (card) setCardName(cardLabel(card));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!customerId) {
      setError("Selecione o cliente — toda encomenda precisa de um cliente.");
      return;
    }
    const name =
      cardName.trim() ||
      (cardId ? cardLabel(cards.find((c) => c.id === cardId)!) : "");
    if (!name) {
      setError("Informe o nome da carta");
      return;
    }
    const payload: Record<string, unknown> = {
      customer_id: customerId,
      card_id: cardId || null,
      card_name: name,
      qty,
      status: "pedido_japao",
      stocked: false,
      notes: notes.trim(),
      created_by: meId,
    };
    const { error: err } = await supabase.from("orders").insert(payload);
    if (err) {
      if (String(err.message).includes("created_by")) {
        delete payload.created_by;
        const retry = await supabase.from("orders").insert(payload);
        if (retry.error) setError(retry.error.message);
        else {
          setInfo(
            "Encomenda criada (rode migration_orders_created_by.sql para gravar quem pediu).",
          );
          setCardId("");
          setCardName("");
          setQty(1);
          setNotes("");
          await load();
        }
      } else setError(err.message);
    } else {
      setCardId("");
      setCardName("");
      setQty(1);
      setNotes("");
      setInfo("Encomenda criada.");
      await load();
    }
  }

  async function setStatus(order: Order, status: OrderStatus) {
    setError(null);
    if (status === "sede_kairyuu") {
      const { error: err } = await supabase.rpc("mark_order_arrived_hq", {
        p_order_id: order.id,
      });
      if (err) setError(err.message);
      else await load();
      return;
    }
    if (status === "enviado") {
      const { error: err } = await supabase.rpc("ship_order_to_customer", {
        p_order_id: order.id,
      });
      if (err) setError(err.message);
      else await load();
      return;
    }
    const { error: err } = await supabase
      .from("orders")
      .update({ status })
      .eq("id", order.id);
    if (err) setError(err.message);
    else await load();
  }

  function startEdit(order: Order) {
    setEditingId(order.id);
    setEditName(order.card_name);
    setEditQty(order.qty);
    setEditNotes(order.notes || "");
  }

  async function saveEdit(orderId: string) {
    if (!editName.trim()) {
      setError("Nome da carta não pode ficar vazio.");
      return;
    }
    const { error: err } = await supabase
      .from("orders")
      .update({
        card_name: editName.trim(),
        qty: Math.max(1, editQty),
        notes: editNotes.trim(),
      })
      .eq("id", orderId);
    if (err) setError(err.message);
    else {
      setEditingId(null);
      setInfo("Encomenda atualizada.");
      await load();
    }
  }

  function renderOrderRow(order: Order) {
    const idx = ORDER_STATUS_FLOW.indexOf(order.status);
    const next = ORDER_STATUS_FLOW[idx + 1];
    const editing = editingId === order.id;
    const by =
      order.created_by_profile?.name ||
      (order.created_by ? "Staff" : "não registrado");

    return (
      <li
        key={order.id}
        className="flex flex-col gap-2 border-b border-zinc-100 pb-3 last:border-0 last:pb-0"
      >
        {editing ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block text-zinc-600">Nome da carta</span>
              <input
                className="field"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-600">Qtd</span>
              <input
                className="field"
                type="number"
                min={1}
                value={editQty}
                onChange={(e) => setEditQty(Number(e.target.value))}
              />
            </label>
            <label className="text-sm sm:col-span-3">
              <span className="mb-1 block text-zinc-600">Obs.</span>
              <input
                className="field"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2 sm:col-span-3">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void saveEdit(order.id)}
              >
                Salvar
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setEditingId(null)}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="font-medium text-zinc-900">
                {order.card_name} × {order.qty}
              </div>
              <div className="text-sm text-zinc-600">
                {order.customer_id ? (
                  <Link
                    href={`/clientes/${order.customer_id}`}
                    className="font-medium text-zinc-800 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-700"
                  >
                    {order.customers?.name || "Cliente"}
                  </Link>
                ) : (
                  order.customers?.name || "Cliente"
                )}
                {order.stocked ? " · já no estoque" : ""}
                {order.notes ? ` · ${order.notes}` : ""}
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                Pedido em {fmtDate(order.created_at)} · por {by}
              </div>
              {groupMode === "customer" ? (
                <div className="mt-1">
                  <Badge tone={toneFor(order.status)}>
                    {ORDER_STATUS_LABEL[order.status]}
                  </Badge>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => startEdit(order)}
              >
                Editar
              </button>
              {next ? (
                <ConfirmButton
                  label={`Avançar: ${ORDER_STATUS_LABEL[next]}`}
                  confirmLabel="Confirmar avanço?"
                  className="btn-primary"
                  onConfirm={() => setStatus(order, next)}
                />
              ) : null}
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <div>
      <PageHeader
        title="Encomendas"
        description="Pipeline Japão → Brasil → sede → enviado → entregue. Toda encomenda fica ligada a um cliente. Só entra no estoque na chegada na sede."
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

      <form
        onSubmit={onCreate}
        className="panel mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Cliente</span>
          <select
            className="field"
            required
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">Selecione</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Carta do catálogo (opc.)</span>
          <select
            className="field"
            value={cardId}
            onChange={(e) => onPickCard(e.target.value)}
          >
            <option value="">Sem vínculo / digitar nome</option>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {cardLabel(c)}
                {c.orderable ? " · encomendável" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Nome da carta</span>
          <input
            className="field"
            required
            value={cardName}
            onChange={(e) => setCardName(e.target.value)}
          />
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
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 block text-zinc-600">Obs.</span>
          <input
            className="field"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn-primary">
            Nova encomenda · {meName}
          </button>
        </div>
      </form>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Agrupar por</span>
          <select
            className="field w-auto"
            value={groupMode}
            onChange={(e) => setGroupMode(e.target.value as GroupMode)}
          >
            <option value="status">Status do pipeline</option>
            <option value="customer">Cliente</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={showDateFilter}
            onChange={(e) => {
              setShowDateFilter(e.target.checked);
              if (!e.target.checked) {
                setDateFrom("");
                setDateTo("");
              }
            }}
          />
          Filtrar por data do pedido
        </label>
        {showDateFilter ? (
          <>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-600">De</span>
              <input
                className="field"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-600">Até</span>
              <input
                className="field"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </label>
          </>
        ) : null}
        <Badge tone="neutral">{filteredOrders.length} encomenda(s)</Badge>
      </div>

      {filteredOrders.length === 0 ? (
        <EmptyState title="Nenhuma encomenda" />
      ) : groupMode === "status" ? (
        <div className="space-y-3">
          {ORDER_STATUS_FLOW.map((status) => {
            const group = filteredOrders.filter((o) => o.status === status);
            if (group.length === 0) return null;
            return (
              <section key={status} className="panel">
                <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
                  {ORDER_STATUS_LABEL[status]}
                  <Badge tone={toneFor(status)}>{group.length}</Badge>
                </h2>
                <ul className="space-y-3">{group.map(renderOrderRow)}</ul>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {[...new Map(
            filteredOrders.map((o) => [
              o.customer_id,
              o.customers?.name || "Cliente",
            ]),
          ).entries()]
            .sort((a, b) => a[1].localeCompare(b[1], "pt-BR"))
            .map(([cid, name]) => {
              const group = filteredOrders.filter((o) => o.customer_id === cid);
              return (
                <section key={cid} className="panel">
                  <h2 className="mb-3 flex flex-wrap items-center gap-2 text-base font-semibold">
                    <Link
                      href={`/clientes/${cid}`}
                      className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-700"
                    >
                      {name}
                    </Link>
                    <Badge tone="neutral">{group.length}</Badge>
                    <span className="text-xs font-normal text-zinc-500">
                      {group
                        .map((o) => fmtDay(o.created_at))
                        .filter(Boolean)
                        .slice(0, 1)
                        .map((d) => `desde ${d}`)}
                    </span>
                  </h2>
                  <ul className="space-y-3">{group.map(renderOrderRow)}</ul>
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}
