"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { createClient } from "@/lib/supabase/client";
import { parseClientsCsv, normalizePhoneDigits } from "@/lib/clients-csv";
import { paymentUrgency } from "@/lib/leilao-resultado";
import type { Customer } from "@/lib/types";

type Filter = "ativos" | "sem_pedidos" | "pendencias" | "todos";

type CustomerRow = Customer & {
  hasOrders: boolean;
  pendencias: number;
  pendenciaLabel: string;
  caixinhaCount: number;
};

export default function ClientesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [csvText, setCsvText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [onlyNew, setOnlyNew] = useState(true);
  const [updateNames, setUpdateNames] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const [
      { data: cu, error: e1 },
      { data: items },
      { data: orders },
      { data: saleLines },
      { data: events },
      { data: garage },
    ] = await Promise.all([
      supabase.from("customers").select("*").order("name"),
      supabase.from("customer_items").select("customer_id"),
      supabase.from("orders").select("customer_id"),
      supabase
        .from("event_sale_lines")
        .select("customer_id, paid, cancelled, charged, separated, event_id"),
      supabase.from("events").select("id, payment_due_at, name"),
      supabase
        .from("customer_garage_items")
        .select("customer_id, status, qty_with_store, qty_sent"),
    ]);
    if (e1) {
      setError(e1.message);
      return;
    }

    const dueByEvent = new Map<string, string | null>();
    for (const ev of events || []) {
      dueByEvent.set(ev.id as string, (ev.payment_due_at as string) || null);
    }

    const activeIds = new Set<string>();
    for (const row of items || []) activeIds.add(row.customer_id);
    for (const row of orders || []) activeIds.add(row.customer_id);
    for (const row of saleLines || []) {
      if (row.customer_id) activeIds.add(row.customer_id as string);
    }
    for (const row of garage || []) activeIds.add(row.customer_id as string);

    const pendByCustomer = new Map<string, { n: number; hints: string[] }>();
    const bump = (id: string, hint: string) => {
      const cur = pendByCustomer.get(id) || { n: 0, hints: [] };
      cur.n += 1;
      if (cur.hints.length < 2) cur.hints.push(hint);
      pendByCustomer.set(id, cur);
    };

    for (const line of saleLines || []) {
      if (!line.customer_id || line.cancelled || line.paid) continue;
      const due = dueByEvent.get(line.event_id as string);
      const u = paymentUrgency(false, false, due);
      if (u === "overdue") bump(line.customer_id as string, "pagamento atrasado");
      else if (u === "warn") bump(line.customer_id as string, "prazo perto");
      else if (!line.charged) bump(line.customer_id as string, "cobrança pendente");
      else bump(line.customer_id as string, "em aberto no evento");
    }

    const garageByCustomer = new Map<string, number>();
    for (const g of garage || []) {
      if (g.status === "cancelled") continue;
      if ((g.qty_with_store as number) > 0) {
        const id = g.customer_id as string;
        garageByCustomer.set(id, (garageByCustomer.get(id) || 0) + 1);
      }
    }

    for (const g of garage || []) {
      if (g.status === "cancelled") continue;
      if ((g.qty_sent as number) > 0) {
        bump(g.customer_id as string, "envio a confirmar/entregar");
      }
    }

    setCustomers(
      ((cu as Customer[]) || []).map((c) => {
        const pend = pendByCustomer.get(c.id);
        return {
          ...c,
          hasOrders: activeIds.has(c.id),
          pendencias: pend?.n || 0,
          pendenciaLabel: pend?.hints.join(" · ") || "",
          caixinhaCount: garageByCustomer.get(c.id) || 0,
        };
      }),
    );
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const digits = normalizePhoneDigits(phone);
    const { data, error: err } = await supabase
      .from("customers")
      .insert({
        name: name.trim(),
        phone: digits || phone.trim(),
        phone_digits: digits || null,
        source: "manual",
        notes: "",
      })
      .select("id")
      .single();
    if (err) {
      setError(err.message);
      return;
    }
    setName("");
    setPhone("");
    window.location.href = `/clientes/${data.id}`;
  }

  async function onImport(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const rows = parseClientsCsv(csvText);
      if (!rows.length) {
        setError("CSV sem linhas válidas (precisa de telefone com 10–15 dígitos).");
        return;
      }

      const { data: existingRows, error: exErr } = await supabase
        .from("customers")
        .select("id, name, phone_digits, phone");
      if (exErr) throw exErr;

      const existingByPhone = new Map<string, { id: string; name: string }>();
      for (const c of existingRows || []) {
        const d =
          (c.phone_digits as string) ||
          normalizePhoneDigits((c.phone as string) || "");
        if (d) {
          existingByPhone.set(d, { id: c.id as string, name: c.name as string });
        }
      }

      const isPhoneAsName = (name: string, phone: string) =>
        normalizePhoneDigits(name) === phone;

      const toInsert: typeof rows = [];
      const toRename: Array<{ id: string; name: string }> = [];
      let skipped = 0;

      for (const r of rows) {
        const prev = existingByPhone.get(r.phone);
        const csvHasRealName = !isPhoneAsName(r.name, r.phone);

        if (!prev) {
          toInsert.push(r);
          continue;
        }

        if (
          updateNames &&
          csvHasRealName &&
          isPhoneAsName(prev.name, r.phone)
        ) {
          // Só troca nome quando o cadastro ainda é o telefone — não sobrescreve nome já organizado.
          toRename.push({ id: prev.id, name: r.name });
          continue;
        }

        if (!onlyNew) {
          // upsert completo: regrava linha
          toInsert.push(r);
          continue;
        }

        skipped += 1;
      }

      // onlyNew: não upsert de quem já existe (toInsert só tem novos neste modo)
      const insertList = onlyNew
        ? toInsert.filter((r) => !existingByPhone.has(r.phone))
        : toInsert;

      if (!insertList.length && !toRename.length) {
        setInfo(
          `Nada a fazer (${skipped} já cadastrados). Para preencher nomes: CSV de \`!exportar-clientes nomes\` + marque “Atualizar nomes”.`,
        );
        return;
      }

      let inserted = 0;
      let named = 0;
      const chunkSize = 100;

      for (let i = 0; i < insertList.length; i += chunkSize) {
        const chunk = insertList.slice(i, i + chunkSize);
        const payload = chunk.map((r) => ({
          name: r.name,
          phone: r.phone,
          phone_digits: r.phone,
          source: "whatsapp_group" as const,
          notes: "",
        }));
        if (onlyNew) {
          const { error: err } = await supabase.from("customers").insert(payload);
          if (err) throw err;
        } else {
          const { error: err } = await supabase
            .from("customers")
            .upsert(payload, { onConflict: "phone_digits" });
          if (err) throw err;
        }
        inserted += chunk.length;
      }

      for (const r of toRename) {
        const { error: err } = await supabase
          .from("customers")
          .update({ name: r.name })
          .eq("id", r.id);
        if (err) throw err;
        named += 1;
      }

      setInfo(
        [
          inserted ? `${inserted} novos` : null,
          named ? `${named} nomes atualizados` : null,
          skipped ? `${skipped} inalterados` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "Concluído.",
      );
      setCsvText("");
      setShowImport(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na importação");
    } finally {
      setBusy(false);
    }
  }

  const filtered = customers.filter((c) => {
    if (filter === "ativos" && !c.hasOrders) return false;
    if (filter === "sem_pedidos" && c.hasOrders) return false;
    if (filter === "pendencias" && c.pendencias <= 0) return false;
    const hay = `${c.name} ${c.phone}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const counts = {
    todos: customers.length,
    ativos: customers.filter((c) => c.hasOrders).length,
    sem_pedidos: customers.filter((c) => !c.hasOrders).length,
    pendencias: customers.filter((c) => c.pendencias > 0).length,
  };

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="Cadastro do grupo e ficha de cada pessoa: Caixinha/garagem (o que está conosco), reservas, envios e cancelamentos. Trocar o nome na ficha substitui o número na lista."
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowImport((v) => !v)}
          >
            {showImport ? "Fechar importação" : "Importar WhatsApp"}
          </button>
        }
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

      {showImport ? (
        <form onSubmit={onImport} className="panel mb-6 space-y-3">
          <h2 className="text-base font-semibold text-zinc-900">
            Importar do grupo (CSV do bot)
          </h2>
          <p className="text-sm text-zinc-600">
            No WhatsApp (adm):{" "}
            <code className="rounded bg-zinc-100 px-1">!exportar-clientes nomes</code>{" "}
            (lista com os nomes que o bot já conhece). Cole o CSV abaixo.
          </p>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={onlyNew}
              onChange={(e) => setOnlyNew(e.target.checked)}
            />
            Somente quem ainda não tem cadastro
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={updateNames}
              onChange={(e) => {
                setUpdateNames(e.target.checked);
                if (e.target.checked) setOnlyNew(false);
              }}
            />
            Atualizar nomes só se o cadastro ainda for o telefone (não sobrescreve nome já preenchido)
          </label>
          <textarea
            className="field min-h-40 font-mono text-xs"
            placeholder={"telefone,nome,jid\n5521999999999,Fulano,..."}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            required
          />
          <label className="block text-sm text-zinc-600">
            Ou escolha o arquivo
            <input
              className="mt-1 block w-full text-sm"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setCsvText(await file.text());
              }}
            />
          </label>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Importando..." : "Importar / atualizar"}
          </button>
        </form>
      ) : null}

      <form onSubmit={onCreate} className="panel mb-6 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Nome</span>
          <input
            className="field"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Telefone / WhatsApp</span>
          <input
            className="field"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn-primary w-full sm:w-auto">
            Cadastrar
          </button>
        </div>
      </form>

      <div className="mb-3 flex flex-wrap gap-2">
        {(
          [
            ["pendencias", `Pendências (${counts.pendencias})`],
            ["ativos", `Ativos (${counts.ativos})`],
            ["sem_pedidos", `Sem pedidos (${counts.sem_pedidos})`],
            ["todos", `Todos (${counts.todos})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={filter === key ? "btn-primary" : "btn-secondary"}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <input
        className="field mb-3 max-w-md"
        placeholder="Buscar cliente..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {filtered.length === 0 ? (
        <EmptyState
          title="Nenhum cliente neste filtro"
          hint="Importe o CSV do grupo ou cadastre manualmente."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Contato</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td
                    className={`font-medium ${c.pendencias ? "text-red-700" : ""}`}
                  >
                    {c.name}
                    {c.pendencias ? (
                      <span className="ml-2 text-xs font-semibold">
                        ({c.pendencias})
                      </span>
                    ) : null}
                  </td>
                  <td>{c.phone || "—"}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {c.pendencias > 0 ? (
                        <Badge tone="bad">Pendência: {c.pendenciaLabel}</Badge>
                      ) : null}
                      {c.caixinhaCount > 0 ? (
                        <Badge tone="info">
                          Caixinha/garagem ({c.caixinhaCount})
                        </Badge>
                      ) : null}
                      {c.hasOrders ? (
                        <Badge tone="good">Ativo</Badge>
                      ) : (
                        <Badge tone="neutral">Sem pedidos</Badge>
                      )}
                      {c.source === "whatsapp_group" ? (
                        <Badge tone="info">Grupo</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/clientes/${c.id}?tab=garagem`}
                        className="btn-primary px-2 py-1 text-xs"
                      >
                        Caixinha/garagem
                      </Link>
                      <Link href={`/clientes/${c.id}`} className="btn-secondary">
                        Ficha
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
