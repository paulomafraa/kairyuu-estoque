import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";

export default function SetupPage() {
  const ready = isSupabaseConfigured();

  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
        Configurar Kairyuu Estoque
      </h1>
      <p className="mt-3 text-zinc-600">
        Antes de usar o app, crie um projeto no Supabase e ligue as variáveis de ambiente.
      </p>

      <ol className="mt-8 list-decimal space-y-4 pl-5 text-sm text-zinc-700">
        <li>
          Crie um projeto em{" "}
          <a
            className="underline"
            href="https://supabase.com"
            target="_blank"
            rel="noreferrer"
          >
            supabase.com
          </a>
          .
        </li>
        <li>
          No SQL Editor, rode o arquivo{" "}
          <code className="rounded bg-zinc-200 px-1">supabase/schema.sql</code>.
        </li>
        <li>
          Em Authentication → Providers, deixe Email habilitado.
          Em Authentication → Providers → Email (ou Settings → Auth),{" "}
          <strong>desative “Allow new users to sign up”</strong> / cadastro
          público — contas novas só passam pelo código no e-mail do admin.
        </li>
        <li>
          No SQL Editor, rode também{" "}
          <code className="rounded bg-zinc-200 px-1">
            supabase/migration_signup_approvals.sql
          </code>
          .
        </li>
        <li>
          Copie <code className="rounded bg-zinc-200 px-1">.env.example</code> para{" "}
          <code className="rounded bg-zinc-200 px-1">.env.local</code> e preencha:
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-100">
{`NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OWNER_APPROVAL_EMAIL=seu@email.com
RESEND_API_KEY=re_...

# Assistente IA (pelo menos uma chave)
GEMINI_API_KEY=...
# opcional: GEMINI_MODEL=gemini-3.6-flash`}
          </pre>
        </li>
        <li>
          No Vercel, adicione as mesmas variáveis (incluindo service role, e-mail
          do dono, Resend e a chave da IA) e faça redeploy.
        </li>
        <li>
          Reinicie <code className="rounded bg-zinc-200 px-1">npm run dev</code>.
        </li>
      </ol>

      <div className="mt-8 panel">
        <p className="text-sm">
          Status das variáveis:{" "}
          {ready ? (
            <span className="font-medium text-emerald-700">ok</span>
          ) : (
            <span className="font-medium text-amber-700">faltando</span>
          )}
        </p>
        {ready ? (
          <Link href="/login" className="btn-primary mt-4 inline-flex">
            Ir para o login
          </Link>
        ) : null}
      </div>
    </main>
  );
}
