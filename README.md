# Kairyuu Estoque

Sistema web interno da [Kairyuu](https://github.com/paulomafraa) para estoque, eventos, clientes, encomendas e envios.

> App de uso da staff (login obrigatório). Este repositório é público para portfólio — não expõe dados nem o detalhe operacional da loja.

**Página do projeto:** abra a raiz do deploy (ou rode local e acesse `/`) sem estar logado.

## Evolução

| | Projeto | Foco |
|---|---|---|
| v1 | [ControleEstoque](https://github.com/paulomafraa/ControleEstoque) | Desktop C# / WinForms, dados locais |
| v2 | [GerenciadorEstoque.v2](https://github.com/paulomafraa/GerenciadorEstoque.v2) | Blazor + API + MySQL no Google Cloud |
| **v3** | **este repo** | Next.js + Supabase + Vercel, alinhado à operação real |

Cada versão ampliou o escopo: do inventário local → multi-usuário na nuvem → produto completo para o dia a dia da loja.

## Stack

- Next.js (App Router) + TypeScript + Tailwind
- Supabase (Auth + Postgres)
- Deploy: Vercel

## Setup

1. Crie um projeto no [Supabase](https://supabase.com).
2. No SQL Editor, execute `supabase/schema.sql` (e as migrations em `supabase/` se precisar).
3. Copie as variáveis:

```bash
cp .env.example .env.local
```

Preencha `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

4. Rode:

```bash
npm install
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000) — landing pública — e use **Entrar** para a área da staff.

## Deploy

- Front: Vercel (mesmo repo + env vars).
- Banco/auth: Supabase.

## Licença / uso

Código aberto para estudo e portfólio. Dados de produção e credenciais não entram neste repositório.
