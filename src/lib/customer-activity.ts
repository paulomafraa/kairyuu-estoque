import { normalizePhoneDigits } from "@/lib/clients-csv";
import { buildPhoneLookup, phoneInLookup, phonesMatch } from "@/lib/customers";
import type { SupabaseClient } from "@supabase/supabase-js";

export { phonesMatch };

export function phoneInSet(phone: string, set: Iterable<string>): boolean {
  return phoneInLookup(phone, buildPhoneLookup(set));
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
      .order(column)
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

async function fetchSaleLinePhones(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const pageSize = 1000;
  const phones = new Set<string>();
  for (let from = 0; from < 200000; from += pageSize) {
    const { data, error } = await supabase
      .from("event_sale_lines")
      .select("id, phone_digits")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = (data || []) as Array<{ phone_digits: string | null }>;
    for (const line of batch) {
      const d = normalizePhoneDigits(line.phone_digits || "");
      if (d) phones.add(d);
    }
    if (batch.length < pageSize) break;
  }
  return phones;
}

/**
 * Cadastro (customers) + compras.
 * `purchased` = qualquer pedido: linha de venda (leilão / encomenda / evento),
 * `orders`, `customer_items` ou `customer_garage_items` do cliente.
 */
export async function fetchCustomerPhoneSets(
  supabase: SupabaseClient,
): Promise<{ protected: Set<string>; purchased: Set<string> }> {
  const [salePhones, customers, orderCustomers, itemCustomers, garageCustomers] =
    await Promise.all([
      fetchSaleLinePhones(supabase),
      (async () => {
        const pageSize = 1000;
        const rows: Array<{
          id: string;
          phone_digits: string | null;
          phone: string | null;
        }> = [];
        for (let from = 0; from < 100000; from += pageSize) {
          const { data, error } = await supabase
            .from("customers")
            .select("id, phone_digits, phone")
            .order("id")
            .range(from, from + pageSize - 1);
          if (error) throw error;
          const batch = (data || []) as typeof rows;
          rows.push(...batch);
          if (batch.length < pageSize) break;
        }
        return rows;
      })(),
      fetchAllIds(supabase, "orders", "customer_id"),
      fetchAllIds(supabase, "customer_items", "customer_id"),
      fetchAllIds(supabase, "customer_garage_items", "customer_id"),
    ]);

  const buyerIds = new Set<string>([
    ...orderCustomers,
    ...itemCustomers,
    ...garageCustomers,
  ]);
  const purchased = new Set<string>(salePhones);
  const protectedPhones = new Set<string>(salePhones);
  for (const c of customers) {
    const d = normalizePhoneDigits(c.phone_digits || c.phone || "");
    if (!d) continue;
    protectedPhones.add(d);
    if (buyerIds.has(c.id)) purchased.add(d);
  }
  return { protected: protectedPhones, purchased };
}

/**
 * Telefones “protegidos” (não entram como inativos do grupo):
 * - qualquer cadastro em `customers` (só estar no site já conta)
 * - telefones que aparecem em linhas de venda (mesmo sem customer_id)
 */
export async function fetchProtectedCustomerPhones(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  return (await fetchCustomerPhoneSets(supabase)).protected;
}

/** Qualquer pedido: linha de venda, `orders`, itens ou garagem do cliente. */
export async function fetchPurchasePhones(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  return (await fetchCustomerPhoneSets(supabase)).purchased;
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
  const lookup = buildPhoneLookup(protectedPhones);
  const inactive: string[] = [];
  const active: string[] = [];
  const seen = new Set<string>();
  for (const raw of phones) {
    const d = normalizePhoneDigits(raw);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    if (phoneInLookup(d, lookup)) active.push(d);
    else inactive.push(d);
  }
  return { inactive, active };
}
