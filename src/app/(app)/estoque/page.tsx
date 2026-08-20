"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { createClient } from "@/lib/supabase/client";
import { logStaffAction } from "@/lib/audit";
import { cardLabel } from "@/lib/labels";
import type { Card } from "@/lib/types";

export default function EstoquePage() {
  const supabase = useMemo(() => createClient(), []);
  const [cards, setCards] = useState<Card[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [setCode, setSetCode] = useState("");
  const [condition, setCondition] = useState("NM");
  const [qty, setQty] = useState(0);
  const [orderable, setOrderable] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSetCode, setEditSetCode] = useState("");
  const [editCondition, setEditCondition] = useState("NM");
  const [editNotes, setEditNotes] = useState("");
  const [editOrderable, setEditOrderable] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("cards")
      .select("*")
      .order("name");
    if (err) setError(err.message);
    else setCards((data as Card[]) || []);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = cards.filter((c) => {
    const hay = `${c.name} ${c.set_code} ${c.condition}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from("cards").insert({
      name: name.trim(),
      set_code: setCode.trim(),
      condition: condition.trim() || "NM",
      qty_in_stock: qty,
      orderable,
      notes: "",
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setName("");
    setSetCode("");
    setCondition("NM");
    setQty(0);
    setOrderable(false);
    await load();
  }

  function startEdit(card: Card) {
    setEditingId(card.id);
    setEditName(card.name);
    setEditSetCode(card.set_code || "");
    setEditCondition(card.condition || "NM");
    setEditNotes(card.notes || "");
    setEditOrderable(card.orderable);
    setInfo(null);
  }

  async function saveEdit(cardId: string) {
    if (!editName.trim()) {
      setError("Nome da carta não pode ficar vazio.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("cards")
      .update({
        name: editName.trim(),
        set_code: editSetCode.trim(),
        condition: editCondition.trim() || "NM",
        notes: editNotes.trim(),
        orderable: editOrderable,
      })
      .eq("id", cardId);
    setBusy(false);
    if (err) setError(err.message);
    else {
      setEditingId(null);
      setInfo("Carta atualizada.");
      const {
        data: { user },
      } = await supabase.auth.getUser();
      await logStaffAction(supabase, {
        action: "estoque_editar",
        detail: `Editou carta: ${editName.trim()}`,
        created_by: user?.id ?? null,
        entity_type: "card",
        entity_id: cardId,
      });
      await load();
    }
  }

  async function adjustQty(card: Card, delta: number) {
    const next = card.qty_in_stock + delta;
    if (next < 0) return;
    setError(null);
    const { error: err } = await supabase
      .from("cards")
      .update({ qty_in_stock: next })
      .eq("id", card.id);
    if (err) {
      setError(err.message);
      return;
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    await supabase.from("stock_movements").insert({
      card_id: card.id,
      qty_delta: delta,
      reason: "adjustment",
      user_id: user?.id ?? null,
      notes: "Ajuste manual no estoque",
    });
    await logStaffAction(supabase, {
      action: "estoque_ajuste",
      detail: `${cardLabel(card)} · ${delta > 0 ? "+" : ""}${delta} · estoque agora ${next}`,
      created_by: user?.id ?? null,
      entity_type: "card",
      entity_id: card.id,
    });
    await load();
  }

  async function toggleOrderable(card: Card) {
    const { error: err } = await supabase
      .from("cards")
      .update({ orderable: !card.orderable })
      .eq("id", card.id);
    if (err) setError(err.message);
    else await load();
  }

  return (
    <div>
      <PageHeader
        title="Estoque"
        description="Quantidade disponível na loja. Cartas encomendáveis podem aparecer mesmo com estoque zero — sem contar como disponível."
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

      <form onSubmit={onCreate} className="panel mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
        <label className="text-sm lg:col-span-2">
          <span className="mb-1 block text-zinc-600">Nome da carta</span>
          <input className="field" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Edição / código</span>
          <input className="field" value={setCode} onChange={(e) => setSetCode(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Condição</span>
          <input className="field" value={condition} onChange={(e) => setCondition(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Qtd</span>
          <input
            className="field"
            type="number"
            min={0}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-col text-sm">
          <span className="mb-1 block text-zinc-600">Opções</span>
          <span className="field flex items-center gap-2">
            <input
              type="checkbox"
              checked={orderable}
              onChange={(e) => setOrderable(e.target.checked)}
            />
            Encomendável
          </span>
        </label>
        <div className="flex flex-col text-sm">
          <span className="mb-1 block select-none text-transparent">Ação</span>
          <button className="btn-primary h-[42px] w-full" disabled={busy} type="submit">
            Adicionar
          </button>
        </div>
      </form>

      <div className="mb-3">
        <input
          className="field max-w-md"
          placeholder="Buscar carta..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="Nenhuma carta ainda" hint="Cadastre a primeira acima." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Carta</th>
                <th>Em estoque</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((card) => {
                const editing = editingId === card.id;
                return (
                  <tr key={card.id}>
                    <td>
                      {editing ? (
                        <div className="grid max-w-lg gap-2">
                          <input
                            className="field"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder="Nome"
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              className="field"
                              value={editSetCode}
                              onChange={(e) => setEditSetCode(e.target.value)}
                              placeholder="Edição / código"
                            />
                            <input
                              className="field"
                              value={editCondition}
                              onChange={(e) => setEditCondition(e.target.value)}
                              placeholder="Condição"
                            />
                          </div>
                          <input
                            className="field"
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                            placeholder="Obs. (opc.)"
                          />
                          <label className="flex items-center gap-2 text-sm text-zinc-700">
                            <input
                              type="checkbox"
                              checked={editOrderable}
                              onChange={(e) => setEditOrderable(e.target.checked)}
                            />
                            Encomendável
                          </label>
                        </div>
                      ) : (
                        <>
                          <div className="font-medium">{cardLabel(card)}</div>
                          {card.notes ? (
                            <div className="text-xs text-zinc-500">{card.notes}</div>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="font-mono text-base">{card.qty_in_stock}</td>
                    <td>
                      {card.qty_in_stock > 0 ? (
                        <Badge tone="good">Disponível</Badge>
                      ) : card.orderable ? (
                        <Badge tone="info">Encomendável</Badge>
                      ) : (
                        <Badge tone="neutral">Sem estoque</Badge>
                      )}
                    </td>
                    <td>
                      {editing ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy}
                            onClick={() => void saveEdit(card.id)}
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
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => startEdit(card)}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => adjustQty(card, -1)}
                          >
                            −1
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => adjustQty(card, 1)}
                          >
                            +1
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => toggleOrderable(card)}
                          >
                            {card.orderable ? "Tirar encomendável" : "Marcar encomendável"}
                          </button>
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
    </div>
  );
}
