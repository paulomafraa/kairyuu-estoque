# Kairyuu Estoque

Sistema web de estoque, eventos (caixa física), clientes e encomendas da loja Kairyuu.

## Stack

- Next.js (App Router) + TypeScript + Tailwind
- Supabase (Auth + Postgres + funções de movimento de estoque)

## Setup rápido

1. Crie um projeto no [Supabase](https://supabase.com).
2. No **SQL Editor**, cole e execute `supabase/schema.sql`.
3. Em **Authentication → Providers**, deixe e-mail habilitado.
4. Copie as chaves em **Project Settings → API**.
5. Na pasta do projeto:

```bash
cp .env.example .env.local
```

Preencha `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

6. Rode o app:

```bash
npm install
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000), crie a conta da staff e comece pelo **Estoque**.

## Fluxo operacional

1. **Estoque** — cadastra carta (quais + quantas). Marque **encomendável** se dá para pedir sem ter no estoque.
2. **Eventos** — abre evento com **responsável**. Aloque cartas do estoque geral para a **caixa física**.
3. No fechamento — indique quem ficou com o quê; **confirme** só com certeza de envio/pagamento; **feche** o evento (sobras voltam ao estoque).
4. **Clientes** — histórico com origem (evento / venda direta / encomenda) + venda direta.
5. **Encomendas** — status Japão → Brasil → sede → enviado → entregue. Entra no estoque só na **sede**; envio baixa estoque e grava no cliente.

## Várias pessoas na staff

- Cada um com login próprio.
- Um **responsável por evento** (evento X ≠ evento Y).
- Quem não é responsável ainda consegue ver; a UI avisa para não fechar evento alheio.
- Todo movimento importante passa por funções SQL (evita estoque negativo e inconsistência na caixa).

## Deploy

- Front: Vercel (aponta o repo e coloca as mesmas env vars).
- Banco/auth: Supabase (já na nuvem).

## Próximos ajustes (quando quiser)

- Travar de verdade no banco: só o `owner_id` fecha/confirma o evento
- Papéis admin vs staff
- Importação em massa de cartas
- Relatório de movimentos
