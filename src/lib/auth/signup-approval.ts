import { createHash, randomInt } from "crypto";

export function ownerApprovalEmail(): string {
  return (process.env.OWNER_APPROVAL_EMAIL || "").trim().toLowerCase();
}

export function hashSignupCode(email: string, code: string): string {
  const salt = process.env.SIGNUP_CODE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "kairyuu";
  return createHash("sha256")
    .update(`${salt}:${email.trim().toLowerCase()}:${code.trim()}`)
    .digest("hex");
}

export function generateSignupCode(): string {
  return String(randomInt(100000, 999999));
}

export async function sendOwnerEmail(opts: {
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const to = ownerApprovalEmail();
  if (!to) {
    throw new Error(
      "Configure OWNER_APPROVAL_EMAIL no servidor (seu e-mail pessoal para aprovar cadastros).",
    );
  }

  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (resendKey) {
    const from =
      process.env.RESEND_FROM_EMAIL?.trim() ||
      "Kairyuu Estoque <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: opts.subject,
        text: opts.text,
        html: opts.html || `<pre style="font-family:sans-serif">${opts.text}</pre>`,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Falha ao enviar e-mail (Resend): ${body.slice(0, 200)}`);
    }
    return;
  }

  const smtpHost = process.env.SMTP_HOST?.trim();
  const smtpUser = process.env.SMTP_USER?.trim();
  const smtpPass = process.env.SMTP_PASS?.trim();
  if (smtpHost && smtpUser && smtpPass) {
    // Envio SMTP mínimo via API Raw (sem dependência): usa fetch para serviços
    // compatíveis não cobre SMTP genérico. Preferimos Resend.
    throw new Error(
      "SMTP genérico ainda não está ligado neste app. Use RESEND_API_KEY (grátis em resend.com) ou peça para adicionarmos SMTP depois.",
    );
  }

  throw new Error(
    "Nenhum provedor de e-mail configurado. Defina RESEND_API_KEY (e opcional RESEND_FROM_EMAIL) no Vercel.",
  );
}
