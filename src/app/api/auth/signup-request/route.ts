import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateSignupCode,
  hashSignupCode,
  ownerApprovalEmail,
  sendOwnerEmail,
} from "@/lib/auth/signup-approval";

export const runtime = "nodejs";

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    ""
  );
}

export async function POST(req: Request) {
  try {
    if (!ownerApprovalEmail()) {
      return NextResponse.json(
        {
          error:
            "Cadastro fechado: falta OWNER_APPROVAL_EMAIL no servidor. Contate o administrador.",
        },
        { status: 503 },
      );
    }

    let body: { email?: string; name?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
    }

    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const name = String(body.name || "").trim() || email.split("@")[0];
    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "E-mail inválido." }, { status: 400 });
    }

    const admin = createAdminClient();

    // Já existe usuário?
    const { data: listed } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listed?.users?.some((u) => (u.email || "").toLowerCase() === email)) {
      return NextResponse.json(
        { error: "Este e-mail já tem conta. Use Entrar." },
        { status: 409 },
      );
    }

    // Rate limit simples: máx 3 pedidos abertos/hora por e-mail
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("signup_approvals")
      .select("id", { count: "exact", head: true })
      .eq("requester_email", email)
      .gte("created_at", since);
    if ((count || 0) >= 3) {
      return NextResponse.json(
        {
          error:
            "Muitos pedidos em pouco tempo. Aguarde ou peça o código ao administrador.",
        },
        { status: 429 },
      );
    }

    const code = generateSignupCode();
    const codeHash = hashSignupCode(email, code);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();

    // Invalida códigos abertos anteriores deste e-mail
    await admin
      .from("signup_approvals")
      .update({ consumed_at: new Date().toISOString() })
      .eq("requester_email", email)
      .is("consumed_at", null);

    const { error: insErr } = await admin.from("signup_approvals").insert({
      requester_email: email,
      requester_name: name,
      code_hash: codeHash,
      expires_at: expiresAt,
      request_ip: clientIp(req),
    });
    if (insErr) {
      const msg = insErr.message.includes("signup_approvals")
        ? "Rode a migration migration_signup_approvals.sql no Supabase."
        : insErr.message;
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    await sendOwnerEmail({
      subject: `[Kairyuu] Código para criar conta: ${name}`,
      text: [
        `Pedido de cadastro no Kairyuu Estoque.`,
        ``,
        `Nome: ${name}`,
        `E-mail: ${email}`,
        `Código (válido 20 min): ${code}`,
        ``,
        `Se você não reconhece, ignore este e-mail — a conta NÃO será criada sem o código.`,
      ].join("\n"),
    });

    return NextResponse.json({
      ok: true,
      message:
        "Código enviado ao e-mail do administrador. Peça o código a ele e confirme o cadastro.",
      expires_in_minutes: 20,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
