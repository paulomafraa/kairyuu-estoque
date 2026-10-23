import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import { loadRoundItems } from "@/lib/box-holdings";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import { looksLikePhoneName, phoneVariants } from "@/lib/customers";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const BR_DDD = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99",
]);

type CustomerRow = {
  id: string;
  name: string;
  phone: string;
  phone_digits: string | null;
  physical_box_id: string | null;
  created_at: string;
};

type ProfileBody = {
  siteUserId?: string;
  username?: string;
  displayName?: string;
  email?: string;
  phone?: string;
};

/** Celular BR ganha 55. Número de outro país fica como foi digitado. */
function canonicalPhone(raw: string): string {
  let d = normalizePhoneDigits(raw);
  if (d.startsWith("00")) d = d.slice(2);
  if (
    (d.length === 12 || d.length === 13) &&
    d.startsWith("55") &&
    BR_DDD.has(d.slice(2, 4))
  ) {
    return d;
  }
  if ((d.length === 10 || d.length === 11) && BR_DDD.has(d.slice(0, 2))) {
    return `55${d}`;
  }
  if (d.length >= 8 && d.length <= 15) return d;
  return "";
}

function clip(value: unknown, max: number): string {
  return String(value || "").trim().replace(/^@+/, "").slice(0, max);
}

function pickCustomer(rows: CustomerRow[], phone: string): CustomerRow | null {
  if (!rows.length) return null;
  return (
    rows.find((c) => c.phone_digits === phone) ||
    rows.find((c) => c.physical_box_id) ||
    [...rows].sort(
      (a, b) =>
        (a.created_at || "").localeCompare(b.created_at || "") ||
        a.id.localeCompare(b.id),
    )[0] ||
    null
  );
}

async function customersByPhone(
  admin: ReturnType<typeof createAdminClient>,
  phone: string,
): Promise<CustomerRow[]> {
  const variants = phoneVariants(phone);
  if (!variants.length) return [];
  const { data, error } = await admin
    .from("customers")
    .select("id, name, phone, phone_digits, physical_box_id, created_at")
    .in("phone_digits", variants);
  if (error) throw new Error(error.message);
  return (data || []) as CustomerRow[];
}

function missingSiteColumn(message: string): boolean {
  return /site_user_id|site_username|site_display_name|site_email|site_linked_at/i.test(
    message,
  );
}

function clipEmail(value: unknown): string {
  const text = String(value || "").trim().slice(0, 255);
  return text.includes("@") ? text : "";
}

async function saveSiteProfile(
  admin: ReturnType<typeof createAdminClient>,
  customer: CustomerRow,
  profile: { siteUserId: string; username: string; displayName: string; email: string },
): Promise<{ saved: boolean; warning: string | null }> {
  const patch: Record<string, string | null> = {
    site_user_id: profile.siteUserId,
    site_username: profile.username || null,
    site_display_name: profile.displayName || null,
    site_email: profile.email || null,
    site_linked_at: new Date().toISOString(),
  };
  if (profile.displayName && looksLikePhoneName(customer.name || "")) {
    patch.name = profile.displayName;
  }

  let { error } = await admin.from("customers").update(patch).eq("id", customer.id);
  if (error && /site_email/i.test(error.message)) {
    delete patch.site_email;
    ({ error } = await admin.from("customers").update(patch).eq("id", customer.id));
  }
  if (error) {
    if (missingSiteColumn(error.message)) {
      return {
        saved: false,
        warning:
          "Rode supabase/migration_site_account.sql para gravar o @, o e-mail e o apelido.",
      };
    }
    throw new Error(error.message);
  }

  const clearPatch: Record<string, null> = {
    site_user_id: null,
    site_username: null,
    site_display_name: null,
    site_email: null,
    site_linked_at: null,
  };
  let { error: clearErr } = await admin
    .from("customers")
    .update(clearPatch)
    .eq("site_user_id", profile.siteUserId)
    .neq("id", customer.id);
  if (clearErr && /site_email/i.test(clearErr.message)) {
    delete clearPatch.site_email;
    ({ error: clearErr } = await admin
      .from("customers")
      .update(clearPatch)
      .eq("site_user_id", profile.siteUserId)
      .neq("id", customer.id));
  }
  if (clearErr && !missingSiteColumn(clearErr.message)) {
    throw new Error(clearErr.message);
  }
  return { saved: true, warning: null };
}

async function ensureCustomer(
  admin: ReturnType<typeof createAdminClient>,
  phone: string,
  profile: { username: string; displayName: string },
): Promise<CustomerRow> {
  const existing = pickCustomer(await customersByPhone(admin, phone), phone);
  if (existing) return existing;

  const name = profile.displayName || profile.username || phone;
  const { data, error } = await admin
    .from("customers")
    .insert({
      name,
      phone,
      phone_digits: phone,
      source: "manual",
      notes: "",
    })
    .select("id, name, phone, phone_digits, physical_box_id, created_at")
    .single();
  if (!error && data) return data as CustomerRow;

  const again = pickCustomer(await customersByPhone(admin, phone), phone);
  if (again) return again;
  throw new Error(error?.message || "Não foi possível guardar o cliente.");
}

async function holdingsFor(
  admin: ReturnType<typeof createAdminClient>,
  people: CustomerRow[],
) {
  const items = await loadRoundItems(
    admin,
    people.map((p) => ({ id: p.id, name: p.name, phone: p.phone })),
  );
  const boxIds = [...new Set(people.map((p) => p.physical_box_id).filter(Boolean))];
  if (boxIds.length) {
    const { data, error } = await admin
      .from("physical_box_lines")
      .select("id, title, qty, created_at")
      .in("box_id", boxIds);
    if (!error) {
      for (const line of data || []) {
        items.push({
          key: `m:${line.id}`,
          title: line.title || "Item na loja",
          qty: Number(line.qty) || 1,
          source: "manual",
          sinceIso: line.created_at || null,
          customerName: people[0]?.name || "",
          eventName: "",
        });
      }
    }
  }
  return items.map((item) => ({
    title: item.title,
    qty: item.qty,
    source: item.source,
    eventName: item.eventName,
    sinceIso: item.sinceIso,
  }));
}

type RoundLine = {
  event_id: string;
  product_title: string | null;
  qty: number | null;
  qty_arrived: number | null;
  cancelled: boolean | null;
  events?: { id: string; name: string; kind: string; opened_at: string } | { id: string; name: string; kind: string; opened_at: string }[] | null;
};

function eventOf(line: RoundLine) {
  const raw = line.events;
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Uma etapa só para a rodada inteira, a partir do que a central já marcou. */
function etapaDaRodada(
  lines: RoundLine[],
  stock: { product_title: string | null; qty_arrived: number | null; pedido_feito: boolean | null }[],
): "japao" | "voo" | "brasil" {
  const byTitle = new Map<string, { ordered: number; lineArrived: number }>();
  for (const line of lines) {
    if (line.cancelled) continue;
    const title = line.product_title || "";
    const cur = byTitle.get(title) || { ordered: 0, lineArrived: 0 };
    const qty = Number(line.qty) || 0;
    cur.ordered += qty;
    cur.lineArrived += Math.min(qty, Number(line.qty_arrived) || 0);
    byTitle.set(title, cur);
  }
  if (!byTitle.size) return "japao";

  let faltaPedir = 0;
  let faltaChegar = 0;
  for (const [title, agg] of byTitle) {
    const st = stock.find((s) => (s.product_title || "") === title);
    if (!st?.pedido_feito) faltaPedir += 1;
    let arrived = agg.lineArrived;
    if (arrived === 0) arrived = Math.min(agg.ordered, Number(st?.qty_arrived) || 0);
    if (arrived < agg.ordered) faltaChegar += 1;
  }
  if (faltaPedir > 0) return "japao";
  if (faltaChegar > 0) return "voo";
  return "brasil";
}

async function rodadasDaConta(
  admin: ReturnType<typeof createAdminClient>,
  phone: string,
) {
  const people = await customersByPhone(admin, phone);
  const ids = people.map((p) => p.id);
  const variants = phoneVariants(phone);
  const select =
    "event_id, product_title, qty, qty_arrived, cancelled, events!inner(id, name, kind, opened_at)";

  const mine: RoundLine[] = [];
  if (ids.length) {
    const { data, error } = await admin
      .from("event_sale_lines")
      .select(select)
      .in("customer_id", ids)
      .eq("cancelled", false)
      .limit(400);
    if (error) throw new Error(error.message);
    mine.push(...((data || []) as RoundLine[]));
  }
  if (variants.length) {
    const { data, error } = await admin
      .from("event_sale_lines")
      .select(select)
      .in("phone_digits", variants)
      .eq("cancelled", false)
      .limit(400);
    if (error) throw new Error(error.message);
    mine.push(...((data || []) as RoundLine[]));
  }

  const events = new Map<string, { name: string; opened_at: string }>();
  for (const line of mine) {
    const ev = eventOf(line);
    if (!ev || ev.kind !== "encomenda") continue;
    events.set(ev.id, { name: ev.name, opened_at: ev.opened_at || "" });
  }
  return montarRodadas(admin, events, 12);
}

async function rodadasTodas(admin: ReturnType<typeof createAdminClient>) {
  const { data, error } = await admin
    .from("events")
    .select("id, name, kind, opened_at")
    .eq("kind", "encomenda")
    .order("opened_at", { ascending: false })
    .limit(80);
  if (error) throw new Error(error.message);
  const events = new Map<string, { name: string; opened_at: string }>();
  for (const ev of data || []) {
    events.set(ev.id, { name: ev.name || "Rodada de encomenda", opened_at: ev.opened_at || "" });
  }
  return montarRodadas(admin, events, 80);
}

async function montarRodadas(
  admin: ReturnType<typeof createAdminClient>,
  events: Map<string, { name: string; opened_at: string }>,
  limit: number,
) {
  const eventIds = [...events.keys()];
  if (!eventIds.length) return [];

  const { data: allLines, error: linesErr } = await admin
    .from("event_sale_lines")
    .select("event_id, product_title, qty, qty_arrived, cancelled")
    .in("event_id", eventIds)
    .eq("cancelled", false);
  if (linesErr) throw new Error(linesErr.message);

  const { data: stock, error: stockErr } = await admin
    .from("event_product_stock")
    .select("event_id, product_title, qty_arrived, pedido_feito")
    .in("event_id", eventIds);
  if (stockErr) throw new Error(stockErr.message);

  return eventIds
    .map((id) => {
      const ev = events.get(id)!;
      const lines = ((allLines || []) as RoundLine[]).filter((l) => l.event_id === id);
      const products = (stock || []).filter((s) => s.event_id === id);
      return {
        id,
        nome: ev.name,
        etapa: etapaDaRodada(lines, products),
        origem: "japao",
        openedAt: ev.opened_at,
      };
    })
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .slice(0, limit)
    .map(({ openedAt: _opened, ...round }) => round);
}

function readProfile(body: ProfileBody) {
  const phone = canonicalPhone(body.phone || "");
  const siteUserId = clip(body.siteUserId, 40);
  const username = clip(body.username, 32);
  const displayName = clip(body.displayName, 100);
  const email = clipEmail(body.email);
  return { phone, siteUserId, username, displayName, email };
}

export async function POST(req: Request) {
  try {
    assertBotApiKey(req);
    const body = (await req.json()) as ProfileBody;
    const profile = readProfile(body);
    if (!profile.phone || !profile.siteUserId) {
      return NextResponse.json(
        { error: "Informe o celular confirmado e o id da conta." },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const customer = await ensureCustomer(admin, profile.phone, profile);
    const saved = await saveSiteProfile(admin, customer, profile);
    const people = await customersByPhone(admin, profile.phone);
    const items = await holdingsFor(admin, people.length ? people : [customer]);

    return NextResponse.json({
      linked: true,
      profileSaved: saved.saved,
      warning: saved.warning,
      customerName: customer.name,
      items,
    });
  } catch (e) {
    if (e instanceof BotAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Erro ao ligar a conta.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    assertBotApiKey(req);
    const url = new URL(req.url);
    const phone = canonicalPhone(url.searchParams.get("phone") || "");
    const todas = url.searchParams.get("all") === "1";
    if (!phone && !todas) {
      return NextResponse.json({ error: "Informe o celular." }, { status: 400 });
    }

    const admin = createAdminClient();
    if (url.searchParams.get("view") === "viagem") {
      const rounds = todas
        ? await rodadasTodas(admin)
        : await rodadasDaConta(admin, phone);
      return NextResponse.json({ rounds });
    }

    const people = await customersByPhone(admin, phone);
    const items = people.length ? await holdingsFor(admin, people) : [];
    const main = pickCustomer(people, phone);

    return NextResponse.json({
      linked: Boolean(main),
      customerName: main?.name || "",
      items,
    });
  } catch (e) {
    if (e instanceof BotAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Erro ao consultar a garagem.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
