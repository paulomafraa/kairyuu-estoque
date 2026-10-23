import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import { phonesMatch, phoneVariants } from "@/lib/customers";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type MemberIn = { phone?: string; name?: string };

type Existing = { id: string; name: string; phone_digits: string };

function nameIsOnlyPhone(name: string, phone: string): boolean {
  const digits = normalizePhoneDigits(name);
  if (digits.length < 10 || digits !== (name || "").replace(/\D/g, "")) return false;
  return phonesMatch(digits, phone);
}

/**
 * Recebe os membros do grupo (o que o CSV do bot levaria) e cadastra no estoque.
 * Novo telefone entra. Nome real só preenche ficha que ainda está como número.
 * Nome já escrito na ficha não é trocado.
 */
export async function POST(req: Request) {
  try {
    assertBotApiKey(req);
    const body = (await req.json()) as { members?: MemberIn[] };
    const members = Array.isArray(body.members) ? body.members : [];
    if (members.length > 5000) {
      return NextResponse.json({ error: "Muitos contatos (máx. 5000)." }, { status: 400 });
    }

    const incoming = new Map<string, string>();
    let invalid = 0;
    for (const m of members) {
      const phone = normalizePhoneDigits(m.phone || "");
      if (!phone || phone.length < 10 || phone.length > 15) {
        invalid += 1;
        continue;
      }
      const name = (m.name || "").trim() || phone;
      const prev = incoming.get(phone);
      if (!prev || (nameIsOnlyPhone(prev, phone) && !nameIsOnlyPhone(name, phone))) {
        incoming.set(phone, name);
      }
    }

    const admin = createAdminClient();
    const byVariant = new Map<string, Existing>();
    const phones = [...incoming.keys()];
    const variantList = [...new Set(phones.flatMap((p) => phoneVariants(p)))];

    for (let i = 0; i < variantList.length; i += 150) {
      const slice = variantList.slice(i, i + 150);
      const { data, error } = await admin
        .from("customers")
        .select("id, name, phone_digits")
        .in("phone_digits", slice);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      for (const row of (data || []) as Existing[]) {
        for (const v of phoneVariants(row.phone_digits || "")) {
          if (!byVariant.has(v)) byVariant.set(v, row);
        }
      }
    }

    const toInsert: Array<{
      name: string;
      phone: string;
      phone_digits: string;
      source: "whatsapp_group";
      notes: string;
    }> = [];
    const toRename: Array<{ id: string; name: string }> = [];
    let skipped = 0;

    for (const [phone, name] of incoming) {
      const existing = phoneVariants(phone)
        .map((v) => byVariant.get(v))
        .find(Boolean);
      if (!existing) {
        toInsert.push({
          name,
          phone,
          phone_digits: phone,
          source: "whatsapp_group",
          notes: "",
        });
        continue;
      }
      if (
        !nameIsOnlyPhone(name, phone) &&
        nameIsOnlyPhone(existing.name || "", existing.phone_digits || phone)
      ) {
        toRename.push({ id: existing.id, name });
        continue;
      }
      skipped += 1;
    }

    let inserted = 0;
    const isDuplicate = (message: string) =>
      /duplicate key|unique constraint|phone_digits/i.test(message);

    for (let i = 0; i < toInsert.length; i += 100) {
      const chunk = toInsert.slice(i, i + 100);
      const { error } = await admin.from("customers").insert(chunk);
      if (error && isDuplicate(error.message)) {
        for (const row of chunk) {
          const one = await admin.from("customers").insert(row);
          if (!one.error) {
            inserted += 1;
            continue;
          }
          if (isDuplicate(one.error.message)) {
            skipped += 1;
            continue;
          }
          return NextResponse.json({ error: one.error.message }, { status: 500 });
        }
        continue;
      }
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      inserted += chunk.length;
    }

    let renamed = 0;
    for (const row of toRename) {
      const { error } = await admin.from("customers").update({ name: row.name }).eq("id", row.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      renamed += 1;
    }

    return NextResponse.json({
      ok: true,
      received: members.length,
      inserted,
      renamed,
      skipped,
      invalid,
    });
  } catch (e) {
    if (e instanceof BotAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
