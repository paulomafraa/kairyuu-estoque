export type StaffRole = "admin" | "staff";

export type EventStatus = "open" | "closing" | "closed";

export type AssignmentStatus = "indicated" | "confirmed";

export type OriginType = "event" | "direct_sale" | "encomenda";

export type Profile = {
  id: string;
  name: string;
  role: StaffRole;
  created_at: string;
};

export type GarageCategory =
  | "carta"
  | "caixa"
  | "deck"
  | "sleeve"
  | "acessorio"
  | "outro";

export type GarageStatus =
  | "reserved"
  | "in_garage"
  | "shipped"
  | "delivered"
  | "cancelled";

export type GarageOrigin =
  | "leilao"
  | "encomenda"
  | "compra_direta"
  | "evento"
  | "outro";

export type GarageItem = {
  id: string;
  customer_id: string;
  title: string;
  category: GarageCategory;
  qty: number;
  qty_with_store: number;
  qty_sent: number;
  qty_delivered: number;
  status: GarageStatus;
  reserved_until: string | null;
  origin: GarageOrigin;
  event_name: string;
  event_date: string | null;
  event_id?: string | null;
  unit_price: number | null;
  notes: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string;
  created_by_profile?: Pick<Profile, "id" | "name"> | null;
  cancelled_by_profile?: Pick<Profile, "id" | "name"> | null;
};

export type CustomerNote = {
  id: string;
  customer_id: string;
  body: string;
  created_at: string;
  created_by: string | null;
  created_by_profile?: Pick<Profile, "id" | "name"> | null;
};

export type CustomerPhoto = {
  id: string;
  customer_id: string;
  storage_path: string;
  public_url: string;
  caption: string;
  created_at: string;
  created_by: string | null;
  created_by_profile?: Pick<Profile, "id" | "name"> | null;
};

export type OrderStatus =
  | "pedido_japao"
  | "chegou_brasil"
  | "sede_kairyuu"
  | "enviado"
  | "entregue";

export type Card = {
  id: string;
  name: string;
  set_code: string;
  condition: string;
  qty_in_stock: number;
  orderable: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type Customer = {
  id: string;
  name: string;
  phone: string;
  phone_digits?: string | null;
  source?: "manual" | "whatsapp_group";
  notes: string;
  created_at: string;
};

export type Event = {
  id: string;
  name: string;
  status: EventStatus;
  owner_id: string | null;
  notes: string;
  opened_at: string;
  closed_at: string | null;
  payment_due_at?: string | null;
  kind?: "leilao" | "encomenda" | "outro";
  use_stock_box?: boolean;
};

export type EventProductCost = {
  id: string;
  event_id: string;
  product_title: string;
  cost_jp: number | null;
  price_sale: number | null;
  price_liga: number | null;
  link: string;
  created_at: string;
};

export type EventSaleLine = {
  id: string;
  event_id: string;
  customer_id: string | null;
  phone_digits: string;
  customer_name_snapshot: string;
  product_title: string;
  valor_ou_opcao: string;
  unit_price: number | null;
  qty: number;
  import_status:
    | "arrematado"
    | "lance"
    | "voto"
    | "verificar_manual"
    | "sem_voto"
    | "manual";
  certainty: "certain" | "manual_review";
  arremate: boolean;
  poll_id: string;
  separated: boolean;
  separated_at: string | null;
  separated_by: string | null;
  charged: boolean;
  charged_at: string | null;
  charged_by: string | null;
  paid: boolean;
  paid_at: string | null;
  paid_by: string | null;
  garage_item_id: string | null;
  cancelled: boolean;
  cancel_reason: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  notes: string;
  archived?: boolean;
  created_at: string;
  created_by: string | null;
  customers?: Pick<Customer, "id" | "name" | "phone"> | null;
};

export type EventProductStock = {
  id: string;
  event_id: string;
  product_title: string;
  qty_arrived: number;
  notes: string;
  updated_at: string;
  updated_by: string | null;
};

export type EventAllocation = {
  id: string;
  event_id: string;
  card_id: string;
  qty: number;
  created_at: string;
  cards?: Card;
};

export type EventAssignment = {
  id: string;
  event_id: string;
  card_id: string;
  customer_id: string;
  qty: number;
  unit_price: number | null;
  status: AssignmentStatus;
  created_at: string;
  confirmed_at: string | null;
  cards?: Card;
  customers?: Customer;
};

export type CustomerItem = {
  id: string;
  customer_id: string;
  card_id: string;
  qty: number;
  origin_type: OriginType;
  event_id: string | null;
  order_id: string | null;
  unit_price: number | null;
  notes: string;
  acquired_at: string;
  cards?: Card;
  events?: Pick<Event, "id" | "name"> | null;
};

export type Order = {
  id: string;
  customer_id: string;
  card_id: string | null;
  card_name: string;
  qty: number;
  status: OrderStatus;
  stocked: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  customers?: Customer;
  cards?: Card | null;
  created_by_profile?: Pick<Profile, "id" | "name"> | null;
};

export type GarageAuditEvent = {
  id: string;
  customer_id: string;
  item_id: string | null;
  action: string;
  detail: string;
  created_at: string;
  created_by: string | null;
  created_by_profile?: Pick<Profile, "id" | "name"> | null;
};

export type StockMovement = {
  id: string;
  card_id: string;
  qty_delta: number;
  reason: string;
  event_id: string | null;
  customer_id: string | null;
  order_id: string | null;
  user_id: string | null;
  notes: string;
  created_at: string;
};

type TableDef<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: TableDef<Profile, { id: string; name: string; role?: StaffRole }>;
      cards: TableDef<
        Card,
        {
          name: string;
          set_code?: string;
          condition?: string;
          qty_in_stock?: number;
          orderable?: boolean;
          notes?: string;
        }
      >;
      customers: TableDef<
        Customer,
        { name: string; phone?: string; notes?: string }
      >;
      events: TableDef<
        Event,
        {
          name: string;
          status?: EventStatus;
          owner_id?: string | null;
          notes?: string;
        }
      >;
      event_allocations: TableDef<
        EventAllocation,
        { event_id: string; card_id: string; qty: number }
      >;
      event_assignments: TableDef<
        EventAssignment,
        {
          event_id: string;
          card_id: string;
          customer_id: string;
          qty: number;
          unit_price?: number | null;
          status?: AssignmentStatus;
        }
      >;
      customer_items: TableDef<
        CustomerItem,
        {
          customer_id: string;
          card_id: string;
          qty: number;
          origin_type: OriginType;
          event_id?: string | null;
          order_id?: string | null;
          unit_price?: number | null;
          notes?: string;
        }
      >;
      orders: TableDef<
        Order,
        {
          customer_id: string;
          card_name: string;
          card_id?: string | null;
          qty?: number;
          status?: OrderStatus;
          stocked?: boolean;
          notes?: string;
        }
      >;
      stock_movements: TableDef<
        StockMovement,
        {
          card_id: string;
          qty_delta: number;
          reason: string;
          event_id?: string | null;
          customer_id?: string | null;
          order_id?: string | null;
          user_id?: string | null;
          notes?: string;
        }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      allocate_to_event: {
        Args: {
          p_event_id: string;
          p_card_id: string;
          p_qty: number;
          p_user_id?: string;
        };
        Returns: undefined;
      };
      return_from_event: {
        Args: {
          p_event_id: string;
          p_card_id: string;
          p_qty: number;
          p_user_id?: string;
        };
        Returns: undefined;
      };
      confirm_assignment: {
        Args: { p_assignment_id: string; p_user_id?: string };
        Returns: undefined;
      };
      close_event: {
        Args: { p_event_id: string; p_user_id?: string };
        Returns: undefined;
      };
      direct_sale: {
        Args: {
          p_customer_id: string;
          p_card_id: string;
          p_qty: number;
          p_unit_price?: number | null;
          p_notes?: string;
          p_user_id?: string;
        };
        Returns: undefined;
      };
      mark_order_arrived_hq: {
        Args: { p_order_id: string; p_user_id?: string };
        Returns: undefined;
      };
      ship_order_to_customer: {
        Args: { p_order_id: string; p_user_id?: string };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
