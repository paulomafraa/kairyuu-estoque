import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import {
  billingRecipientLookup,
  fetchBillingRecipients,
  fetchCustomerPhoneSets,
  splitInactivePhones,
} from "@/lib/customer-activity";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Cruza telefones com cadastro/compra no estoque.
 * Body: { phones: string[] }
 * → { inactive, active, purchased }
 * active = cadastrado em customers OU telefone em sale line
 * purchased = qualquer pedido, menos quem está numa lista de cobrança
 * billed / billingNames = nome e telefone dessas cobranças (entram nos inativos)
 */
export async function POST(req: Request) {
  try {
    assertBotApiKey(req);
    const body = (await req.json()) as { phones?: string[] };
    const phones = Array.isArray(body.phones) ? body.phones : [];
    if (phones.length > 20000) {
      return NextResponse.json(
        { error: "Muitos telefones (máx. 20000)." },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const [{ protected: protectedPhones, purchased: purchasePhones }, recipients] =
      await Promise.all([
        fetchCustomerPhoneSets(admin),
        fetchBillingRecipients(admin),
      ]);
    const { inactive, active } = splitInactivePhones(phones, protectedPhones);
    const { active: purchasedAll } = splitInactivePhones(phones, purchasePhones);
    const byVariant = billingRecipientLookup(recipients);
    const billed: string[] = [];
    const billingNames: Record<string, string> = {};
    const purchased: string[] = [];
    for (const phone of purchasedAll) {
      const hit = byVariant.get(normalizePhoneDigits(phone));
      if (hit) continue;
      purchased.push(phone);
    }
    for (const raw of phones) {
      const d = normalizePhoneDigits(raw);
      if (!d) continue;
      const hit = byVariant.get(d);
      if (!hit) continue;
      billed.push(d);
      if (hit.name) billingNames[d] = hit.name;
    }

    return NextResponse.json({
      inactive,
      active,
      purchased,
      billed,
      billingNames,
      checked: inactive.length + active.length,
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
