import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashSignupCode } from "@/lib/auth/signup-approval";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    let body: {
      email?: string;
      name?: string;
      password?: string;
      code?: string;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
    }

    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const name = String(body.name || "").trim() || email.split("@")[0];
    const password = String(body.password || "");
    const code = String(body.code || "").trim();

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "E-mail inválido." }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json(
        { error: "Senha precisa ter pelo menos 6 caracteres." },
        { status: 400 },
      );
    }
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json(
        { error: "Informe o código de 6 dígitos." },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const codeHash = hashSignupCode(email, code);

    const { data: rows, error: qErr } = await admin
      .from("signup_approvals")
      .select("id, expires_at, consumed_at, code_hash")
      .eq("requester_email", email)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(5);

    if (qErr) {
      return NextResponse.json(
        {
          error: qErr.message.includes("signup_approvals")
            ? "Rode a migration migration_signup_approvals.sql no Supabase."
            : qErr.message,
        },
        { status: 500 },
      );
    }

    const match = (rows || []).find((r) => r.code_hash === codeHash);
    if (!match) {
      return NextResponse.json(
        { error: "Código inválido. Peça um novo ao administrador." },
        { status: 403 },
      );
    }
    if (new Date(match.expires_at).getTime() < Date.now()) {
      return NextResponse.json(
        { error: "Código expirado. Peça um novo." },
        { status: 403 },
      );
    }

    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
      });

    if (createErr || !created.user) {
      return NextResponse.json(
        {
          error:
            createErr?.message ||
            "Não foi possível criar a conta. Se o e-mail já existe, use Entrar.",
        },
        { status: 400 },
      );
    }

    await admin
      .from("signup_approvals")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", match.id);

    // Garante nome no perfil (trigger já cria, mas atualiza)
    await admin
      .from("profiles")
      .update({ name })
      .eq("id", created.user.id);

    return NextResponse.json({
      ok: true,
      message: "Conta criada. Agora você pode entrar.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
