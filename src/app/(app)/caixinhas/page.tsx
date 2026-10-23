"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { TypeToConfirmDialog } from "@/components/TypeToConfirmDialog";
import { createClient } from "@/lib/supabase/client";
import { fetchAllQueryRows } from "@/lib/customers";
import { logStaffAction } from "@/lib/audit";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import { daysSincePayment, LEILAO_GARAGE_LIMIT_DAYS } from "@/lib/cobranca-msg";
import { loadBoxHoldings, loadRoundItems, type BoxHoldings, type StoreItem } from "@/lib/box-holdings";
import type { PhysicalBox } from "@/lib/types";

type LinkedCustomer = {
  id: string;
  name: string;
  phone: string;
  physical_box_id: string | null;
  site_user_id?: string | null;
  site_username?: string | null;
  site_email?: string | null;
};

function siteAoLado(p: LinkedCustomer): string {
  if (!p.site_user_id) return "";
  const bits = [
    p.site_email || "",
    p.phone || "",
    p.site_username ? `@${p.site_username.replace(/^@/, "")}` : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

type Filter = "todas" | "com_cliente" | "sem_cliente";

const PAGE_SIZE = 40;

function foldText(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function boxError(message: string) {
  if (
    /physical_box_lines|physical_box_reminders|reminders_enabled|'phone'|'email'/i.test(
      message,
    )
  ) {
    return `${message} — rode supabase/migration_physical_stock.sql no Supabase.`;
  }
  if (/physical_box/i.test(message)) {
    return `${message} — rode supabase/migration_physical_boxes.sql no Supabase.`;
  }
  if (/duplicate key|unique/i.test(message)) {
    return "Já existe uma caixinha com esse nome.";
  }
  return message;
}

function sourceLabel(source: StoreItem["source"]) {
  if (source === "leilao") return "Leilão";
  if (source === "encomenda") return "Encomenda";
  if (source === "venda") return "Venda";
  if (source === "manual") return "Anotado aqui";
  return "Rodada";
}

function WithStoreList({ items }: { items: StoreItem[] }) {
  if (!items.length) {
    return <p className="mt-2 text-xs text-zinc-500">Nada pago com a loja agora.</p>;
  }
  return (
    <ul className="mt-2 space-y-0.5 border-t border-zinc-100 pt-2 text-sm text-zinc-800">
      {items.map((item) => (
        <li key={item.key}>
          {item.title}
          {item.qty > 1 ? ` ×${item.qty}` : ""}
          <span className="ml-2 text-xs text-zinc-500">
            {sourceLabel(item.source)}
            {item.eventName ? ` · ${item.eventName}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
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
  const [page, setPage] = useState(1);
  const [newLabel, setNewLabel] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<LinkedCustomer[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftPhone, setDraftPhone] = useState("");
  const [draftEmail, setDraftEmail] = useState("");
  const [draftReminders, setDraftReminders] = useState(false);
  const [holdings, setHoldings] = useState<BoxHoldings | null>(null);
  const [holdingsBusy, setHoldingsBusy] = useState(false);
  const [lineTitle, setLineTitle] = useState("");
  const [lineQty, setLineQty] = useState("1");
  const [itemsByCustomer, setItemsByCustomer] = useState<Record<string, StoreItem[]>>({});
  const [itemsReady, setItemsReady] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const auth = await supabase.auth.getUser();
    setMeId(auth.data.user?.id ?? null);
    const [bx, cuFirst] = await Promise.all([
      supabase
        .from("physical_boxes")
        .select("*")
        .order("label", { ascending: true })
        .order("id", { ascending: true }),
      supabase
        .from("customers")
        .select(
          "id, name, phone, physical_box_id, site_user_id, site_username, site_email",
        )
        .not("physical_box_id", "is", null)
        .order("name", { ascending: true }),
    ]);
    const cu = cuFirst.error && /site_user_id|site_username|site_email/i.test(cuFirst.error.message)
      ? await supabase
          .from("customers")
          .select("id, name, phone, physical_box_id")
          .not("physical_box_id", "is", null)
          .order("name", { ascending: true })
      : cuFirst;
    if (bx.error) {
      setError(boxError(bx.error.message));
      setLoaded(true);
      return;
    }
    if (cu.error) setError(boxError(cu.error.message));
    const linkedRows = (cu.data || []) as LinkedCustomer[];
    setBoxes((bx.data || []) as PhysicalBox[]);
    setLinked(linkedRows);
    try {
      const round = await loadRoundItems(
        supabase,
        linkedRows.map((p) => ({ id: p.id, name: p.name, phone: p.phone })),
      );
      const byCustomer: Record<string, StoreItem[]> = {};
      for (const item of round) {
        if (!item.customerId) continue;
        const list = byCustomer[item.customerId] || [];
        list.push(item);
        byCustomer[item.customerId] = list;
      }
      setItemsByCustomer(byCustomer);
    } catch (e) {
      setError(boxError(e instanceof Error ? e.message : String(e)));
    }
    setItemsReady(true);

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
    setPage(1);
  }, [search, filter]);

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
    const digits = search.replace(/\D/g, "");
    return boxes.filter((b) => {
      const people = customersByBox.get(b.id) || [];
      if (filter === "com_cliente" && people.length === 0) return false;
      if (filter === "sem_cliente" && people.length > 0) return false;
      if (!q && !digits) return true;
      if (foldText(b.label).includes(q)) return true;
      if (q && foldText(b.email || "").includes(q)) return true;
      if (digits && (b.phone_digits || "").includes(digits)) return true;
      return people.some(
        (p) =>
          foldText(p.name).includes(q) ||
          (digits.length >= 4 && p.phone.replace(/\D/g, "").includes(digits)),
      );
    });
  }, [boxes, customersByBox, filter, search]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const pageIds = pageRows.map((b) => b.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

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
    const phone = newPhone.trim();
    const email = newEmail.trim();
    setBusy(true);
    setError(null);
    const row: Record<string, string | null> = { label, created_by: meId };
    if (phone) {
      row.phone = phone;
      row.phone_digits = normalizePhoneDigits(phone);
    }
    if (email) row.email = email;
    const { error: err } = await supabase.from("physical_boxes").insert(row);
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    await audit("physical_box_create", `Caixinha física criada · ${label}`);
    setNewLabel("");
    setNewPhone("");
    setNewEmail("");
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
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(box.id);
      return next;
    });
    if (openId === box.id) setOpenId(null);
    setInfo(`Caixinha "${box.label}" excluída.`);
    await load();
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    const labels = boxes.filter((b) => selected.has(b.id)).map((b) => b.label);
    const { error: err } = await supabase.from("physical_boxes").delete().in("id", ids);
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    await audit(
      "physical_box_delete",
      `Caixinhas físicas excluídas (${ids.length}) · ${labels.join(", ")}`,
    );
    setSelected(new Set());
    setBulkOpen(false);
    if (openId && ids.includes(openId)) setOpenId(null);
    setInfo(`${ids.length} caixinha(s) excluída(s). Clientes e cartas das rodadas continuam no cadastro.`);
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
    if (openId === box.id) await refreshHoldings(box);
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

  async function refreshHoldings(box: PhysicalBox) {
    setHoldingsBusy(true);
    try {
      const { data: peopleRows } = await supabase
        .from("customers")
        .select("id, name, phone")
        .eq("physical_box_id", box.id);
      const people = ((peopleRows || []) as { id: string; name: string; phone: string }[]).map(
        (p) => ({ id: p.id, name: p.name, phone: p.phone }),
      );
      const result = await loadBoxHoldings(supabase, box, people);
      setHoldings(result);
      if (result.manualError) setError(boxError(result.manualError));
    } catch (e) {
      setHoldings(null);
      setError(boxError(e instanceof Error ? e.message : String(e)));
    } finally {
      setHoldingsBusy(false);
    }
  }

  function openBox(box: PhysicalBox) {
    if (openId === box.id) {
      setOpenId(null);
      setHoldings(null);
      return;
    }
    setOpenId(box.id);
    setDraftPhone(box.phone || "");
    setDraftEmail(box.email || "");
    setDraftReminders(Boolean(box.reminders_enabled));
    setLineTitle("");
    setLineQty("1");
    setHoldings(null);
    void refreshHoldings(box);
  }

  async function saveContact(box: PhysicalBox) {
    const email = draftEmail.trim();
    const phone = draftPhone.trim();
    if (draftReminders && !email.includes("@")) {
      setError("Para ligar os avisos, salve um e-mail nesta caixinha.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("physical_boxes")
      .update({
        phone,
        phone_digits: normalizePhoneDigits(phone),
        email,
        reminders_enabled: Boolean(draftReminders && email.includes("@")),
      })
      .eq("id", box.id);
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    await audit(
      "physical_box_contact",
      `Contato da caixinha · ${box.label}${phone ? ` · ${phone}` : ""}${email ? ` · ${email}` : ""}`,
    );
    setInfo(`Contato de "${box.label}" salvo.`);
    await load();
    await refreshHoldings({
      ...box,
      phone,
      phone_digits: normalizePhoneDigits(phone),
      email,
    });
  }

  async function addLine(box: PhysicalBox) {
    const title = lineTitle.trim();
    const qty = Math.max(1, Math.floor(Number(lineQty) || 1));
    if (!title) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from("physical_box_lines").insert({
      box_id: box.id,
      title,
      qty,
      created_by: meId,
    });
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    setLineTitle("");
    setLineQty("1");
    setInfo(`"${title}" anotado na caixinha "${box.label}".`);
    await refreshHoldings(box);
  }

  async function removeLine(box: PhysicalBox, item: StoreItem) {
    if (!item.manualId) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("physical_box_lines")
      .delete()
      .eq("id", item.manualId);
    setBusy(false);
    if (err) {
      setError(boxError(err.message));
      return;
    }
    await refreshHoldings(box);
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }

  const openBoxRow = boxes.find((b) => b.id === openId) || null;
  const linkedIds = new Set(
    (openBoxRow ? customersByBox.get(openBoxRow.id) || [] : []).map((p) => p.id),
  );
  const phoneMatches = (holdings?.matchedCustomers || []).filter(
    (c) => !linkedIds.has(c.id),
  );

  return (
    <div>
      <PageHeader
        title="Estoque físico"
        description="Os sacos grandes de cada pessoa. Em quem já está vinculado, a lista abaixo é o que está pago e ainda na loja: leilão, encomenda e venda. O que nunca passou por rodada entra em Contato, como linha manual."
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
        <label className="min-w-[10rem] text-sm">
          <span className="mb-1 block text-zinc-600">Telefone (recomendado)</span>
          <input
            className="field"
            placeholder="Com DDD"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
          />
        </label>
        <label className="min-w-[12rem] flex-1 text-sm">
          <span className="mb-1 block text-zinc-600">E-mail (recomendado)</span>
          <input
            className="field"
            placeholder="para o aviso de prazo"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
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
          placeholder="Buscar nome, telefone ou e-mail…"
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
        {selected.size > 0 ? (
          <button
            type="button"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800"
            disabled={busy}
            onClick={() => setBulkOpen(true)}
          >
            Apagar selecionadas ({selected.size})
          </button>
        ) : null}
      </div>

      {visible.length > PAGE_SIZE ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
          >
            Anterior
          </button>
          <span>
            Página {safePage} de {pageCount} · {visible.length} caixinhas
          </span>
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            disabled={safePage >= pageCount}
            onClick={() => setPage(safePage + 1)}
          >
            Próxima
          </button>
          <label className="ml-2 inline-flex items-center gap-1 text-xs">
            <input type="checkbox" checked={allOnPage} onChange={togglePage} />
            Marcar esta página
          </label>
        </div>
      ) : visible.length > 0 ? (
        <label className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-600">
          <input type="checkbox" checked={allOnPage} onChange={togglePage} />
          Marcar todas ({visible.length})
        </label>
      ) : null}

      {!loaded ? (
        <p className="text-sm text-zinc-500">Carregando…</p>
      ) : visible.length === 0 ? (
        <EmptyState
          title="Nenhuma caixinha encontrada"
          hint={boxes.length === 0 ? "Crie a primeira caixinha acima." : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {pageRows.map((box) => {
            const people = customersByBox.get(box.id) || [];
            const inBox = people.reduce(
              (sum, p) => sum + (boxedCountByCustomer[p.id] || 0),
              0,
            );
            const isRenaming = renamingId === box.id;
            const isLinking = linkingId === box.id;
            const isOpen = openId === box.id;
            return (
              <li
                key={box.id}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(box.id)}
                      onChange={() => toggleSelected(box.id)}
                      aria-label={`Selecionar ${box.label}`}
                    />
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
                    {box.phone ? (
                      <span className="text-xs text-zinc-500">{box.phone}</span>
                    ) : null}
                    {box.email ? (
                      <span className="text-xs text-zinc-500">{box.email}</span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {people.length > 0 ? (
                      <Badge tone="neutral">{inBox} carta(s) na caixa</Badge>
                    ) : (
                      <Badge tone="warn">sem cliente vinculado</Badge>
                    )}
                    {box.reminders_enabled ? (
                      <Badge tone="good">avisos ligados</Badge>
                    ) : null}
                    <button
                      type="button"
                      className="font-medium text-violet-800 underline"
                      onClick={() => openBox(box)}
                    >
                      {isOpen ? "Fechar" : "Contato"}
                    </button>
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
                      {siteAoLado(p) ? (
                        <span className="text-xs text-zinc-500">{siteAoLado(p)}</span>
                      ) : null}
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

                {people.length > 0 && itemsReady ? (
                  <WithStoreList
                    items={people.flatMap((p) => itemsByCustomer[p.id] || [])}
                  />
                ) : null}

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

                {isOpen ? (
                  <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="min-w-[10rem] text-sm">
                        <span className="mb-1 block text-zinc-600">Telefone</span>
                        <input
                          className="field"
                          value={draftPhone}
                          onChange={(e) => setDraftPhone(e.target.value)}
                        />
                      </label>
                      <label className="min-w-[14rem] flex-1 text-sm">
                        <span className="mb-1 block text-zinc-600">E-mail</span>
                        <input
                          className="field"
                          value={draftEmail}
                          onChange={(e) => setDraftEmail(e.target.value)}
                        />
                      </label>
                      <label className="flex items-center gap-2 pb-2 text-sm text-zinc-700">
                        <input
                          type="checkbox"
                          checked={draftReminders}
                          disabled={!draftEmail.includes("@")}
                          onChange={(e) => setDraftReminders(e.target.checked)}
                        />
                        Avisos de prazo
                      </label>
                      <button
                        type="button"
                        className="btn-primary px-2 py-1 text-xs"
                        disabled={busy}
                        onClick={() => void saveContact(box)}
                      >
                        Salvar contato
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      Os avisos começam desligados. São 3 e-mails de leilão: 2 semanas,
                      1 semana e 1 dia antes dos 3 meses. Sem e-mail o aviso não liga.
                      Encomenda continua no prazo de chegada (60 a 90 dias), separado deste.
                    </p>

                    {phoneMatches.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-sm">
                        {phoneMatches.map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center gap-2">
                            <span>
                              O telefone também é a ficha de {c.name}
                              {c.phone ? ` · ${c.phone}` : ""}
                            </span>
                            <button
                              type="button"
                              className="text-xs font-medium text-violet-800 underline"
                              disabled={busy}
                              onClick={() =>
                                void linkCustomer(box, {
                                  id: c.id,
                                  name: c.name,
                                  phone: c.phone,
                                  physical_box_id: null,
                                })
                              }
                            >
                              Vincular
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <h3 className="mt-3 text-sm font-semibold text-zinc-900">
                      Com a loja agora
                    </h3>
                    {holdingsBusy ? (
                      <p className="mt-1 text-sm text-zinc-500">Carregando…</p>
                    ) : !holdings || holdings.items.length === 0 ? (
                      <p className="mt-1 text-sm text-zinc-500">
                        Nada pago e ainda na loja por este telefone, e nenhuma linha manual.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-1 text-sm">
                        {holdings.items.map((item) => {
                          const held =
                            item.source === "leilao" ? daysSincePayment(item.sinceIso) : null;
                          const left =
                            held == null ? null : LEILAO_GARAGE_LIMIT_DAYS - held;
                          return (
                            <li
                              key={item.key}
                              className="flex flex-wrap items-center justify-between gap-2"
                            >
                              <span>
                                {item.title}
                                {item.qty > 1 ? ` ×${item.qty}` : ""}
                                <span className="ml-2 text-xs text-zinc-500">
                                  {sourceLabel(item.source)}
                                  {item.eventName ? ` · ${item.eventName}` : ""}
                                  {item.customerName ? ` · ${item.customerName}` : ""}
                                  {left != null
                                    ? left < 0
                                      ? ` · prazo estourado`
                                      : ` · faltam ${left} dia(s)`
                                    : ""}
                                </span>
                              </span>
                              {item.manualId ? (
                                <button
                                  type="button"
                                  className="text-xs text-red-700 underline"
                                  disabled={busy}
                                  onClick={() => void removeLine(box, item)}
                                >
                                  Tirar
                                </button>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <label className="min-w-[14rem] flex-1 text-sm">
                        <span className="mb-1 block text-zinc-600">
                          Linha que não veio de rodada
                        </span>
                        <input
                          className="field"
                          placeholder="Carta ou produto"
                          value={lineTitle}
                          onChange={(e) => setLineTitle(e.target.value)}
                        />
                      </label>
                      <label className="w-20 text-sm">
                        <span className="mb-1 block text-zinc-600">Qtd</span>
                        <input
                          className="field"
                          value={lineQty}
                          onChange={(e) => setLineQty(e.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        disabled={busy || !lineTitle.trim()}
                        onClick={() => void addLine(box)}
                      >
                        Anotar
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {visible.length > PAGE_SIZE ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
          >
            Anterior
          </button>
          <span>
            Página {safePage} de {pageCount}
          </span>
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            disabled={safePage >= pageCount}
            onClick={() => setPage(safePage + 1)}
          >
            Próxima
          </button>
        </div>
      ) : null}

      <TypeToConfirmDialog
        open={bulkOpen}
        title={`Apagar ${selected.size} caixinha(s)`}
        warning="Isso tira as caixinhas da lista e desvincula os clientes. Não apaga a ficha do cliente nem as cartas das rodadas."
        busy={busy}
        error={null}
        onCancel={() => setBulkOpen(false)}
        onConfirm={() => deleteSelected()}
      />
    </div>
  );
}
