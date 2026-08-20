"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();

    try {
      if (mode === "login") {
        const { error: err } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (err) throw err;
      } else {
        const { error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name: name || email.split("@")[0] } },
        });
        if (err) throw err;
      }
      router.replace("/estoque");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na autenticação");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-4 py-16">
      <h1 className="text-2xl font-semibold text-zinc-900">Entrar — Kairyuu Estoque</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Acesso da staff. Cada pessoa usa o próprio login.
      </p>

      <form onSubmit={onSubmit} className="panel mt-8 space-y-3">
        {mode === "signup" ? (
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-600">Nome</span>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Seu nome"
            />
          </label>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-600">E-mail</span>
          <input
            className="field"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-600">Senha</span>
          <input
            className="field"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? "Aguarde..." : mode === "login" ? "Entrar" : "Criar conta"}
        </button>
      </form>

      <button
        type="button"
        className="mt-4 text-sm text-zinc-600 underline"
        onClick={() => setMode(mode === "login" ? "signup" : "login")}
      >
        {mode === "login" ? "Criar conta da staff" : "Já tenho conta"}
      </button>

      <Link href="/setup" className="mt-6 text-sm text-zinc-500 underline">
        Ver passos de configuração
      </Link>
    </main>
  );
}
