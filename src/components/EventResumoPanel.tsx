"use client";

import Link from "next/link";
import { Badge } from "@/components/Badge";
import { formatMoneyBr } from "@/lib/cobranca-msg";
import type { EventResumo } from "@/lib/evento-resumo";

export function EventResumoPanel({
  kind,
  resumo,
}: {
  kind: string;
  resumo: EventResumo;
}) {
  return (
    <section className="panel mb-6 space-y-4">
      <div>
        <h2 className="font-semibold">Resumo do evento</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Totais com base no que está na interface agora (após correções).
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Badge tone="info">{resumo.activeLines} item(ns) ativos</Badge>
        <Badge tone="good">
          Recebido: R$ {formatMoneyBr(resumo.paidTotal)}
        </Badge>
        <Badge tone="warn">
          A receber: R$ {formatMoneyBr(resumo.unpaidTotal)}
        </Badge>
        <Badge tone="neutral">
          Faturamento: R$ {formatMoneyBr(resumo.salesTotal)}
        </Badge>
        <Badge tone="warn">{resumo.unpaidLines} em aberto</Badge>
        <Badge tone="neutral">{resumo.paidLines} pago(s)</Badge>
        {resumo.missingPrice > 0 ? (
          <Badge tone="bad">{resumo.missingPrice} sem valor</Badge>
        ) : null}
        {resumo.cancelledLines > 0 ? (
          <Badge tone="neutral">{resumo.cancelledLines} cancelado(s)</Badge>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-zinc-800">
            Quem mais comprou (valor)
          </h3>
          {resumo.topByValue.length === 0 ? (
            <p className="text-sm text-zinc-500">Sem clientes ainda.</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
              {resumo.topByValue.map((c) => (
                <li
                  key={c.key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                >
                  <span>
                    {c.customer_id ? (
                      <Link
                        href={`/clientes/${c.customer_id}`}
                        className="font-medium underline decoration-zinc-300 underline-offset-2"
                      >
                        {c.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{c.name}</span>
                    )}
                    <span className="text-xs text-zinc-500">
                      {" "}
                      · {c.items} item(ns)
                    </span>
                  </span>
                  <span className="font-mono text-xs">
                    R$ {formatMoneyBr(c.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-zinc-800">
            Quem mais pediu (quantidade)
          </h3>
          {resumo.topByItems.length === 0 ? (
            <p className="text-sm text-zinc-500">Sem clientes ainda.</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
              {resumo.topByItems.map((c) => (
                <li
                  key={`q-${c.key}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                >
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-zinc-600">
                    {c.items} item(ns) · R$ {formatMoneyBr(c.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {kind === "encomenda" && resumo.cost ? (
        <div className="space-y-3 rounded-md border border-emerald-200 bg-emerald-50/40 p-3">
          <div>
            <h3 className="text-sm font-semibold text-emerald-950">
              Faturamento × lucro desta rodada
            </h3>
            <p className="mt-1 text-xs text-emerald-900/80">
              Gasto = custo JP + 10% de imposto. Lucro = o que está sendo cobrado
              menos esse gasto. Cruza a planilha Encomendas.xlsx (nome + data da
              aba) com as cartas da rodada.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="info">
              Faturamento: R$ {formatMoneyBr(resumo.cost.faturamento)}
            </Badge>
            <Badge tone="warn">
              Gasto (JP+10%): R$ {formatMoneyBr(resumo.cost.gasto)}
            </Badge>
            <Badge tone="good">
              Lucro: R$ {formatMoneyBr(resumo.cost.lucro)}
            </Badge>
            <Badge tone="neutral">
              JP: R$ {formatMoneyBr(resumo.cost.totalJp)}
            </Badge>
            <Badge tone="neutral">
              {resumo.cost.matched} un. casadas
              {resumo.cost.unmatchedSales
                ? ` · ${resumo.cost.unmatchedSales} sem match no template`
                : ""}
            </Badge>
          </div>
          {resumo.cost.rows.length > 0 ? (
            <div className="table-wrap max-h-64 overflow-y-auto">
              <table className="data text-xs">
                <thead>
                  <tr>
                    <th>Carta</th>
                    <th>Qtd</th>
                    <th>JP</th>
                    <th>JP+10%</th>
                    <th>Venda</th>
                    <th>Lucro</th>
                  </tr>
                </thead>
                <tbody>
                  {resumo.cost.rows.map((r) => (
                    <tr key={r.product_title}>
                      <td>{r.product_title}</td>
                      <td>{r.qty}</td>
                      <td>
                        {r.cost_jp != null
                          ? `R$ ${formatMoneyBr(r.cost_jp)}`
                          : "—"}
                      </td>
                      <td>
                        {r.cost_tax != null
                          ? `R$ ${formatMoneyBr(r.cost_tax)}`
                          : "—"}
                      </td>
                      <td>
                        {r.sale != null ? `R$ ${formatMoneyBr(r.sale)}` : "—"}
                      </td>
                      <td>
                        {r.profit != null
                          ? `R$ ${formatMoneyBr(r.profit)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {kind === "encomenda" && !resumo.cost ? (
        <p className="text-sm text-zinc-500">
          Jogue o <strong>encomendas.xlsx</strong> (o mesmo do lote automático)
          para cruzar custo, faturamento e lucro desta rodada.
        </p>
      ) : null}
    </section>
  );
}
