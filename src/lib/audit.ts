import type { SupabaseClient } from "@supabase/supabase-js";

export type StaffAuditInput = {
  action: string;
  detail: string;
  created_by: string | null | undefined;
  entity_type?: string;
  entity_id?: string;
  customer_id?: string | null;
  event_id?: string | null;
};

/** Registra ação no log global (falha silenciosa para não quebrar o fluxo). */
export async function logStaffAction(
  supabase: SupabaseClient,
  input: StaffAuditInput,
): Promise<void> {
  try {
    await supabase.from("staff_audit_log").insert({
      action: input.action,
      detail: input.detail,
      entity_type: input.entity_type || "",
      entity_id: input.entity_id || "",
      customer_id: input.customer_id || null,
      event_id: input.event_id || null,
      created_by: input.created_by || null,
    });
  } catch {
    // ignore
  }
}
