import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import { claimNextBilling } from "@/lib/billing-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Bot pergunta a próxima cobrança.
 * Body: { canSend: boolean } → { run, item, waitMs, watch }
 */
export async function POST(req: Request) {
  try {
    assertBotApiKey(req);
    const body = (await req.json().catch(() => ({}))) as { canSend?: boolean };
    const admin = createAdminClient();
    const result = await claimNextBilling(admin, {
      canSend: body.canSend !== false,
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
