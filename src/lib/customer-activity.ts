import { normalizePhoneDigits } from "@/lib/clients-csv";
import { phonesMatch } from "@/lib/customers";
import type { SupabaseClient } from "@supabase/supabase-js";

export { phonesMatch };

export function phoneInSet(phone: string, set: Iterable<string>): boolean {
  const d = normalizePhoneDigits(phone);
  if (!d) return false;
  for (const x of set) {
    if (phonesMatch(d, x)) return true;
  }
  return false;
}

async function fetchAllIds(
  supabase: SupabaseClient,
  table: string,
  column: string,
): Promise<string[]> {
  const pageSize = 1000;
  const out: string[] = [];
  for (let from = 0; from < 100000; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(column)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = (data || []) as unknown as Array<Record<string, unknown>>;
    for (const row of batch) {
      const v = row[column];
      if (typeof v === "string" && v) out.push(v);
    }
    if (batch.length < pageSize) break;
  }
  return out;
}

/**
 * Telefones “protegidos” (não entram como inativos do grupo):
 * - qualquer cadastro em `customers` (só estar no site já conta)
 * - telefones que aparecem em linhas de venda (mesmo sem customer_id)
 */
export async function fetchProtectedCustomerPhones(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const [saleLines, customers] = await Promise.all([
    (async () => {
      const pageSize = 1000;
      const rows: Array<{ phone_digits: string | null }> = [];
      for (let from = 0; from < 200000; from += pageSize) {
        const { data, error } = await supabase
          .from("event_sale_lines")
          .select("phone_digits")
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const batch = (data || []) as typeof rows;
        rows.push(...batch);
        if (batch.length < pageSize) break;
      }
      return rows;
    })(),
    (async () => {
      const pageSize = 1000;
      const rows: Array<{ phone_digits: string | null; phone: string | null }> =
        [];
      for (let from = 0; from < 100000; from += pageSize) {
        const { data, error } = await supabase
          .from("customers")
          .select("phone_digits, phone")
          .order("id")
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const batch = (data || []) as typeof rows;
        rows.push(...batch);
        if (batch.length < pageSize) break;
      }
      return rows;
    })(),
  ]);

  const phones = new Set<string>();
  for (const c of customers) {
    const d = normalizePhoneDigits(c.phone_digits || c.phone || "");
    if (d) phones.add(d);
  }
  for (const line of saleLines) {
    const d = normalizePhoneDigits(line.phone_digits || "");
    if (d) phones.add(d);
  }
  return phones;
}

/** @deprecated use fetchProtectedCustomerPhones */
export async function fetchActivePurchasePhones(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  return fetchProtectedCustomerPhones(supabase);
}

export function splitInactivePhones(
  phones: string[],
  protectedPhones: Set<string>,
): { inactive: string[]; active: string[] } {
  const inactive: string[] = [];
  const active: string[] = [];
  const seen = new Set<string>();
  for (const raw of phones) {
    const d = normalizePhoneDigits(raw);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    if (phoneInSet(d, protectedPhones)) active.push(d);
    else inactive.push(d);
  }
  return { inactive, active };
}
