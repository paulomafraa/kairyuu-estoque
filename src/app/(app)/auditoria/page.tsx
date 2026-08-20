"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/types";

type AuditRow = {
  id: string;
  action: string;
  detail: string;
  entity_type: string;
  entity_id: string;
  customer_id: string | null;
  event_id: string | null;
  created_at: string;
  created_by: string | null;
  created_by_profile?: Pick<Profile, "id" | "name"> | null;
};

type GroupMode = "day" | "user" | "flat";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("pt-BR");
}

function dayKey(iso: string) {
  return iso.slice(0, 10);
}

function fmtDay(iso: string) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return d.toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function AuditoriaPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [groupMode, setGroupMode] = useState<GroupMode>("day");
  const [filterDay, setFilterDay] = useState("");
  const [filterUser, setFilterUser] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [au, pr] = await Promise.all([
      supabase
        .from("staff_audit_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500),
      supabase.from("profiles").select("id, name, role, created_at"),
    ]);

    const nameById = new Map(
      ((pr.data || []) as Profile[]).map((p) => [p.id, p.name]),
    );
    setProfiles((pr.data as Profile[]) || []);

    if (au.error) {
      setError(
        au.error.message.includes("staff_audit_log") ||
          au.error.message.includes("does not exist")
          ? "Rode supabase/migration_staff_audit_log.sql no Supabase para ativar a auditoria global."
          : au.error.message,
      );
      setRows([]);
    } else {
      setRows(
        ((au.data || []) as AuditRow[]).map((r) => ({
          ...r,
          created_by_profile: r.created_by
            ? {
                id: r.created_by,
                name: nameById.get(r.created_by) || "Staff",
              }
            : null,
        })),
      );
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filterDay && dayKey(r.created_at) !== filterDay) return false;
      if (filterUser && r.created_by !== filterUser) return false;
      return true;
    });
  }, [rows, filterDay, filterUser]);

  const groups = useMemo(() => {
    if (groupMode === "flat") {
      return [{ key: "all", title: "Todas as ações", items: filtered }];
    }
    if (groupMode === "user") {
      const map = new Map<string, { title: string; items: AuditRow[] }>();
      for (const r of filtered) {
        const id = r.created_by || "unknown";
        const title = r.created_by_profile?.name || "Staff desconhecido";
        let g = map.get(id);
        if (!g) {
          g = { title, items: [] };
          map.set(id, g);
        }
        g.items.push(r);
      }
      return [...map.entries()]
        .map(([key, g]) => ({ key, title: g.title, items: g.items }))
        .sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
    }
    // day
    const map = new Map<string, AuditRow[]>();
    for (const r of filtered) {
      const k = dayKey(r.created_at);
      const list = map.get(k) || [];
      list.push(r);
      map.set(k, list);
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, items]) => ({
        key,
        title: fmtDay(key),
        items,
      }));
  }, [filtered, groupMode]);

  function renderItem(r: AuditRow) {
    return (
      <li
        key={r.id}
        className="rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{r.action}</Badge>
          <span className="font-medium text-zinc-800">
            {r.created_by_profile?.name || "Staff"}
          </span>
          <span className="text-xs text-zinc-500">{fmtDate(r.created_at)}</span>
          {r.entity_type ? (
            <span className="text-xs text-zinc-400">{r.entity_type}</span>
          ) : null}
        </div>
        <p className="mt-1 text-zinc-700">{r.detail}</p>
        <div className="mt-1 flex flex-wrap gap-3 text-xs">
          {r.customer_id ? (
            <Link
              className="underline"
              href={`/clientes/${r.customer_id}`}
            >
              Ver cliente
            </Link>
          ) : null}
          {r.event_id ? (
            <Link className="underline" href={`/eventos/${r.event_id}`}>
              Ver evento
            </Link>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <div>
      <PageHeader
        title="Auditoria"
        description="Tira-teima das ações no estoque: quem fez o quê e quando. Organize por dia ou por usuário."
      />

      {error ? (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Organizar por</span>
          <select
            className="field w-auto"
            value={groupMode}
            onChange={(e) => setGroupMode(e.target.value as GroupMode)}
          >
            <option value="day">Dia</option>
            <option value="user">Usuário</option>
            <option value="flat">Lista corrida</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Filtrar dia (opc.)</span>
          <input
            className="field"
            type="date"
            value={filterDay}
            onChange={(e) => setFilterDay(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Filtrar usuário (opc.)</span>
          <select
            className="field w-auto min-w-[10rem]"
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
          >
            <option value="">Todos</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => void load()}>
          Atualizar
        </button>
        <Badge tone="neutral">{filtered.length} registro(s)</Badge>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-600">Carregando…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Nenhum registro ainda"
          hint="Ações de evento, garagem, estoque e encomendas passam a aparecer aqui depois da migration."
        />
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.key} className="panel">
              <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
                {g.title}
                <Badge tone="neutral">{g.items.length}</Badge>
              </h2>
              <ul className="space-y-2">{g.items.map(renderItem)}</ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
