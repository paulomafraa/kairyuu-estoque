/** Lógica server-side das cobranças (API do bot). Usa service role. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPhoneLookup, phoneInLookup } from "@/lib/customers";
import { normalizePhoneDigits } from "@/lib/clients-csv";
import {
  BILLING_MAX_FAIL_STREAK,
  BILLING_REPLY_WINDOW_DAYS,
  BILLING_STALE_SENDING_MS,
  looksLikePaymentReply,
  randomIntervalMs,
  type BillingItem,
  type BillingRun,
} from "@/lib/billing";

export type RunSummary = {
  id: string;
  name: string;
  status: BillingRun["status"];
  isTest: boolean;
  pauseReason: string;
  total: number;
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
};

export type NextResponse = {
  run: RunSummary | null;
  item: {
    id: string;
    phone: string;
    name: string;
    text: string;
    isTest: boolean;
  } | null;
  waitMs: number | null;
  /** Telefones cobrados nos últimos dias — o bot repassa as respostas deles. */
  watch: string[];
};

async function summarize(
  admin: SupabaseClient,
  run: BillingRun,
): Promise<RunSummary> {
  const { data } = await admin
    .from("billing_items")
    .select("status")
    .eq("run_id", run.id);
  const rows = (data || []) as Array<{ status: string }>;
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    isTest: run.is_test,
    pauseReason: run.pause_reason,
    total: rows.length,
    sent: count("sent"),
    pending: count("pending") + count("sending"),
    failed: count("failed"),
    skipped: count("skipped"),
  };
}

export async function fetchWatchPhones(admin: SupabaseClient): Promise<string[]> {
  const since = new Date(
    Date.now() - BILLING_REPLY_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  const { data, error } = await admin
    .from("billing_items")
    .select("phone_digits")
    .eq("status", "sent")
    .gte("sent_at", since)
    .limit(5000);
  if (error) throw error;
  return [
    ...new Set(
      ((data || []) as Array<{ phone_digits: string }>)
        .map((r) => normalizePhoneDigits(r.phone_digits))
        .filter(Boolean),
    ),
  ];
}

async function activeRun(admin: SupabaseClient): Promise<BillingRun | null> {
  const { data, error } = await admin
    .from("billing_runs")
    .select("*")
    .in("status", ["running", "paused"])
    .order("status", { ascending: false })
    .order("started_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  return ((data || [])[0] as BillingRun | undefined) || null;
}

async function finishIfEmpty(
  admin: SupabaseClient,
  run: BillingRun,
): Promise<boolean> {
  const { count } = await admin
    .from("billing_items")
    .select("id", { count: "exact", head: true })
    .eq("run_id", run.id)
    .in("status", ["pending", "sending"]);
  if ((count || 0) > 0) return false;
  const now = new Date().toISOString();
  await admin
    .from("billing_runs")
    .update({ status: "done", finished_at: now, updated_at: now })
    .eq("id", run.id)
    .eq("status", "running");
  run.status = "done";
  return true;
}

/**
 * Próxima cobrança da lista rodando.
 * `canSend=false` (remetente desconectado) → só informa, não reserva nada.
 */
export async function claimNextBilling(
  admin: SupabaseClient,
  opts: { canSend: boolean },
): Promise<NextResponse> {
  const watch = await fetchWatchPhones(admin);
  const run = await activeRun(admin);
  if (!run) return { run: null, item: null, waitMs: null, watch };

  // Bot caiu no meio de um envio: não reenvia (pode ter saído) — marca pra conferir
  const staleBefore = new Date(Date.now() - BILLING_STALE_SENDING_MS).toISOString();
  await admin
    .from("billing_items")
    .update({
      status: "failed",
      error: "Incerto: o bot caiu durante o envio — confira no WhatsApp antes de reenviar",
      updated_at: new Date().toISOString(),
    })
    .eq("run_id", run.id)
    .eq("status", "sending")
    .lt("claimed_at", staleBefore);

  if (run.status !== "running" || !opts.canSend) {
    return { run: await summarize(admin, run), item: null, waitMs: null, watch };
  }

  const now = Date.now();
  const nextAt = run.next_send_at ? new Date(run.next_send_at).getTime() : 0;
  if (nextAt > now) {
    return {
      run: await summarize(admin, run),
      item: null,
      waitMs: nextAt - now,
      watch,
    };
  }

  const { data: sending } = await admin
    .from("billing_items")
    .select("id")
    .eq("run_id", run.id)
    .eq("status", "sending")
    .limit(1);
  if (sending?.length) {
    return { run: await summarize(admin, run), item: null, waitMs: 15_000, watch };
  }

  const { data: nextRows, error } = await admin
    .from("billing_items")
    .select("*")
    .eq("run_id", run.id)
    .eq("status", "pending")
    .order("position", { ascending: true })
    .limit(1);
  if (error) throw error;
  const next = (nextRows || [])[0] as BillingItem | undefined;
  if (!next) {
    await finishIfEmpty(admin, run);
    return { run: await summarize(admin, run), item: null, waitMs: null, watch };
  }

  const claimedAt = new Date().toISOString();
  const { data: claimed } = await admin
    .from("billing_items")
    .update({ status: "sending", claimed_at: claimedAt, updated_at: claimedAt })
    .eq("id", next.id)
    .eq("status", "pending")
    .select("*");
  const item = (claimed || [])[0] as BillingItem | undefined;
  if (!item) {
    return { run: await summarize(admin, run), item: null, waitMs: 5_000, watch };
  }

  return {
    run: await summarize(admin, run),
    item: {
      id: item.id,
      phone: item.phone_digits,
      name: item.customer_name,
      text: item.text,
      isTest: run.is_test,
    },
    waitMs: null,
    watch,
  };
}

export type ResultInput = {
  itemId: string;
  ok: boolean;
  error?: string;
  /** Falha que não é culpa do envio (ex.: número sem WhatsApp) — não conta pra pausa. */
  soft?: boolean;
  waMessageId?: string;
};

export async function reportBillingResult(
  admin: SupabaseClient,
  input: ResultInput,
): Promise<{ run: RunSummary | null }> {
  const { data: itemRow, error } = await admin
    .from("billing_items")
    .select("*")
    .eq("id", input.itemId)
    .maybeSingle();
  if (error) throw error;
  const item = itemRow as BillingItem | null;
  if (!item) throw new Error("Cobrança não encontrada.");

  const { data: runRow } = await admin
    .from("billing_runs")
    .select("*")
    .eq("id", item.run_id)
    .maybeSingle();
  const run = runRow as BillingRun | null;
  if (!run) throw new Error("Lista não encontrada.");

  const nowIso = new Date().toISOString();
  if (input.ok) {
    await admin
      .from("billing_items")
      .update({
        status: "sent",
        sent_at: nowIso,
        error: "",
        wa_message_id: input.waMessageId || "",
        updated_at: nowIso,
      })
      .eq("id", item.id);

    if (!run.is_test && item.sale_line_ids?.length) {
      await admin
        .from("event_sale_lines")
        .update({ charged: true, charged_at: nowIso })
        .in("id", item.sale_line_ids)
        .eq("paid", false);
    }

    const nextAt = new Date(
      Date.now() + randomIntervalMs(run.min_interval_s, run.max_interval_s),
    ).toISOString();
    await admin
      .from("billing_runs")
      .update({
        fail_streak: 0,
        last_sent_at: nowIso,
        next_send_at: nextAt,
        updated_at: nowIso,
      })
      .eq("id", run.id);
    run.fail_streak = 0;
  } else {
    await admin
      .from("billing_items")
      .update({
        status: "failed",
        error: (input.error || "Falha no envio").slice(0, 500),
        updated_at: nowIso,
      })
      .eq("id", item.id);

    const streak = input.soft ? run.fail_streak : run.fail_streak + 1;
    const pause = streak >= BILLING_MAX_FAIL_STREAK;
    await admin
      .from("billing_runs")
      .update({
        fail_streak: streak,
        next_send_at: new Date(Date.now() + 20_000).toISOString(),
        ...(pause
          ? {
              status: "paused",
              pause_reason: `${streak} falhas seguidas — confira o remetente e continue`,
            }
          : {}),
        updated_at: nowIso,
      })
      .eq("id", run.id)
      .eq("status", "running");
    run.fail_streak = streak;
    if (pause) {
      run.status = "paused";
      run.pause_reason = `${streak} falhas seguidas — confira o remetente e continue`;
    }
  }

  if (run.status === "running") await finishIfEmpty(admin, run);
  return { run: await summarize(admin, run) };
}

export type ReplyInput = {
  phone: string;
  waMessageId: string;
  kind: string;
  text?: string;
  receivedAt?: string;
  mediaBase64?: string;
  mimetype?: string;
};

const REPLY_KINDS = new Set(["text", "image", "document", "audio", "video", "sticker", "other"]);
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

function extFromMime(mime: string): string {
  if (/jpeg|jpg/i.test(mime)) return "jpg";
  if (/png/i.test(mime)) return "png";
  if (/webp/i.test(mime)) return "webp";
  if (/pdf/i.test(mime)) return "pdf";
  if (/ogg/i.test(mime)) return "ogg";
  if (/mp4/i.test(mime)) return "mp4";
  return "bin";
}

/** Guarda a resposta na cobrança mais recente enviada pra esse telefone. */
export async function recordBillingReply(
  admin: SupabaseClient,
  input: ReplyInput,
): Promise<{ matched: boolean; itemId?: string; paymentHint?: boolean }> {
  const phone = normalizePhoneDigits(input.phone || "");
  if (!phone || !input.waMessageId) return { matched: false };

  const since = new Date(
    Date.now() - BILLING_REPLY_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  const { data, error } = await admin
    .from("billing_items")
    .select("id, run_id, phone_digits, sent_at, payment_status, reply_count")
    .eq("status", "sent")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(5000);
  if (error) throw error;
  const lookup = buildPhoneLookup([phone]);
  const item = ((data || []) as Array<{
    id: string;
    run_id: string;
    phone_digits: string;
    sent_at: string;
    payment_status: string;
    reply_count: number;
  }>).find((r) => phoneInLookup(r.phone_digits, lookup));
  if (!item) return { matched: false };

  const receivedAt = input.receivedAt || new Date().toISOString();
  if (new Date(receivedAt).getTime() < new Date(item.sent_at).getTime()) {
    return { matched: false };
  }

  const { data: dup } = await admin
    .from("billing_replies")
    .select("id")
    .eq("wa_message_id", input.waMessageId)
    .limit(1);
  if (dup?.length) return { matched: true, itemId: item.id };

  const kind = REPLY_KINDS.has(input.kind) ? input.kind : "other";
  let mediaPath = "";
  const mimetype = (input.mimetype || "").slice(0, 120);
  if (input.mediaBase64) {
    const buf = Buffer.from(input.mediaBase64, "base64");
    if (buf.length > 0 && buf.length <= MAX_MEDIA_BYTES) {
      const path = `${item.run_id}/${item.id}/${input.waMessageId.replace(/[^\w-]/g, "")}.${extFromMime(mimetype)}`;
      const up = await admin.storage
        .from("billing-replies")
        .upload(path, buf, { contentType: mimetype || undefined, upsert: true });
      if (!up.error) mediaPath = path;
    }
  }

  const text = (input.text || "").slice(0, 4000);
  const { error: insErr } = await admin.from("billing_replies").insert({
    item_id: item.id,
    run_id: item.run_id,
    phone_digits: phone,
    received_at: receivedAt,
    kind,
    text,
    media_path: mediaPath,
    mimetype,
    wa_message_id: input.waMessageId,
  });
  if (insErr && !/duplicate/i.test(insErr.message)) throw insErr;

  const hint = looksLikePaymentReply(kind, text);
  await admin
    .from("billing_items")
    .update({
      reply_count: (item.reply_count || 0) + 1,
      last_reply_at: receivedAt,
      ...(hint && item.payment_status === "none" ? { payment_status: "hint" } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", item.id);

  return { matched: true, itemId: item.id, paymentHint: hint };
}

/** Controle pelo bot (`!cobrancas pausar|continuar|status`). */
export async function controlBilling(
  admin: SupabaseClient,
  action: "status" | "pause" | "resume",
): Promise<{ run: RunSummary | null; changed: boolean; message?: string }> {
  const run = await activeRun(admin);
  if (!run) return { run: null, changed: false, message: "Nenhuma lista rodando ou pausada." };
  const nowIso = new Date().toISOString();
  if (action === "pause" && run.status === "running") {
    await admin
      .from("billing_runs")
      .update({ status: "paused", pause_reason: "Pausada pelo bot (!cobrancas pausar)", updated_at: nowIso })
      .eq("id", run.id);
    run.status = "paused";
    run.pause_reason = "Pausada pelo bot (!cobrancas pausar)";
    return { run: await summarize(admin, run), changed: true };
  }
  if (action === "resume" && run.status === "paused") {
    await admin
      .from("billing_runs")
      .update({
        status: "running",
        pause_reason: "",
        fail_streak: 0,
        next_send_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", run.id);
    run.status = "running";
    run.pause_reason = "";
    return { run: await summarize(admin, run), changed: true };
  }
  return { run: await summarize(admin, run), changed: false };
}
