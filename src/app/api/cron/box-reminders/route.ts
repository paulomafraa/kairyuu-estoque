import { NextResponse } from "next/server";
import { assertBotApiKey } from "@/lib/bot-auth";
import { runBoxReminders } from "@/lib/box-reminders";

function authorized(req: Request): boolean {
  const secret = (process.env.CRON_SECRET || "").trim();
  const auth = (req.headers.get("authorization") || "").trim();
  if (secret && auth === `Bearer ${secret}`) return true;
  try {
    assertBotApiKey(req);
    return true;
  } catch {
    return false;
  }
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }
  try {
    const result = await runBoxReminders();
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
