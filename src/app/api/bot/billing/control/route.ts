import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import { controlBilling } from "@/lib/billing-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** Body: { action: "status" | "pause" | "resume" } */
export async function POST(req: Request) {
  try {
    assertBotApiKey(req);
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action =
      body.action === "pause" || body.action === "resume" ? body.action : "status";
    const admin = createAdminClient();
    return NextResponse.json(await controlBilling(admin, action));
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
