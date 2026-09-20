"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Mode = "login" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (err) throw err;
      router.replace("/estoque");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na autenticação");
    } finally {
      setBusy(false);
    }
  }

  async function requestCode() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/signup-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name }),
      });
      const json = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) throw new Error(json.error || "Falha ao pedir código.");
      setCodeSent(true);
      setInfo(
        json.message ||
          "Código enviado ao administrador. Peça o código a ele para concluir.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao pedir código");
    } finally {
      setBusy(false);
    }
  }

  async function onRequestCode(e: FormEvent) {
    e.preventDefault();
    await requestCode();
  }

  async function confirmSignup(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/signup-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password, code }),
      });
      const json = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) throw new Error(json.error || "Falha ao criar conta.");

      const supabase = createClient();
      const { error: err } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (err) {
        setInfo(
          "Conta criada. Agora entre com o mesmo e-mail e senha (login).",
        );
        setMode("login");
        setCodeSent(false);
        setCode("");
        return;
      }
      router.replace("/estoque");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar conta");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-4 py-16">
      <h1 className="text-2xl font-semibold text-zinc-900">
        Entrar — Kairyuu Estoque
      </h1>
      <p className="mt-2 text-sm text-zinc-600">
        Acesso da staff. Novas contas só com código enviado ao e-mail do
        administrador.
      </p>

      {mode === "login" ? (
        <form onSubmit={onLogin} className="panel mt-8 space-y-3">
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
          {info ? <p className="text-sm text-emerald-700">{info}</p> : null}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? "Aguarde..." : "Entrar"}
          </button>
        </form>
      ) : (
        <div className="panel mt-8 space-y-4">
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
            O cadastro não é aberto. Um código de 6 dígitos vai para o e-mail
            pessoal do administrador; só com esse código a conta é criada.
          </p>

          {!codeSent ? (
            <form onSubmit={onRequestCode} className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-600">Nome</span>
                <input
                  className="field"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Seu nome"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-600">E-mail da nova conta</span>
                <input
                  className="field"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-600">Senha desejada</span>
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
              {info ? <p className="text-sm text-emerald-700">{info}</p> : null}
              <button
                type="submit"
                className="btn-primary w-full"
                disabled={busy}
              >
                {busy ? "Enviando..." : "Pedir código ao administrador"}
              </button>
            </form>
          ) : (
            <form onSubmit={confirmSignup} className="space-y-3">
              <p className="text-sm text-zinc-600">
                Conta: <strong>{email}</strong>
              </p>
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-600">
                  Código de 6 dígitos (peça ao admin)
                </span>
                <input
                  className="field font-mono tracking-widest"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="000000"
                />
              </label>
              {error ? <p className="text-sm text-red-700">{error}</p> : null}
              {info ? <p className="text-sm text-emerald-700">{info}</p> : null}
              <button
                type="submit"
                className="btn-primary w-full"
                disabled={busy || code.length !== 6}
              >
                {busy ? "Criando..." : "Confirmar e criar conta"}
              </button>
              <button
                type="button"
                className="btn-secondary w-full"
                disabled={busy}
                onClick={() => void requestCode()}
              >
                Reenviar pedido de código
              </button>
            </form>
          )}
        </div>
      )}

      <button
        type="button"
        className="mt-4 text-sm text-zinc-600 underline"
        onClick={() => {
          setMode(mode === "login" ? "signup" : "login");
          setError(null);
          setInfo(null);
          setCodeSent(false);
          setCode("");
        }}
      >
        {mode === "login" ? "Pedir criação de conta (staff)" : "Já tenho conta"}
      </button>

      <div className="mt-6 flex flex-col gap-2 text-sm text-zinc-500">
        <Link href="/" className="underline">
          Sobre o projeto
        </Link>
        <Link href="/setup" className="underline">
          Ver passos de configuração
        </Link>
      </div>
    </main>
  );
}
