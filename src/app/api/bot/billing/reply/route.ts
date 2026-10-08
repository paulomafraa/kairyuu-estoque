import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import { recordBillingReply, type ReplyInput } from "@/lib/billing-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Resposta de um cliente cobrado (texto e/ou mídia em base64).
 * Body: { phone, waMessageId, kind, text?, receivedAt?, mediaBase64?, mimetype? }
 */
export async function POST(req: Request) {
  try {
    assertBotApiKey(req);
    const body = (await req.json()) as Partial<ReplyInput>;
    if (!body.phone || !body.waMessageId) {
      return NextResponse.json(
        { error: "phone e waMessageId obrigatórios" },
        { status: 400 },
      );
    }
    const admin = createAdminClient();
    const result = await recordBillingReply(admin, {
      phone: body.phone,
      waMessageId: body.waMessageId,
      kind: body.kind || "text",
      text: body.text,
      receivedAt: body.receivedAt,
      mediaBase64: body.mediaBase64,
      mimetype: body.mimetype,
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
