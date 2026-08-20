"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/estoque", label: "Estoque" },
  { href: "/eventos", label: "Eventos" },
  { href: "/envios", label: "Envios" },
  { href: "/clientes", label: "Clientes" },
  { href: "/encomendas", label: "Encomendas" },
  { href: "/auditoria", label: "Auditoria" },
];

export function AppNav({ userName }: { userName?: string }) {
  const pathname = usePathname();

  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-3 lg:px-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-baseline gap-3">
          <Link
            href="/estoque"
            className="text-lg font-semibold tracking-tight text-zinc-900"
          >
            Kairyuu Estoque
          </Link>
          {userName ? <span className="text-sm text-zinc-500">{userName}</span> : null}
        </div>
        <nav className="flex flex-wrap gap-1">
          {links.map((link) => {
            const isActive =
              pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={
                  isActive
                    ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white"
                    : "rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                }
              >
                {link.label}
              </Link>
            );
          })}
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              Sair
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}
