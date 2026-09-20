import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executeActionProposal } from "@/lib/ai/mutations";
import type { ActionProposal } from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
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
  const meName = profile?.name || user.email || "Staff";

  let body: { proposal?: ActionProposal };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const proposal = body.proposal;
  if (!proposal?.kind || !proposal.id) {
    return NextResponse.json({ error: "Proposta inválida." }, { status: 400 });
  }

  try {
    const result = await executeActionProposal(
      supabase,
      proposal,
      user.id,
      meName,
    );
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, message: msg }, { status: 500 });
  }
}
