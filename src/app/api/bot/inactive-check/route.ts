import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import {
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
 * purchased = qualquer pedido (leilão / encomenda / evento / pedido / item / garagem)
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
    const { protected: protectedPhones, purchased: purchasePhones } =
      await fetchCustomerPhoneSets(admin);
    const { inactive, active } = splitInactivePhones(phones, protectedPhones);
    const { active: purchased } = splitInactivePhones(phones, purchasePhones);

    return NextResponse.json({
      inactive,
      active,
      purchased,
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
