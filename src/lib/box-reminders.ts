import { createAdminClient } from "@/lib/supabase/admin";
import {
  anchorDay,
  loadBoxHoldings,
  reminderMilestone,
  type ReminderMilestone,
  type StoreItem,
} from "@/lib/box-holdings";

type BoxRow = {
  id: string;
  label: string;
  phone: string | null;
  phone_digits: string | null;
  email: string | null;
};

const MILESTONE_TEXT: Record<ReminderMilestone, string> = {
  "14": "faltam 2 semanas",
  "7": "falta 1 semana",
  "1": "falta 1 dia",
};

function milestoneSubject(milestone: ReminderMilestone): string {
  if (milestone === "14") return "Kairyuu TCG · faltam 2 semanas para pedir o envio";
  if (milestone === "7") return "Kairyuu TCG · falta 1 semana para pedir o envio";
  return "Kairyuu TCG · falta 1 dia para pedir o envio";
}

function emailText(boxLabel: string, milestone: ReminderMilestone, items: StoreItem[]): string {
  const lines = items.map((item) => {
    const qty = item.qty > 1 ? ` ×${item.qty}` : "";
    const where = item.eventName ? ` (${item.eventName})` : "";
    return `• ${item.title}${qty}${where}`;
  });
  return [
    `Olá, ${boxLabel}!`,
    "",
    `Você tem itens com a Kairyuu TCG e ${MILESTONE_TEXT[milestone]} para o prazo de 3 meses. Peça o envio para não passar do limite.`,
    "",
    ...lines,
    "",
    "Para pedir o envio, responda este e-mail ou fale com a gente no WhatsApp.",
    "",
    "Kairyuu TCG",
  ].join("\n");
}

async function sendReminderEmail(to: string, subject: string, text: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey) {
    throw new Error("RESEND_API_KEY não configurada.");
  }
  const from =
    process.env.RESEND_FROM_EMAIL?.trim() ||
    "Kairyuu Estoque <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend: ${body.slice(0, 180)}`);
  }
}

export async function runBoxReminders(): Promise<{
  checked: number;
  sent: number;
  skipped: number;
  errors: string[];
}> {
  const supabase = createAdminClient();
  const errors: string[] = [];
  const { data, error } = await supabase
    .from("physical_boxes")
    .select("id, label, phone, phone_digits, email, reminders_enabled")
    .eq("reminders_enabled", true);
  if (error) {
    return { checked: 0, sent: 0, skipped: 0, errors: [error.message] };
  }
  const boxes = ((data || []) as BoxRow[]).filter((b) =>
    (b.email || "").includes("@"),
  );
  if (!boxes.length) return { checked: 0, sent: 0, skipped: 0, errors };

  const ids = boxes.map((b) => b.id);
  const { data: linkedRows, error: linkErr } = await supabase
    .from("customers")
    .select("id, name, phone, physical_box_id")
    .in("physical_box_id", ids);
  if (linkErr) {
    return { checked: boxes.length, sent: 0, skipped: boxes.length, errors: [linkErr.message] };
  }
  const linkedByBox = new Map<string, { id: string; name: string; phone: string }[]>();
  for (const row of (linkedRows || []) as Array<{
    id: string;
    name: string;
    phone: string;
    physical_box_id: string | null;
  }>) {
    if (!row.physical_box_id) continue;
    const list = linkedByBox.get(row.physical_box_id) || [];
    list.push({ id: row.id, name: row.name, phone: row.phone });
    linkedByBox.set(row.physical_box_id, list);
  }

  const { data: logs } = await supabase
    .from("physical_box_reminders")
    .select("box_id, milestone, anchor_on")
    .in("box_id", ids);
  const seen = new Set(
    ((logs || []) as Array<{ box_id: string; milestone: string; anchor_on: string }>).map(
      (row) => `${row.box_id}|${row.milestone}|${row.anchor_on}`,
    ),
  );

  let sent = 0;
  let skipped = 0;
  for (const box of boxes) {
    let holdings;
    try {
      holdings = await loadBoxHoldings(
        supabase,
        box,
        linkedByBox.get(box.id) || [],
      );
    } catch (e) {
      errors.push(`${box.label}: ${e instanceof Error ? e.message : String(e)}`);
      skipped += 1;
      continue;
    }
    const groups = new Map<ReminderMilestone, { item: StoreItem; anchor: string }[]>();
    for (const item of holdings.items) {
      if (item.source !== "leilao") continue;
      const milestone = reminderMilestone(item.sinceIso);
      const anchor = anchorDay(item.sinceIso);
      if (!milestone || !anchor) continue;
      if (seen.has(`${box.id}|${milestone}|${anchor}`)) continue;
      const list = groups.get(milestone) || [];
      list.push({ item, anchor });
      groups.set(milestone, list);
    }
    if (!groups.size) {
      skipped += 1;
      continue;
    }
    for (const [milestone, due] of groups) {
      try {
        await sendReminderEmail(
          (box.email || "").trim(),
          milestoneSubject(milestone),
          emailText(
            box.label,
            milestone,
            due.map((d) => d.item),
          ),
        );
        const { error: insErr } = await supabase.from("physical_box_reminders").insert(
          due.map((d) => ({
            box_id: box.id,
            milestone,
            anchor_on: d.anchor,
          })),
        );
        if (insErr && !/duplicate|unique/i.test(insErr.message)) {
          errors.push(`${box.label}: e-mail saiu, mas o registro falhou (${insErr.message})`);
        }
        sent += 1;
      } catch (e) {
        errors.push(`${box.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { checked: boxes.length, sent, skipped, errors };
}
