import { createClient } from "@/lib/supabase/client";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import type { Customer } from "@/lib/types";

export function customerPhoneDigits(
  c: Pick<Customer, "phone" | "phone_digits">,
): string {
  return normalizePhoneDigits(c.phone_digits || c.phone || "");
}

/**
 * Formatos equivalentes do mesmo WhatsApp BR:
 * com/sem 55, com/sem o 9 do celular.
 */
export function phoneVariants(raw: string): string[] {
  const d = normalizePhoneDigits(raw);
  if (!d) return [];
  const out = new Set<string>();
  const add = (x: string) => {
    if (x.length >= 10 && x.length <= 15) out.add(x);
  };
  add(d);

  const expand55 = (digits: string) => {
    add(digits);
    if (digits.startsWith("55") && digits.length >= 12) add(digits.slice(2));
    else if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
      add(`55${digits}`);
    }
  };

  const toggleNinth = (digits: string) => {
    const hasCc = digits.startsWith("55") && digits.length >= 12;
    const national = hasCc ? digits.slice(2) : digits;
    const prefix = hasCc ? "55" : "";
    if (national.length === 11 && national[2] === "9") {
      expand55(`${prefix}${national.slice(0, 2)}${national.slice(3)}`);
    }
    if (national.length === 10) {
      expand55(`${prefix}${national.slice(0, 2)}9${national.slice(2)}`);
    }
  };

  for (const v of [...out]) {
    expand55(v);
    toggleNinth(v);
  }
  for (const v of [...out]) {
    expand55(v);
    toggleNinth(v);
  }
  return [...out];
}

export function phonesMatch(a: string, b: string): boolean {
  const va = phoneVariants(a);
  if (!va.length) return false;
  const vb = new Set(phoneVariants(b));
  return va.some((x) => vb.has(x));
}

/** Índice de variantes para lookup O(1) — não use phonesMatch em loop. */
export function buildPhoneLookup(phones: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of phones) {
    for (const v of phoneVariants(p)) out.add(v);
  }
  return out;
}

export function phoneInLookup(phone: string, lookup: Set<string>): boolean {
  if (!lookup.size) return false;
  return phoneVariants(phone).some((v) => lookup.has(v));
}

export function normalizeSearchHay(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function findCustomerByPhone(
  customers: Array<Pick<Customer, "id" | "phone" | "phone_digits">>,
  phone: string,
): (typeof customers)[number] | undefined {
  const variants = new Set(phoneVariants(phone));
  if (!variants.size) return undefined;
  return customers.find((c) =>
    phoneVariants(c.phone_digits || c.phone || "").some((v) => variants.has(v)),
  );
}

export function looksLikePhoneName(name: string): boolean {
  const digits = normalizePhoneDigits(name);
  return digits.length >= 10 && digits === name.replace(/\D/g, "");
}

/** Busca tolerante a acento e telefone parcial. */
export function matchesCustomerQuery(
  c: Pick<Customer, "name" | "phone" | "phone_digits">,
  rawQuery: string,
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const qDigits = normalizePhoneDigits(q);
  if (qDigits.length >= 3) {
    const phone = customerPhoneDigits(c);
    if (phone.includes(qDigits)) return true;
  }
  const hay = normalizeSearchHay(
    `${c.name || ""} ${c.phone || ""} ${c.phone_digits || ""}`,
  );
  return hay.includes(normalizeSearchHay(q));
}

/**
 * Supabase limita cada select a ~1000 linhas por padrão.
 * Ordenação só por name é instável (nomes iguais) e pode pular linhas entre páginas.
 */
export async function fetchAllCustomers(
  supabase: ReturnType<typeof createClient>,
): Promise<Customer[]> {
  const pageSize = 1000;
  const all: Customer[] = [];
  const seen = new Set<string>();
  for (let from = 0; from < 50000; from += pageSize) {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = (data as Customer[]) || [];
    for (const row of batch) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      all.push(row);
    }
    if (batch.length < pageSize) break;
  }
  return all;
}

/** Cliente do browser ou do server (service role) — só precisa de `.from()`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

const QUERY_PAGE = 1000;

/**
 * Pagina qualquer select do Supabase (teto padrão de 1000 linhas).
 * `run` deve aplicar `.range(from, to)` no builder.
 */
export async function fetchAllQueryRows<T>(
  run: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  for (let from = 0; from < 500000; from += QUERY_PAGE) {
    const { data, error } = await run(from, from + QUERY_PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    for (const row of batch) {
      const id = (row as { id?: string }).id;
      if (typeof id === "string" && id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      all.push(row);
    }
    if (batch.length < QUERY_PAGE) break;
  }
  return all;
}

/** Índice telefone → cliente, cobrindo variantes BR (55 / 9º dígito). */
export function buildPhoneCustomerIndex(
  customers: Customer[],
): Map<string, Customer> {
  const map = new Map<string, Customer>();
  const better = (c: Customer, prev: Customer, variant: string) => {
    const cExact = (c.phone_digits || "") === variant;
    const pExact = (prev.phone_digits || "") === variant;
    if (cExact !== pExact) return cExact;
    const t = (c.created_at || "").localeCompare(prev.created_at || "");
    if (t !== 0) return t < 0;
    return c.id < prev.id;
  };
  for (const c of customers) {
    for (const v of phoneVariants(c.phone_digits || c.phone || "")) {
      const prev = map.get(v);
      if (!prev || better(c, prev, v)) map.set(v, c);
    }
  }
  return map;
}

export function pickCanonicalCustomerId(
  rows: Array<Pick<Customer, "id" | "created_at">>,
  fallbackId: string,
): string {
  if (!rows.length) return fallbackId;
  const sorted = [...rows].sort(
    (a, b) =>
      (a.created_at || "").localeCompare(b.created_at || "") ||
      a.id.localeCompare(b.id),
  );
  return sorted[0].id;
}

export async function fetchCustomersSharingPhone(
  supabase: DbClient,
  customerId: string,
  phoneDigits: string,
): Promise<Customer[]> {
  const byId = await supabase
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .maybeSingle();
  const variants = phoneVariants(phoneDigits);
  const byPhone = variants.length
    ? await supabase.from("customers").select("*").in("phone_digits", variants)
    : { data: [] as Customer[], error: null };
  if (byId.error) throw new Error(byId.error.message);
  if (byPhone.error) throw new Error(byPhone.error.message);
  const map = new Map<string, Customer>();
  if (byId.data) map.set((byId.data as Customer).id, byId.data as Customer);
  for (const row of (byPhone.data as Customer[]) || []) map.set(row.id, row);
  return [...map.values()];
}

export async function fetchRelatedCustomerIds(
  supabase: DbClient,
  customerId: string,
  phoneDigits: string,
): Promise<string[]> {
  const rows = await fetchCustomersSharingPhone(
    supabase,
    customerId,
    phoneDigits,
  );
  const ids = new Set<string>([customerId]);
  for (const row of rows) ids.add(row.id);
  return [...ids];
}

export async function fetchSaleLinesForCustomer<T extends { id: string }>(
  supabase: DbClient,
  opts: {
    customerIds: string[];
    phoneDigits?: string;
    select?: string;
    cancelled?: boolean;
  },
): Promise<T[]> {
  const select = opts.select || "*";
  const ids = opts.customerIds.filter(Boolean);
  const variants = phoneVariants(opts.phoneDigits || "");
  const filters: string[] = [];
  if (ids.length) filters.push(`customer_id.in.(${ids.join(",")})`);
  if (variants.length) filters.push(`phone_digits.in.(${variants.join(",")})`);
  if (!filters.length) return [];

  const applyCancelled = (q: ReturnType<DbClient["from"]>) =>
    opts.cancelled === false ? q.eq("cancelled", false) : q;

  return fetchAllQueryRows<T>((from, to) =>
    applyCancelled(
      supabase
        .from("event_sale_lines")
        .select(select)
        .or(filters.join(","))
        .order("created_at", { ascending: false }),
    ).range(from, to),
  );
}

/**
 * Religa linhas de venda ao cadastro canônico (mais antigo entre duplicatas
 * do mesmo WhatsApp) e preenche `customer_id` nulo com telefone equivalente.
 */
export async function relinkSaleLinesToCanonicalCustomer(
  supabase: DbClient,
  opts: {
    canonicalId: string;
    relatedIds: string[];
    phoneDigits: string;
  },
): Promise<number> {
  let n = 0;
  const variants = phoneVariants(opts.phoneDigits);
  if (variants.length) {
    const { data, error } = await supabase
      .from("event_sale_lines")
      .update({ customer_id: opts.canonicalId })
      .in("phone_digits", variants)
      .is("customer_id", null)
      .select("id");
    if (error) throw new Error(error.message);
    n += (data || []).length;
  }
  const others = opts.relatedIds.filter((id) => id && id !== opts.canonicalId);
  if (others.length) {
    const { data, error } = await supabase
      .from("event_sale_lines")
      .update({ customer_id: opts.canonicalId })
      .in("customer_id", others)
      .select("id");
    if (error) throw new Error(error.message);
    n += (data || []).length;
  }
  return n;
}

type EnsureCustomerInput = {
  name: string;
  phoneDigits: string;
  source?: "manual" | "whatsapp_group";
};

/**
 * Cria cliente ou reaproveita o telefone já cadastrado.
 * Se o cadastro antigo ainda for só o número, atualiza o nome.
 */
export async function ensureCustomerByPhone(
  supabase: ReturnType<typeof createClient>,
  input: EnsureCustomerInput,
): Promise<{ customer: Customer; created: boolean; renamed: boolean }> {
  const phone = normalizePhoneDigits(input.phoneDigits);
  const name = input.name.trim() || phone;
  if (!phone || phone.length < 10 || phone.length > 15) {
    throw new Error("Informe um telefone válido (10–15 dígitos).");
  }

  const variants = phoneVariants(phone);
  const { data: existingRows, error: findErr } = await supabase
    .from("customers")
    .select("*")
    .in("phone_digits", variants);
  if (findErr) throw findErr;
  const rows = ((existingRows as Customer[]) || []).filter(Boolean);
  const existing =
    rows.find((c) => c.phone_digits === phone) ||
    [...rows].sort(
      (a, b) =>
        (a.created_at || "").localeCompare(b.created_at || "") ||
        a.id.localeCompare(b.id),
    )[0] ||
    null;

  if (existing) {
    const row = existing as Customer;
    const shouldRename =
      Boolean(name) &&
      !looksLikePhoneName(name) &&
      looksLikePhoneName(row.name || "");
    if (shouldRename) {
      const { data: updated, error: upErr } = await supabase
        .from("customers")
        .update({ name })
        .eq("id", row.id)
        .select("*")
        .single();
      if (upErr) throw upErr;
      return { customer: updated as Customer, created: false, renamed: true };
    }
    return { customer: row, created: false, renamed: false };
  }

  const { data, error } = await supabase
    .from("customers")
    .insert({
      name,
      phone,
      phone_digits: phone,
      source: input.source || "manual",
      notes: "",
    })
    .select("*")
    .single();
  if (error) {
    const { data: again, error: againErr } = await supabase
      .from("customers")
      .select("*")
      .in("phone_digits", variants);
    if (againErr) throw error;
    const row =
      ((again as Customer[]) || []).find((c) => c.phone_digits === phone) ||
      ((again as Customer[]) || [])[0] ||
      null;
    if (!row) throw error;
    return { customer: row, created: false, renamed: false };
  }
  return { customer: data as Customer, created: true, renamed: false };
}
