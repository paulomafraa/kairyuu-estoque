import Link from "next/link";

const EVOLUTION = [
  {
    version: "v1",
    name: "ControleEstoque",
    era: "2025",
    stack: "C# · Windows Forms",
    summary:
      "Desktop local: produtos, entradas/saídas e leitura financeira básica em arquivos.",
    href: "https://github.com/paulomafraa/ControleEstoque",
  },
  {
    version: "v2",
    name: "GerenciadorEstoque.v2",
    era: "2026",
    stack: "Blazor · ASP.NET · Cloud Run",
    summary:
      "Web multi-usuário com API, banco na nuvem e deploy containerizado.",
    href: "https://github.com/paulomafraa/GerenciadorEstoque.v2",
  },
  {
    version: "v3",
    name: "kairyuu-estoque",
    era: "agora",
    stack: "Next.js · Supabase · Vercel",
    summary:
      "Operação completa da loja: estoque, eventos, clientes, encomendas e envios — com auth e dados consistentes.",
    href: "https://github.com/paulomafraa/kairyuu-estoque",
    current: true,
  },
] as const;

const CAPABILITIES = [
  {
    title: "Estoque vivo",
    text: "Cadastro e movimentação com regras no banco para evitar inconsistência.",
  },
  {
    title: "Eventos e caixa",
    text: "Alocação física, fechamento e rastreio do que saiu da operação.",
  },
  {
    title: "Clientes e envios",
    text: "Histórico por pessoa e fila do que ainda precisa ir embora.",
  },
  {
    title: "Encomendas",
    text: "Acompanhamento do pedido até entrar no estoque e ser enviado.",
  },
  {
    title: "Equipe",
    text: "Login individual, responsável por evento e trilha de auditoria.",
  },
  {
    title: "Fechamento",
    text: "Resumos e exportações para conferência depois do evento.",
  },
] as const;

export function ProjectLanding() {
  return (
    <div className="landing relative min-h-full overflow-hidden bg-zinc-950 text-zinc-100">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(45,212,191,0.18),transparent_55%),radial-gradient(ellipse_50%_40%_at_100%_20%,rgba(251,191,36,0.08),transparent_50%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(rgba(255,255,255,0.7)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.7)_1px,transparent_1px)] [background-size:48px_48px]"
      />

      <header className="landing-fade relative mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <p className="text-sm font-semibold tracking-wide text-teal-300/90">
          Kairyuu Estoque
        </p>
        <Link
          href="/login"
          className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white"
        >
          Entrar
        </Link>
      </header>

      <main>
        <section className="relative mx-auto max-w-5xl px-6 pb-20 pt-10 sm:pt-16">
          <p className="landing-fade landing-delay-1 text-sm uppercase tracking-[0.2em] text-teal-300/80">
            Produto interno · TCG
          </p>
          <h1 className="landing-fade landing-delay-2 mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl sm:leading-[1.1]">
            Kairyuu Estoque
          </h1>
          <p className="landing-fade landing-delay-3 mt-5 max-w-xl text-lg text-zinc-400">
            A terceira geração do controle de estoque da loja — feita para o
            dia a dia real: equipe, eventos e o caminho até o envio.
          </p>
          <div className="landing-fade landing-delay-4 mt-8 flex flex-wrap gap-3">
            <Link
              href="/login"
              className="rounded-md bg-teal-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-teal-300"
            >
              Acessar o sistema
            </Link>
            <a
              href="https://github.com/paulomafraa/kairyuu-estoque"
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-700 bg-zinc-900/60 px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:border-zinc-500 hover:bg-zinc-900"
            >
              Ver no GitHub
            </a>
          </div>
        </section>

        <section className="relative border-t border-zinc-800/80 bg-zinc-950/80">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 className="text-2xl font-semibold text-white">Evolução</h2>
            <p className="mt-2 max-w-2xl text-zinc-400">
              Começou no desktop, passou por um app web na nuvem e chegou a um
              produto alinhado à operação da Kairyuu.
            </p>
            <ol className="mt-10 grid gap-4 sm:grid-cols-3">
              {EVOLUTION.map((item) => (
                <li
                  key={item.version}
                  className={`rounded-xl border p-5 ${
                    item.current
                      ? "border-teal-500/40 bg-teal-950/30"
                      : "border-zinc-800 bg-zinc-900/40"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-teal-300/90">
                      {item.version}
                    </span>
                    <span className="text-xs text-zinc-500">{item.era}</span>
                  </div>
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 block text-lg font-medium text-white underline-offset-4 hover:underline"
                  >
                    {item.name}
                  </a>
                  <p className="mt-1 text-xs text-zinc-500">{item.stack}</p>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                    {item.summary}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="relative border-t border-zinc-800/80">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 className="text-2xl font-semibold text-white">O que cobre</h2>
            <p className="mt-2 max-w-2xl text-zinc-400">
              Visão geral do produto — sem detalhar processos internos da loja.
            </p>
            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map((item) => (
                <li
                  key={item.title}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5"
                >
                  <h3 className="font-medium text-zinc-100">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                    {item.text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="relative border-t border-zinc-800/80 bg-zinc-900/20">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 className="text-2xl font-semibold text-white">Stack</h2>
            <p className="mt-4 text-zinc-400">
              Next.js (App Router) · TypeScript · Tailwind · Supabase (Auth +
              Postgres) · Vercel
            </p>
            <p className="mt-8 text-sm text-zinc-500">
              Uso interno da staff. O repositório é público para portfólio e
              estudo — dados e acesso continuam protegidos.
            </p>
          </div>
        </section>
      </main>

      <footer className="relative border-t border-zinc-800/80 px-6 py-8 text-center text-sm text-zinc-600">
        Paulo ·{" "}
        <a
          href="https://github.com/paulomafraa"
          target="_blank"
          rel="noreferrer"
          className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
        >
          github.com/paulomafraa
        </a>
      </footer>
    </div>
  );
}
