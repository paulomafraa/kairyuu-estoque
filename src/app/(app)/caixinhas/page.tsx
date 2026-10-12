"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { createClient } from "@/lib/supabase/client";
import { fetchAllQueryRows } from "@/lib/customers";
import { logStaffAction } from "@/lib/audit";
import type { PhysicalBox } from "@/lib/types";

type LinkedCustomer = {
  id: string;
  name: string;
  phone: string;
  physical_box_id: string | null;
};

type Filter = "todas" | "com_cliente" | "sem_cliente";

function foldText(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function boxError(message: string) {
  if (/physical_box/i.test(message)) {
    return `${message} — rode supabase/migration_physical_boxes.sql no Supabase.`;
  }
  if (/duplicate key|unique/i.test(message)) {
    return "Já existe uma caixinha com esse nome.";
  }
  return message;
}

export default function CaixinhasPage() {
  const supabase = useMemo(() => createClient(), []);
  const [boxes, setBoxes] = useState<PhysicalBox[]>([]);
  const [linked, setLinked] = useState<LinkedCustomer[]>([]);
  const [boxedCountByCustomer, setBoxedCountByCustomer] = useState<
    Record<string, number>
  >({});
  const [meId, setMeId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("todas");
  const [newLabel, setNewLabel] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<LinkedCustomer[]>([]);

  const load = useCallback(async () => {
    setError(null);
    const auth = await supabase.auth.getUser();
    setMeId(auth.data.user?.id ?? null);
    const [bx, cu] = await Promise.all([
      supabase
        .from("physical_boxes")
        .select("*")
        .order("label", { ascending: true })
        .order("id", { ascending: true }),
      supabase
        .from("customers")
        .select("id, name, phone, physical_box_id")
        .not("physical_box_id", "is", null)
        .order("name", { ascending: true }),
    ]);
    if (bx.error) {
      setError(boxError(bx.error.message));
      setLoaded(true);
      return;
    }
    if (cu.error) setError(boxError(cu.error.message));
    const linkedRows = (cu.data || []) as LinkedCustomer[];
    setBoxes((bx.data || []) as PhysicalBox[]);
    setLinked(linkedRows);

    const counts: Record<string, number> = {};
    if (linkedRows.length) {
      const boxedLines = await fetchAllQueryRows<{ customer_id: string | null }>(
        (from, to) =>
          supabase
            .from("event_sale_lines")
            .select("customer_id")
            .eq("boxed", true)
            .eq("cancelled", false)
            .order("id", { ascending: true })
            .range(from, to),
      ).catch(() => [] as { customer_id: string | null }[]);
      for (const l of boxedLines) {
        if (l.customer_id) counts[l.customer_id] = (counts[l.customer_id] || 0) + 1;
      }
    }
    setBoxedCountByCustomer(counts);
    setLoaded(true);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const q = linkQuery.trim();
    if (!linkingId || q.length < 2) return;
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
        .select("id, name, phone, physical_box_id")
        .or(orFilter)
        .order("name", { ascending: true })
        .limit(10);
      if (!cancelled) setLinkResults((data || []) as LinkedCustomer[]);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [linkQuery, linkingId, supabase]);

  const customersByBox = useMemo(() => {
    const map = new Map<string, LinkedCustomer[]>();
    for (const c of linked) {
      if (!c.physical_box_id) continue;
      const list = map.get(c.physical_box_id) || [];
      list.push(c);
      map.set(c.physical_box_id, list);
    }
    return map;
  }, [linked]);

  const labelById = useMemo(
    () => new Map(boxes.map((b) => [b.id, b.label])),
    [boxes],
  );

  const counts = useMemo(() => {
    let comCliente = 0;
    for (const b of boxes) if (customersByBox.has(b.id)) comCliente += 1;
    return {
      todas: boxes.length,
      com_cliente: comCliente,
      sem_cliente: boxes.length - comCliente,
    };
  }, [boxes, customersByBox]);

  const visible = useMemo(() => {
    const q = foldText(search.trim());
    return boxes.filter((b) => {
      const people = customersByBox.get(b.id) || [];
      if (filter === "com_cliente" && people.length === 0) return false;
      if (filter === "sem_cliente" && people.length > 0) return false;
      if (!q) return true;
      if (foldText(b.label).includes(q)) return true;
      return people.some((p) => foldText(p.name).includes(q));
    });
  }, [boxes, customersByBox, filter, search]);

  async function audit(action: string, detail: string, customerId?: string) {
    await logStaffAction(supabase, {
      action,
      detail,
      created_by: meId,
      entity_type: "physical_box",
      customer_id: customerId || null,
    });
    if (customerId) {
      await supabase.from("customer_garage_events").insert({
        customer_id: customerId,
        action,
        detail,
        created_by: meId,
      });
    }
  }

  async function createBox() {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("physical_boxes")
      .insert({ label, created_by: meId });
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    await audit("physical_box_create", `Caixinha física criada · ${label}`);
    setNewLabel("");
    setInfo(`Caixinha "${label}" criada.`);
    await load();
  }

  async function renameBox(box: PhysicalBox) {
    const label = renameValue.trim();
    if (!label || label === box.label) {
      setRenamingId(null);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("physical_boxes")
      .update({ label })
      .eq("id", box.id);
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    await audit(
      "physical_box_rename",
      `Caixinha física renomeada · ${box.label} → ${label}`,
    );
    setRenamingId(null);
    setInfo(`Caixinha renomeada para "${label}".`);
    await load();
  }

  async function deleteBox(box: PhysicalBox) {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("physical_boxes")
      .delete()
      .eq("id", box.id);
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    const people = customersByBox.get(box.id) || [];
    await audit(
      "physical_box_delete",
      `Caixinha física excluída · ${box.label}${
        people.length ? ` · clientes desvinculados: ${people.map((p) => p.name).join(", ")}` : ""
      }`,
    );
    setInfo(`Caixinha "${box.label}" excluída.`);
    await load();
  }

  async function linkCustomer(box: PhysicalBox, customer: LinkedCustomer) {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("customers")
      .update({ physical_box_id: box.id })
      .eq("id", customer.id);
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    const previous =
      customer.physical_box_id && customer.physical_box_id !== box.id
        ? labelById.get(customer.physical_box_id)
        : null;
    await audit(
      "physical_box_link",
      `Vinculado à caixinha física · ${box.label}${previous ? ` (antes: ${previous})` : ""}`,
      customer.id,
    );
    setInfo(`${customer.name} vinculado à caixinha "${box.label}".`);
    setLinkQuery("");
    setLinkResults([]);
    setLinkingId(null);
    await load();
  }

  async function unlinkCustomer(box: PhysicalBox, customer: LinkedCustomer) {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("customers")
      .update({ physical_box_id: null })
      .eq("id", customer.id);
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    await audit(
      "physical_box_unlink",
      `Desvinculado da caixinha física · ${box.label}`,
      customer.id,
    );
    setInfo(`${customer.name} desvinculado da caixinha "${box.label}".`);
    await load();
  }

  return (
    <div>
      <PageHeader
        title="Caixinhas físicas"
        description="Os sacos grandes onde juntamos os envelopes de cada pessoa. A caixinha existe por conta própria: vincule um ou mais clientes quando quiser (ex.: casal na mesma caixinha). As cartas são colocadas na caixa pela ficha do cliente ou pelo evento."
      />

      {error ? (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {info}
        </p>
      ) : null}

      <section className="panel mb-4 flex flex-wrap items-end gap-2">
        <label className="min-w-[14rem] flex-1 text-sm">
          <span className="mb-1 block text-zinc-600">Nova caixinha</span>
          <input
            className="field"
            placeholder="Nome exatamente como está no saco"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createBox();
            }}
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !newLabel.trim()}
          onClick={() => void createBox()}
        >
          Criar caixinha
        </button>
      </section>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="field max-w-xs"
          placeholder="Buscar caixinha ou cliente…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {(
          [
            ["todas", `Todas (${counts.todas})`],
            ["com_cliente", `Com cliente (${counts.com_cliente})`],
            ["sem_cliente", `Sem cliente vinculado (${counts.sem_cliente})`],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={
              filter === key
                ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            }
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {!loaded ? (
        <p className="text-sm text-zinc-500">Carregando…</p>
      ) : visible.length === 0 ? (
        <EmptyState
          title="Nenhuma caixinha encontrada"
          hint={boxes.length === 0 ? "Crie a primeira caixinha acima." : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((box) => {
            const people = customersByBox.get(box.id) || [];
            const inBox = people.reduce(
              (sum, p) => sum + (boxedCountByCustomer[p.id] || 0),
              0,
            );
            const isRenaming = renamingId === box.id;
            const isLinking = linkingId === box.id;
            return (
              <li
                key={box.id}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {isRenaming ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="field"
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void renameBox(box);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                      />
                      <button
                        type="button"
                        className="btn-primary px-2 py-1 text-xs"
                        disabled={busy}
                        onClick={() => void renameBox(box)}
                      >
                        Salvar
                      </button>
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        onClick={() => setRenamingId(null)}
                      >
                        Cancelar
                      </button>
                    </div>
                  ) : (
                    <span className="font-medium text-zinc-900">{box.label}</span>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {people.length > 0 ? (
                      <Badge tone="neutral">{inBox} carta(s) na caixa</Badge>
                    ) : (
                      <Badge tone="warn">sem cliente vinculado</Badge>
                    )}
                    {!isRenaming ? (
                      <button
                        type="button"
                        className="font-medium text-sky-800 underline"
                        onClick={() => {
                          setRenamingId(box.id);
                          setRenameValue(box.label);
                        }}
                      >
                        Renomear
                      </button>
                    ) : null}
                    <ConfirmButton
                      label="Excluir"
                      confirmLabel={
                        people.length
                          ? "Excluir e desvincular os clientes?"
                          : "Excluir caixinha?"
                      }
                      className="font-medium text-red-700 underline"
                      disabled={busy}
                      onConfirm={() => deleteBox(box)}
                    />
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  {people.map((p) => (
                    <span
                      key={p.id}
                      className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5"
                    >
                      <Link
                        href={`/clientes/${p.id}#caixinha-fisica`}
                        className="text-zinc-900 underline decoration-zinc-300 underline-offset-2"
                      >
                        {p.name}
                      </Link>
                      <ConfirmButton
                        label="×"
                        confirmLabel="desvincular?"
                        className="text-xs text-zinc-500 hover:text-red-700"
                        disabled={busy}
                        onConfirm={() => unlinkCustomer(box, p)}
                      />
                    </span>
                  ))}
                  {isLinking ? null : (
                    <button
                      type="button"
                      className="text-xs font-medium text-violet-800 underline"
                      onClick={() => {
                        setLinkingId(box.id);
                        setLinkQuery("");
                        setLinkResults([]);
                      }}
                    >
                      + vincular cliente
                    </button>
                  )}
                </div>

                {isLinking ? (
                  <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="field max-w-sm"
                        placeholder="Nome ou telefone do cliente…"
                        value={linkQuery}
                        autoFocus
                        onChange={(e) => setLinkQuery(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        onClick={() => setLinkingId(null)}
                      >
                        Fechar
                      </button>
                    </div>
                    {linkQuery.trim().length >= 2 && linkResults.length > 0 ? (
                      <ul className="mt-2 space-y-1">
                        {linkResults.map((c) => {
                          const already = c.physical_box_id === box.id;
                          const other =
                            c.physical_box_id && !already
                              ? labelById.get(c.physical_box_id)
                              : null;
                          return (
                            <li
                              key={c.id}
                              className="flex flex-wrap items-center justify-between gap-2 text-sm"
                            >
                              <span>
                                {c.name}
                                <span className="ml-2 text-xs text-zinc-500">
                                  {c.phone}
                                  {other ? ` · hoje na caixinha "${other}"` : ""}
                                </span>
                              </span>
                              {already ? (
                                <span className="text-xs text-zinc-500">já vinculado</span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn-primary px-2 py-1 text-xs"
                                  disabled={busy}
                                  onClick={() => void linkCustomer(box, c)}
                                >
                                  {other ? "Mover para esta" : "Vincular"}
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : linkQuery.trim().length >= 2 ? (
                      <p className="mt-2 text-xs text-zinc-500">
                        Nenhum cliente encontrado.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
