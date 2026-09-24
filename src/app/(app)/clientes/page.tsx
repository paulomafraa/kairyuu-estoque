"use client";

import Link from "next/link";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { FileDropZone } from "@/components/FileDropZone";
import { createClient } from "@/lib/supabase/client";
import { parseClientsCsv, normalizePhoneDigits } from "@/lib/clients-csv";
import {
  buildPhoneLookup,
  customerPhoneDigits,
  ensureCustomerByPhone,
  fetchAllCustomers,
  fetchAllQueryRows,
  normalizeSearchHay,
  phoneInLookup,
  phoneVariants,
} from "@/lib/customers";
import {
  daysSincePayment,
  formatLeilaoGarageDeadline,
  leilaoGarageUrgency,
} from "@/lib/cobranca-msg";
import {
  isActiveBillableSaleLine,
  paymentUrgency,
} from "@/lib/leilao-resultado";
import type { Customer } from "@/lib/types";

type Filter =
  | "ativos"
  | "sem_pedidos"
  | "pendencias"
  | "todos"
  | "prazo_leilao"
  | "inativos_grupo";

type SilentGroupMember = {
  phone_digits: string;
  name: string;
  message_count: number;
  synced_at: string;
  searchHay: string;
};

/** Limiar alinhado ao default do !inativos loja (≤5 msgs). */
const INACTIVE_MSG_MAX = 5;
/** Evita montar milhares de <tr> a cada tecla da busca. */
const LIST_RENDER_LIMIT = 80;
/** Só filtra a lista depois que a digitação para. Enter aplica na hora. */
const SEARCH_IDLE_MS = 1000;

function CustomerSearchField({
  applied,
  onSearch,
}: {
  applied: string;
  onSearch: (q: string) => void;
}) {
  const [value, setValue] = useState(applied);
  const onSearchRef = useRef(onSearch);
  const skipIdle = useRef(true);
  onSearchRef.current = onSearch;

  useEffect(() => {
    if (skipIdle.current) {
      skipIdle.current = false;
      return;
    }
    const t = window.setTimeout(
      () => onSearchRef.current(value),
      SEARCH_IDLE_MS,
    );
    return () => window.clearTimeout(t);
  }, [value]);

  const pending = value.trim() !== applied.trim();

  return (
    <div className="mb-3 max-w-md">
      <input
        className="field"
        placeholder="Buscar cliente..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          onSearch(value);
        }}
      />
      {pending ? (
        <p className="mt-1 text-xs text-zinc-500">
          A lista atualiza quando você parar de digitar, ou aperte Enter.
        </p>
      ) : null}
    </div>
  );
}

type CustomerRow = Customer & {
  hasOrders: boolean;
  pendencias: number;
  pendenciaLabel: string;
  caixinhaCount: number;
  searchHay: string;
  searchDigits: string;
  silentInactive: boolean;
  leilaoGarage?: {
    count: number;
    worst: "ok" | "warn" | "overdue";
    oldestDays: number;
    sinceIso: string;
    shortLabel: string;
  } | null;
};

export default function ClientesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [lowActivityByPhone, setLowActivityByPhone] = useState<
    Map<string, number>
  >(() => new Map());
  const [silentUnregistered, setSilentUnregistered] = useState<
    SilentGroupMember[]
  >([]);
  const [groupSyncAt, setGroupSyncAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");
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
    let cu: Customer[] = [];
    try {
      cu = await fetchAllCustomers(supabase);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    const [
      { data: items },
      { data: orders },
      unpaidLines,
      { data: events },
      { data: garage },
      { data: groupActivity, error: groupErr },
    ] = await Promise.all([
      supabase.from("customer_items").select("customer_id"),
      supabase.from("orders").select("customer_id"),
      fetchAllQueryRows<{
        customer_id: string | null;
        paid: boolean;
        cancelled: boolean;
        charged: boolean;
        separated: boolean;
        event_id: string;
        archived: boolean | null;
        import_status?: string;
        certainty?: string;
        phone_digits: string | null;
        valor_ou_opcao: string | null;
        notes: string | null;
      }>((from, to) =>
        supabase
          .from("event_sale_lines")
          .select(
            "id, customer_id, paid, cancelled, charged, separated, event_id, archived, import_status, certainty, phone_digits, valor_ou_opcao, notes",
          )
          .eq("cancelled", false)
          .eq("paid", false)
          .order("id", { ascending: true })
          .range(from, to),
      ).catch((e) => {
        console.error(e);
        return [];
      }),
      supabase.from("events").select("id, payment_due_at, name, kind"),
      supabase
        .from("customer_garage_items")
        .select(
          "customer_id, status, qty_with_store, qty_sent, origin, created_at, title",
        ),
      supabase
        .from("whatsapp_group_activity")
        .select("phone_digits, name, message_count, present, synced_at")
        .eq("group_alias", "loja")
        .eq("present", true)
        .lte("message_count", INACTIVE_MSG_MAX)
        .order("message_count", { ascending: true }),
    ]);

    let lowActivityRows: SilentGroupMember[] = [];
    let silentLookup = new Set<string>();
    if (groupErr) {
      // migration ainda não rodada — filtro inativos fica vazio
      console.warn("whatsapp_group_activity:", groupErr.message);
      setLowActivityByPhone(new Map());
      setSilentUnregistered([]);
      setGroupSyncAt(null);
    } else {
      lowActivityRows = (groupActivity || []).map((r) => {
        const row = r as Omit<SilentGroupMember, "searchHay">;
        return {
          ...row,
          searchHay: normalizeSearchHay(`${row.name} ${row.phone_digits}`),
        };
      });
      const phones = new Set(
        lowActivityRows
          .map((r) => normalizePhoneDigits(r.phone_digits))
          .filter(Boolean),
      );
      silentLookup = buildPhoneLookup(phones);
      const msgMap = new Map<string, number>();
      for (const r of lowActivityRows) {
        const d = normalizePhoneDigits(r.phone_digits);
        if (!d) continue;
        for (const v of phoneVariants(d)) msgMap.set(v, r.message_count);
      }
      setLowActivityByPhone(msgMap);
      let latest: string | null = null;
      for (const r of lowActivityRows) {
        if (!latest || (r.synced_at && r.synced_at > latest)) {
          latest = r.synced_at;
        }
      }
      setGroupSyncAt(latest);
    }

    const dueByEvent = new Map<string, string | null>();
    const kindByEvent = new Map<string, string | null>();
    for (const ev of events || []) {
      dueByEvent.set(ev.id as string, (ev.payment_due_at as string) || null);
      kindByEvent.set(ev.id as string, (ev.kind as string) || "leilao");
    }

    const activeIds = new Set<string>();
    for (const row of items || []) activeIds.add(row.customer_id);
    for (const row of orders || []) activeIds.add(row.customer_id);
    for (const row of unpaidLines || []) {
      if (row.customer_id) activeIds.add(row.customer_id);
    }
    for (const row of garage || []) activeIds.add(row.customer_id as string);

    const pendByCustomer = new Map<string, { n: number; hints: string[] }>();
    const bump = (id: string, hint: string) => {
      const cur = pendByCustomer.get(id) || { n: 0, hints: [] };
      cur.n += 1;
      if (cur.hints.length < 2) cur.hints.push(hint);
      pendByCustomer.set(id, cur);
    };

    for (const line of unpaidLines || []) {
      if (!line.customer_id || line.paid) continue;
      const kind = kindByEvent.get(line.event_id as string);
      if (!isActiveBillableSaleLine(line, kind)) continue;
      const due = dueByEvent.get(line.event_id as string);
      const u = paymentUrgency(false, false, due);
      if (u === "overdue") bump(line.customer_id as string, "pagamento atrasado");
      else if (u === "warn") bump(line.customer_id as string, "prazo perto");
      else if (!line.charged) bump(line.customer_id as string, "cobrança pendente");
      else bump(line.customer_id as string, "em aberto no evento");
    }

    const garageByCustomer = new Map<string, number>();
    type LeilaoAgg = {
      count: number;
      worst: "ok" | "warn" | "overdue";
      oldestDays: number;
      sinceIso: string;
    };
    const leilaoByCustomer = new Map<string, LeilaoAgg>();
    const worstRank = { overdue: 0, warn: 1, ok: 2 } as const;

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
      if (
        g.origin === "leilao" &&
        (g.qty_with_store as number) > 0
      ) {
        const daysHeld = daysSincePayment(g.created_at as string);
        if (daysHeld == null) continue;
        const urgency = leilaoGarageUrgency(daysHeld);
        const id = g.customer_id as string;
        const prev = leilaoByCustomer.get(id);
        if (!prev) {
          leilaoByCustomer.set(id, {
            count: 1,
            worst: urgency === "none" ? "ok" : urgency,
            oldestDays: daysHeld,
            sinceIso: g.created_at as string,
          });
        } else {
          prev.count += 1;
          if (daysHeld > prev.oldestDays) {
            prev.oldestDays = daysHeld;
            prev.sinceIso = g.created_at as string;
          }
          const next = urgency === "none" ? "ok" : urgency;
          if (worstRank[next] < worstRank[prev.worst]) prev.worst = next;
        }
        if (urgency === "overdue") {
          bump(id, "leilão: prazo 2 meses estourado");
        } else if (urgency === "warn") {
          bump(id, "leilão: perto do prazo de envio");
        }
      }
    }

    const mapped = cu.map((c) => {
      const pend = pendByCustomer.get(c.id);
      const leilao = leilaoByCustomer.get(c.id);
      const deadline = leilao
        ? formatLeilaoGarageDeadline({
            daysHeld: leilao.oldestDays,
            sinceIso: leilao.sinceIso,
          })
        : null;
      const digits = customerPhoneDigits(c);
      return {
        ...c,
        hasOrders: activeIds.has(c.id),
        pendencias: pend?.n || 0,
        pendenciaLabel: pend?.hints.join(" · ") || "",
        caixinhaCount: garageByCustomer.get(c.id) || 0,
        searchHay: normalizeSearchHay(
          `${c.name || ""} ${c.phone || ""} ${c.phone_digits || ""}`,
        ),
        searchDigits: digits,
        silentInactive: phoneInLookup(digits, silentLookup),
        leilaoGarage: leilao
          ? {
              count: leilao.count,
              worst: leilao.worst,
              oldestDays: leilao.oldestDays,
              sinceIso: leilao.sinceIso,
              shortLabel: deadline?.shortLabel || "",
            }
          : null,
      };
    });
    setCustomers(mapped);

    if (!groupErr && lowActivityRows.length) {
      const customerLookup = buildPhoneLookup(
        mapped.map((c) => c.searchDigits),
      );
      setSilentUnregistered(
        lowActivityRows.filter(
          (r) => !phoneInLookup(r.phone_digits, customerLookup),
        ),
      );
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const digits = normalizePhoneDigits(phone);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Informe o nome do cliente.");
      return;
    }
    if (!digits || digits.length < 10 || digits.length > 15) {
      setError(
        "Informe o WhatsApp com DDD (10–15 dígitos). Sem telefone o cliente some das buscas de associação.",
      );
      return;
    }
    try {
      const { customer, created, renamed } = await ensureCustomerByPhone(
        supabase,
        { name: trimmedName, phoneDigits: digits },
      );
      if (!created && !renamed) {
        setInfo(
          `Esse WhatsApp já existia como “${customer.name}”. Abrindo a ficha.`,
        );
      } else if (renamed) {
        setInfo(`Cadastro atualizado para “${customer.name}”.`);
      }
      setName("");
      setPhone("");
      window.location.href = `/clientes/${customer.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  const qNorm = useMemo(
    () => normalizeSearchHay(search.trim()),
    [search],
  );
  const qDigits = useMemo(
    () => normalizePhoneDigits(search),
    [search],
  );

  const matchesSearch = useCallback(
    (hay: string, digits: string) => {
      if (!qNorm && qDigits.length < 3) return true;
      if (qDigits.length >= 3 && digits.includes(qDigits)) return true;
      return qNorm ? hay.includes(qNorm) : true;
    },
    [qNorm, qDigits],
  );

  const filtered = useMemo(() => {
    const rows = customers.filter((c) => {
      if (filter === "ativos" && !c.hasOrders) return false;
      if (filter === "sem_pedidos" && c.hasOrders) return false;
      if (filter === "pendencias" && c.pendencias <= 0) return false;
      if (
        filter === "prazo_leilao" &&
        !(
          c.leilaoGarage &&
          (c.leilaoGarage.worst === "warn" || c.leilaoGarage.worst === "overdue")
        )
      ) {
        return false;
      }
      if (filter === "inativos_grupo" && !c.silentInactive) return false;
      return matchesSearch(c.searchHay, c.searchDigits);
    });
    if (filter !== "inativos_grupo") return rows;
    return [...rows].sort((a, b) => {
      const ma = lowActivityByPhone.get(a.searchDigits) ?? 9999;
      const mb = lowActivityByPhone.get(b.searchDigits) ?? 9999;
      return ma - mb || a.name.localeCompare(b.name, "pt-BR");
    });
  }, [customers, filter, matchesSearch, lowActivityByPhone]);

  const inactiveUnregisteredFiltered = useMemo(
    () =>
      [...silentUnregistered]
        .sort((a, b) => a.message_count - b.message_count)
        .filter((r) => matchesSearch(r.searchHay, r.phone_digits)),
    [silentUnregistered, matchesSearch],
  );

  const counts = useMemo(() => {
    let ativos = 0;
    let semPedidos = 0;
    let pendencias = 0;
    let prazoLeilao = 0;
    let inativosGrupo = 0;
    for (const c of customers) {
      if (c.hasOrders) ativos += 1;
      else semPedidos += 1;
      if (c.pendencias > 0) pendencias += 1;
      if (
        c.leilaoGarage &&
        (c.leilaoGarage.worst === "warn" || c.leilaoGarage.worst === "overdue")
      ) {
        prazoLeilao += 1;
      }
      if (c.silentInactive) inativosGrupo += 1;
    }
    return {
      todos: customers.length,
      ativos,
      sem_pedidos: semPedidos,
      pendencias,
      prazo_leilao: prazoLeilao,
      inativos_grupo: inativosGrupo + silentUnregistered.length,
    };
  }, [customers, silentUnregistered]);

  const shown = filtered.slice(0, LIST_RENDER_LIMIT);

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="Cadastro do grupo e ficha de cada pessoa: Caixinha/garagem (o que está conosco), reservas, envios e cancelamentos. Trocar o nome na ficha substitui o número na lista."
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowImport((v) => !v)}
          >
            {showImport ? "Fechar importação" : "Importar CSV WhatsApp"}
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
            (lista com os nomes que o bot já conhece). Arraste o CSV ou cole o
            texto abaixo.
          </p>
          <FileDropZone
            accept=".csv,text/csv,text/plain"
            disabled={busy}
            title="Solte o CSV de clientes aqui"
            hint="Arquivo exportado pelo bot (!exportar-clientes nomes)."
            onFile={async (file) => {
              setCsvText(await file.text());
              setShowImport(true);
              setInfo(`Arquivo carregado: ${file.name}`);
            }}
          />
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
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Importando..." : "Importar / atualizar"}
          </button>
        </form>
      ) : (
        <div
          className="panel mb-6"
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (!file) return;
            setShowImport(true);
            setCsvText(await file.text());
            setInfo(`Arquivo carregado: ${file.name}`);
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-zinc-900">
                Importar CSV de clientes
              </div>
              <p className="mt-0.5 text-sm text-zinc-600">
                Arraste o arquivo pra cá ou use o botão{" "}
                <strong>Importar CSV WhatsApp</strong>.
              </p>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowImport(true)}
            >
              Abrir importação
            </button>
          </div>
        </div>
      )}

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
          <span className="mb-1 block text-zinc-600">
            Telefone / WhatsApp (obrigatório)
          </span>
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
            [
              "prazo_leilao",
              `Leilão · prazo 2 meses (${counts.prazo_leilao})`,
            ],
            [
              "inativos_grupo",
              `Inativos do grupo (${counts.inativos_grupo})`,
            ],
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

      {filter === "inativos_grupo" ? (
        <p className="mb-3 text-sm text-zinc-600">
          Baixa atividade no grupo (≤{INACTIVE_MSG_MAX} msgs no sync do bot), do
          menos ativo ao mais ativo. Cadastro no estoque aparece como ficha, mas
          não tira da lista.
          {groupSyncAt
            ? ` Último sync: ${new Date(groupSyncAt).toLocaleString("pt-BR")}.`
            : " Ainda sem sync — rode !inativos loja na auditoria."}
        </p>
      ) : null}

      <CustomerSearchField applied={search} onSearch={setSearch} />
      {filtered.length > LIST_RENDER_LIMIT ? (
        <p className="mb-3 text-sm text-zinc-600">
          Mostrando {LIST_RENDER_LIMIT} de {filtered.length}. Digite mais no
          campo de busca para achar o restante.
        </p>
      ) : null}

      {filtered.length === 0 &&
      !(filter === "inativos_grupo" && inactiveUnregisteredFiltered.length) ? (
        <EmptyState
          title="Nenhum cliente neste filtro"
          hint={
            filter === "inativos_grupo"
              ? "Rode !inativos loja na auditoria do WhatsApp para sincronizar."
              : "Importe o CSV do grupo ou cadastre manualmente."
          }
        />
      ) : shown.length > 0 ? (
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
              {shown.map((c) => (
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
                      {filter === "inativos_grupo" ? (
                        <Badge tone="warn">
                          {(
                            lowActivityByPhone.get(c.searchDigits) ?? "?"
                          ).toString()}{" "}
                          msgs
                        </Badge>
                      ) : null}
                      {c.pendencias > 0 ? (
                        <Badge tone="bad">Pendência: {c.pendenciaLabel}</Badge>
                      ) : null}
                      {c.leilaoGarage &&
                      (c.leilaoGarage.worst === "warn" ||
                        c.leilaoGarage.worst === "overdue") ? (
                        <Badge
                          tone={
                            c.leilaoGarage.worst === "overdue" ? "bad" : "warn"
                          }
                          title={c.leilaoGarage.shortLabel}
                        >
                          Leilão desde{" "}
                          {new Date(c.leilaoGarage.sinceIso).toLocaleDateString(
                            "pt-BR",
                          )}{" "}
                          · {c.leilaoGarage.shortLabel}
                        </Badge>
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
      ) : null}

      {filter === "inativos_grupo" &&
      inactiveUnregisteredFiltered.length > 0 ? (
        <div className="panel mt-4">
          <h2 className="mb-1 text-base font-semibold text-zinc-900">
            Sem ficha no estoque ({inactiveUnregisteredFiltered.length})
          </h2>
          <p className="mb-3 text-sm text-zinc-600">
            Baixa atividade e ainda sem cadastro de cliente.
          </p>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
            {inactiveUnregisteredFiltered.map((r) => (
              <li
                key={r.phone_digits}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-50"
              >
                <span className="font-medium">
                  {r.name || r.phone_digits}{" "}
                  <span className="font-normal text-zinc-500">
                    · {r.message_count} msg
                  </span>
                </span>
                <span className="text-zinc-500">{r.phone_digits}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
