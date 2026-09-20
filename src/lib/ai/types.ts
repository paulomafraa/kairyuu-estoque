export type AiChatRole = "user" | "assistant";

export type AiChatMessage = {
  role: AiChatRole;
  content: string;
};

export type ActionProposal =
  | {
      id: string;
      kind: "mark_paid";
      title: string;
      summary: string;
      customer_id: string;
      customer_name: string;
      line_ids: string[];
      lines: Array<{
        id: string;
        product_title: string;
        event_name: string;
        qty: number;
        total: number | null;
      }>;
      total: number | null;
    }
  | {
      id: string;
      kind: "mark_charged";
      title: string;
      summary: string;
      value: boolean;
      line_ids: string[];
      lines: Array<{
        id: string;
        product_title: string;
        event_name: string;
      }>;
    }
  | {
      id: string;
      kind: "mark_separated";
      title: string;
      summary: string;
      value: boolean;
      line_ids: string[];
      lines: Array<{
        id: string;
        product_title: string;
        event_name: string;
      }>;
    }
  | {
      id: string;
      kind: "cancel_lines";
      title: string;
      summary: string;
      reason: string;
      line_ids: string[];
      lines: Array<{
        id: string;
        product_title: string;
        event_name: string;
        qty: number;
      }>;
    }
  | {
      id: string;
      kind: "unpay_lines";
      title: string;
      summary: string;
      line_ids: string[];
      lines: Array<{
        id: string;
        product_title: string;
        event_name: string;
      }>;
    }
  | {
      id: string;
      kind: "ship_garage_items";
      title: string;
      summary: string;
      customer_id: string;
      customer_name: string;
      item_ids: string[];
      items: Array<{
        id: string;
        title: string;
        qty: number;
        event_name: string;
      }>;
      shipped_on: string;
    }
  | {
      id: string;
      kind: "cancel_garage_item";
      title: string;
      summary: string;
      reason: string;
      item_id: string;
      item_title: string;
      customer_id: string;
    }
  | {
      id: string;
      kind: "add_customer_note";
      title: string;
      summary: string;
      customer_id: string;
      customer_name: string;
      body: string;
    }
  | {
      id: string;
      kind: "set_encomenda_stock";
      title: string;
      summary: string;
      event_id: string;
      product_title: string;
      pedido_feito?: boolean;
      qty_arrived?: number;
    };

export type ToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  proposals?: ActionProposal[];
};
