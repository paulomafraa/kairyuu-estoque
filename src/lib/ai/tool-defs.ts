/** Declarações de tools no formato Gemini (OpenAPI-ish). */

export const AI_TOOL_DECLARATIONS = [
  {
    name: "resolve_customer",
    description:
      "Busca cliente por nome, telefone ou WhatsApp. Use antes de qualquer ação no cliente. Se houver vários, liste e peça confirmação.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Nome, apelido ou telefone/WhatsApp",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "resolve_event",
    description:
      "Busca eventos (leilão/encomenda) por nome, data (AAAA-MM-DD ou MM/AAAA) ou tipo.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nome ou trecho do evento" },
        kind: {
          type: "string",
          description: "leilao | encomenda | outro (opcional)",
        },
        date_hint: {
          type: "string",
          description: "Data aproximada AAAA-MM-DD ou AAAA-MM",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "report_pending_payments",
    description:
      "Relatório global de pessoas/itens com pagamento pendente. Use para perguntas como 'quantas pessoas devem até o dia 15', 'quem está em atraso', totais em aberto. Filtra por prazo (payment_due_at do evento).",
    parameters: {
      type: "object",
      properties: {
        due_on_or_before: {
          type: "string",
          description:
            "AAAA-MM-DD — inclui quem vence nesta data ou antes (e atrasados). Ex.: dia 15 deste mês = 2026-09-15",
        },
        due_on_or_after: {
          type: "string",
          description: "AAAA-MM-DD — só prazos a partir desta data",
        },
        only_overdue: {
          type: "boolean",
          description: "Se true, só quem já passou do prazo (antes de hoje)",
        },
        include_without_due: {
          type: "boolean",
          description:
            "Incluir pendências sem data de prazo no evento (default false)",
        },
        event_kind: {
          type: "string",
          description: "leilao | encomenda | outro (opcional)",
        },
        limit_people: {
          type: "number",
          description: "Máx. pessoas na lista detalhada (default 40)",
        },
      },
    },
  },
  {
    name: "get_customer_overview",
    description:
      "Resumo do cliente: cobranças em aberto, itens na caixinha, enviados recentes e eventos.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "list_open_charges",
    description:
      "Lista itens cobráveis em aberto (não pagos) de um cliente, opcionalmente filtrando por evento.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        event_id: { type: "string" },
        event_ids: {
          type: "array",
          items: { type: "string" },
          description: "Vários eventos de uma vez",
        },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "list_garage",
    description:
      "Lista itens da caixinha/garagem do cliente (na loja, enviados, cancelados).",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        status: {
          type: "string",
          description:
            "in_garage | shipped | delivered | cancelled | reserved | all",
        },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "list_pending_shipments",
    description:
      "Lista o que ainda está na loja para enviar (todos os clientes ou um).",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "search_cards",
    description: "Consulta estoque físico de cartas por nome/set.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "draft_billing_message",
    description:
      "Monta texto de cobrança WhatsApp para itens em aberto do cliente (um ou vários eventos).",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        event_ids: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "list_recent_audit",
    description: "Últimas ações do staff (auditoria), opcionalmente por cliente.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "propose_mark_paid",
    description:
      "PROPÕE marcar itens como pagos (cria caixinha). NÃO executa sozinho — gera cartão de confirmação. Informe customer_id e event_ids ou line_ids.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        event_ids: { type: "array", items: { type: "string" } },
        line_ids: { type: "array", items: { type: "string" } },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "propose_mark_charged",
    description:
      "PROPÕE marcar/desmarcar cobrança feita. Gera confirmação.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        event_ids: { type: "array", items: { type: "string" } },
        line_ids: { type: "array", items: { type: "string" } },
        value: { type: "boolean", description: "true=cobrado, false=desfazer" },
      },
      required: ["customer_id", "value"],
    },
  },
  {
    name: "propose_mark_separated",
    description: "PROPÕE marcar/desmarcar separado. Gera confirmação.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        event_ids: { type: "array", items: { type: "string" } },
        line_ids: { type: "array", items: { type: "string" } },
        value: { type: "boolean" },
      },
      required: ["customer_id", "value"],
    },
  },
  {
    name: "propose_cancel_lines",
    description:
      "PROPÕE cancelar linhas de venda/encomenda (e caixinha ligada). Motivo obrigatório.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        event_ids: { type: "array", items: { type: "string" } },
        line_ids: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
      },
      required: ["customer_id", "reason"],
    },
  },
  {
    name: "propose_unpay_lines",
    description:
      "PROPÕE desfazer pagamento (só se ainda não enviou). Gera confirmação.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        event_ids: { type: "array", items: { type: "string" } },
        line_ids: { type: "array", items: { type: "string" } },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "propose_ship_garage",
    description:
      "PROPÕE marcar itens da caixinha como enviados (qty na loja → enviado).",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        item_ids: { type: "array", items: { type: "string" } },
        event_id: {
          type: "string",
          description: "Se informado, envia todos da loja desse evento",
        },
        shipped_on: {
          type: "string",
          description: "AAAA-MM-DD (default hoje)",
        },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "propose_cancel_garage_item",
    description: "PROPÕE cancelar/estornar um item da caixinha.",
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["item_id", "reason"],
    },
  },
  {
    name: "propose_add_note",
    description: "PROPÕE adicionar nota na ficha do cliente.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        body: { type: "string" },
      },
      required: ["customer_id", "body"],
    },
  },
  {
    name: "propose_encomenda_stock",
    description:
      "PROPÕE marcar pedido feito e/ou qty chegou na central de encomenda (por produto do evento).",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        product_title: { type: "string" },
        pedido_feito: { type: "boolean" },
        qty_arrived: { type: "number" },
      },
      required: ["event_id", "product_title"],
    },
  },
] as const;

export type AiToolName = (typeof AI_TOOL_DECLARATIONS)[number]["name"];
