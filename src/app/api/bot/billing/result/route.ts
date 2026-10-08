import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import { reportBillingResult, type ResultInput } from "@/lib/billing-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Resultado do envio de uma cobrança.
 * Body: { itemId, ok, error?, soft?, waMessageId? } → { run }
 */
export async function POST(req: Request) {
  try {
    assertBotApiKey(req);
    const body = (await req.json()) as Partial<ResultInput>;
    if (!body.itemId) {
      return NextResponse.json({ error: "itemId obrigatório" }, { status: 400 });
    }
    const admin = createAdminClient();
    const result = await reportBillingResult(admin, {
      itemId: body.itemId,
      ok: Boolean(body.ok),
      error: body.error,
      soft: Boolean(body.soft),
      waMessageId: body.waMessageId,
    });
    return NextResponse.json(result);
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
