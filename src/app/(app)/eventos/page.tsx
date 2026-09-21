"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { createClient } from "@/lib/supabase/client";
import { fetchAllQueryRows } from "@/lib/customers";
import { eventHappenedAtIso, eventHappenedOn } from "@/lib/event-date";
import { EVENT_STATUS_LABEL } from "@/lib/labels";
import {
  isActiveBillableSaleLine,
  paymentUrgency,
} from "@/lib/leilao-resultado";
import type { Event, EventStatus, Profile } from "@/lib/types";

function statusTone(status: EventStatus) {
  if (status === "open") return "good" as const;
  if (status === "closing") return "warn" as const;
  return "neutral" as const;
}

type EventRow = Event & {
  profiles?: Profile | null;
  unpaidUrgent?: number;
};

export default function EventosPage() {
  const supabase = useMemo(() => createClient(), []);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"leilao" | "encomenda" | "outro">("leilao");
  const [paymentDue, setPaymentDue] = useState("");
  const [heldOn, setHeldOn] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: ev, error: e1 }, { data: pf, error: e2 }, lines, auth] =
      await Promise.all([
        supabase
          .from("events")
          .select("*, profiles!owner_id(id, name, role, created_at)")
          .order("opened_at", { ascending: false }),
        supabase.from("profiles").select("*").order("name"),
        fetchAllQueryRows<{
          event_id: string;
          paid: boolean;
          cancelled: boolean;
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
              "id, event_id, paid, cancelled, archived, import_status, certainty, phone_digits, valor_ou_opcao, notes",
            )
            .eq("cancelled", false)
            .eq("paid", false)
            .order("id", { ascending: true })
            .range(from, to),
        ).catch((e) => {
          console.error(e);
          return [];
        }),
        supabase.auth.getUser(),
      ]);
    if (e1) setError(e1.message);
    if (e2) setError(e2.message);

    const unpaidByEvent = new Map<string, number>();
    const list = (ev as EventRow[]) || [];
    const kindById = new Map(list.map((e) => [e.id, e.kind || "leilao"]));
    for (const evRow of list) {
      unpaidByEvent.set(evRow.id, 0);
    }
    for (const line of lines) {
      const id = line.event_id as string;
      const kind = kindById.get(id);
      if (!isActiveBillableSaleLine(line, kind)) continue;
      if (line.paid) continue;
      const evRow = list.find((e) => e.id === id);
      const u = paymentUrgency(false, false, evRow?.payment_due_at);
      if (u === "warn" || u === "overdue") {
        unpaidByEvent.set(id, (unpaidByEvent.get(id) || 0) + 1);
      }
    }

    setEvents(
      list.map((e) => ({
        ...e,
        unpaidUrgent: unpaidByEvent.get(e.id) || 0,
      })),
    );
    setProfiles((pf as Profile[]) || []);
    setMe(auth.data.user?.id ?? null);
    setOwnerId((prev) => prev || auth.data.user?.id || "");
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const { data, error: err } = await supabase
      .from("events")
      .insert({
        name: name.trim(),
        status: "open",
        owner_id: ownerId || me,
        notes: "",
        kind,
        payment_due_at: paymentDue || null,
        opened_at: heldOn ? eventHappenedAtIso(heldOn) : undefined,
        use_stock_box: false,
      })
      .select("id")
      .single();
    if (err) {
      setError(err.message);
      return;
    }
    setName("");
    setPaymentDue("");
    setHeldOn("");
    window.location.href = `/eventos/${data.id}`;
  }

  return (
    <div>
      <PageHeader
        title="Eventos"
        description="Leilão/encomenda: importe a planilha do bot, cobrenças e prazos. Caixa física de estoque é opcional."
      />

      {error ? (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <form onSubmit={onCreate} className="panel mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className="text-sm lg:col-span-2">
          <span className="mb-1 block text-zinc-600">Nome do evento</span>
          <input
            className="field"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Leilão dia 30/08"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Tipo</span>
          <select
            className="field"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="leilao">Leilão</option>
            <option value="encomenda">Encomendas</option>
            <option value="outro">Outro</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Data do evento</span>
          <input
            className="field"
            type="date"
            required
            value={heldOn}
            onChange={(e) => setHeldOn(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Prazo de pagamento</span>
          <input
            className="field"
            type="date"
            value={paymentDue}
            onChange={(e) => setPaymentDue(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600">Responsável</span>
          <select
            className="field"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end lg:col-span-6">
          <button type="submit" className="btn-primary">
            Abrir evento
          </button>
        </div>
      </form>

      {events.length === 0 ? (
        <EmptyState title="Nenhum evento" hint="Abra o primeiro evento acima." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Evento</th>
                <th>Dia</th>
                <th>Status</th>
                <th>Prazo</th>
                <th>Responsável</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td className="font-medium">
                    {ev.name}
                    {ev.unpaidUrgent ? (
                      <span className="ml-2 text-xs font-semibold text-red-700">
                        {ev.unpaidUrgent} pagamento(s) em aberto no prazo
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap text-sm text-zinc-700">
                    {(() => {
                      const day = eventHappenedOn({
                        name: ev.name,
                        opened_at: ev.opened_at,
                      });
                      return day
                        ? new Date(`${day}T12:00:00`).toLocaleDateString("pt-BR")
                        : "—";
                    })()}
                  </td>
                  <td>
                    <Badge tone={statusTone(ev.status)}>
                      {EVENT_STATUS_LABEL[ev.status]}
                    </Badge>
                    <span className="ml-2 text-xs text-zinc-500">
                      {ev.kind || "leilao"}
                    </span>
                  </td>
                  <td>
                    {ev.payment_due_at
                      ? new Date(`${ev.payment_due_at}T12:00:00`).toLocaleDateString(
                          "pt-BR",
                        )
                      : "—"}
                  </td>
                  <td>{ev.profiles?.name || "—"}</td>
                  <td>
                    <Link className="btn-secondary" href={`/eventos/${ev.id}`}>
                      Abrir
                    </Link>
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
