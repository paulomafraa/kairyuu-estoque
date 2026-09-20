import { parseMoneyFromOption } from "@/lib/leilao-resultado";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import type { EventSaleLine } from "@/lib/types";

export function lineUnitPrice(line: {
  unit_price?: number | null;
  valor_ou_opcao?: string | null;
}): number | null {
  if (line.unit_price != null && Number.isFinite(Number(line.unit_price))) {
    return Number(line.unit_price);
  }
  return parseMoneyFromOption(line.valor_ou_opcao || "");
}

export function lineQty(line: { qty?: number | null }): number {
  const n = Number(line.qty);
  return n > 0 ? n : 1;
}

export function lineTotal(line: {
  unit_price?: number | null;
  valor_ou_opcao?: string | null;
  qty?: number | null;
}): number | null {
  const p = lineUnitPrice(line);
  if (p == null) return null;
  return p * lineQty(line);
}

export function newProposalId(): string {
  return `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function digitsQuery(q: string): string {
  return normalizePhoneDigits(q);
}

export function looksLikePhoneName(name: string): boolean {
  const d = normalizePhoneDigits(name);
  return d.length >= 8 && d === name.replace(/\D/g, "");
}

export type SaleLineWithEvent = EventSaleLine & {
  events?: {
    id: string;
    name: string;
    kind?: string | null;
    opened_at?: string | null;
    payment_due_at?: string | null;
  } | null;
};
