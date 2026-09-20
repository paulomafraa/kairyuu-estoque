import { timingSafeEqual } from "crypto";

/** Valida X-Bot-Api-Key contra ESTOQUE_BOT_API_KEY. */
export function assertBotApiKey(req: Request): void {
  const expected = (process.env.ESTOQUE_BOT_API_KEY || "").trim();
  if (!expected) {
    throw new BotAuthError(
      "ESTOQUE_BOT_API_KEY não configurada no servidor.",
      503,
    );
  }
  const got = (req.headers.get("x-bot-api-key") || "").trim();
  if (!got || !safeEqual(got, expected)) {
    throw new BotAuthError("Não autorizado.", 401);
  }
}

export class BotAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
