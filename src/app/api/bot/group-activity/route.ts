import { NextResponse } from "next/server";
import { assertBotApiKey, BotAuthError } from "@/lib/bot-auth";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type MemberIn = {
  phone?: string;
  name?: string;
  messageCount?: number;
  lastMessageAt?: string | null;
};

/**
 * Sync snapshot de membros do grupo WhatsApp (bot → estoque).
 * Body: { groupAlias, members: [{ phone, name, messageCount, lastMessageAt }] }
 */
export async function POST(req: Request) {
  try {
    assertBotApiKey(req);
    const body = (await req.json()) as {
      groupAlias?: string;
      members?: MemberIn[];
    };
    const groupAlias = (body.groupAlias || "loja").trim().toLowerCase();
    if (!groupAlias) {
      return NextResponse.json({ error: "groupAlias obrigatório" }, { status: 400 });
    }
    const members = Array.isArray(body.members) ? body.members : [];
    const now = new Date().toISOString();
    const rows = members
      .map((m) => {
        const phone = normalizePhoneDigits(m.phone || "");
        if (!phone || phone.length < 10 || phone.length > 15) return null;
        return {
          group_alias: groupAlias,
          phone_digits: phone,
          name: (m.name || "").trim() || phone,
          message_count: Math.max(0, Number(m.messageCount) || 0),
          present: true,
          last_message_at: m.lastMessageAt || null,
          synced_at: now,
        };
      })
      .filter(Boolean) as Array<{
      group_alias: string;
      phone_digits: string;
      name: string;
      message_count: number;
      present: boolean;
      last_message_at: string | null;
      synced_at: string;
    }>;

    const admin = createAdminClient();

    // Marca todos do alias como ausentes antes do upsert dos atuais
    const { error: markErr } = await admin
      .from("whatsapp_group_activity")
      .update({ present: false, synced_at: now })
      .eq("group_alias", groupAlias);
    if (markErr) {
      return NextResponse.json({ error: markErr.message }, { status: 500 });
    }

    if (rows.length) {
      // Upsert em lotes
      const chunk = 500;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const { error } = await admin.from("whatsapp_group_activity").upsert(slice, {
          onConflict: "group_alias,phone_digits",
        });
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      groupAlias,
      upserted: rows.length,
      syncedAt: now,
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
