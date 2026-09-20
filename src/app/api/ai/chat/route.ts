import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { aiProviderConfigured, runStaffAiChat } from "@/lib/ai/provider";
import type { AiChatMessage } from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const cfg = aiProviderConfigured();
  if (!cfg.ok) {
    return NextResponse.json({ error: cfg.message }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("name")
    .eq("id", user.id)
    .maybeSingle();
  const staffName = profile?.name || user.email || "Staff";

  let body: {
    messages?: AiChatMessage[];
    pagePath?: string;
    customerId?: string;
    eventId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const messages = (body.messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      content: String(m.content || "").slice(0, 8000),
    }))
    .slice(-16);

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "Envie pelo menos uma mensagem do usuário." },
      { status: 400 },
    );
  }

  try {
    const result = await runStaffAiChat({
      supabase,
      messages,
      staffName,
      pagePath: body.pagePath,
      customerId: body.customerId,
      eventId: body.eventId,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
