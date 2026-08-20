import { isShelvedSaleLine } from "./leilao-resultado";
import {
  costWithTax,
  estimatedProfit,
  productMatchKey,
  type EncomendaCostRow,
} from "./encomenda-template";

export type ResumoLine = {
  product_title: string;
  unit_price: number | null;
  qty: number;
  customer_id: string | null;
  customer_name: string;
  phone: string;
  cancelled?: boolean;
  paid?: boolean;
  import_status?: string;
  valor_ou_opcao?: string;
  archived?: boolean | null;
};

export type CustomerSalesRow = {
  key: string;
  customer_id: string | null;
  name: string;
  phone: string;
  items: number;
  total: number;
};

export type EventResumo = {
  activeLines: number;
  cancelledLines: number;
  paidLines: number;
  unpaidLines: number;
  missingPrice: number;
  salesTotal: number;
  byCustomer: CustomerSalesRow[];
  topByValue: CustomerSalesRow[];
  topByItems: CustomerSalesRow[];
  /** Só encomenda com template */
  cost?: {
    matched: number;
    unmatchedSales: number;
    totalJp: number;
    totalJpTax: number;
    totalSaleMatched: number;
    totalProfit: number;
    rows: Array<{
      product_title: string;
      qty: number;
      cost_jp: number | null;
      cost_tax: number | null;
      sale: number | null;
      profit: number | null;
    }>;
  };
};

function linePrice(l: ResumoLine): number | null {
  if (l.unit_price != null && Number.isFinite(Number(l.unit_price))) {
    return Number(l.unit_price);
  }
  return null;
}

export function buildEventResumo(
  lines: ResumoLine[],
  kind: string | null | undefined,
  costs?: EncomendaCostRow[],
): EventResumo {
  const active = lines.filter(
    (l) => !l.cancelled && !isShelvedSaleLine(l, kind),
  );
  const cancelledLines = lines.filter((l) => l.cancelled).length;
  let salesTotal = 0;
  let missingPrice = 0;
  let paidLines = 0;
  let unpaidLines = 0;

  const byCust = new Map<string, CustomerSalesRow>();

  for (const l of active) {
    const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
    const price = linePrice(l);
    if (l.paid) paidLines += 1;
    else unpaidLines += 1;
    if (price == null) missingPrice += 1;
    else salesTotal += price * qty;

    if (!l.customer_id && !l.phone && !l.customer_name) continue;
    const key = l.customer_id || l.phone || l.customer_name;
    let row = byCust.get(key);
    if (!row) {
      row = {
        key,
        customer_id: l.customer_id,
        name: l.customer_name || l.phone || "—",
        phone: l.phone || "",
        items: 0,
        total: 0,
      };
      byCust.set(key, row);
    }
    row.items += qty;
    if (price != null) row.total += price * qty;
  }

  const byCustomer = [...byCust.values()].sort(
    (a, b) => b.total - a.total || b.items - a.items,
  );

  let cost: EventResumo["cost"];
  if (kind === "encomenda" && costs && costs.length) {
    const costMap = new Map<string, EncomendaCostRow>();
    for (const c of costs) {
      const key = productMatchKey(c.product_title);
      if (key) costMap.set(key, c);
    }
    let matched = 0;
    let unmatchedSales = 0;
    let totalJp = 0;
    let totalJpTax = 0;
    let totalSaleMatched = 0;
    let totalProfit = 0;
    const rows: NonNullable<EventResumo["cost"]>["rows"] = [];

    const qtyByTitle = new Map<string, { title: string; qty: number; saleSum: number }>();
    for (const l of active) {
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
      const price = linePrice(l);
      const key = productMatchKey(l.product_title);
      if (!key) {
        unmatchedSales += qty;
        continue;
      }
      let bucket = qtyByTitle.get(key);
      if (!bucket) {
        bucket = { title: l.product_title, qty: 0, saleSum: 0 };
        qtyByTitle.set(key, bucket);
      }
      bucket.qty += qty;
      if (price != null) bucket.saleSum += price * qty;
    }

    for (const [key, bucket] of qtyByTitle) {
      const c = costMap.get(key);
      if (!c) {
        unmatchedSales += bucket.qty;
        continue;
      }
      matched += bucket.qty;
      const jp = c.cost_jp;
      const tax = costWithTax(jp);
      const saleUnit = c.price_sale;
      const saleTotal =
        saleUnit != null ? saleUnit * bucket.qty : bucket.saleSum || null;
      const profitUnit = estimatedProfit(saleUnit, jp);
      const profit =
        profitUnit != null ? Math.round(profitUnit * bucket.qty * 100) / 100 : null;
      if (jp != null) totalJp += jp * bucket.qty;
      if (tax != null) totalJpTax += tax * bucket.qty;
      if (saleTotal != null) totalSaleMatched += saleTotal;
      if (profit != null) totalProfit += profit;
      rows.push({
        product_title: bucket.title,
        qty: bucket.qty,
        cost_jp: jp != null ? Math.round(jp * bucket.qty * 100) / 100 : null,
        cost_tax: tax != null ? Math.round(tax * bucket.qty * 100) / 100 : null,
        sale: saleTotal,
        profit,
      });
    }
    rows.sort((a, b) => a.product_title.localeCompare(b.product_title, "pt-BR"));
    cost = {
      matched,
      unmatchedSales,
      totalJp: Math.round(totalJp * 100) / 100,
      totalJpTax: Math.round(totalJpTax * 100) / 100,
      totalSaleMatched: Math.round(totalSaleMatched * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      rows,
    };
  }

  return {
    activeLines: active.length,
    cancelledLines,
    paidLines,
    unpaidLines,
    missingPrice,
    salesTotal: Math.round(salesTotal * 100) / 100,
    byCustomer,
    topByValue: byCustomer.slice(0, 10),
    topByItems: [...byCustomer].sort((a, b) => b.items - a.items).slice(0, 10),
    cost,
  };
}
