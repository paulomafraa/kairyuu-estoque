import { AI_TOOL_DECLARATIONS } from "@/lib/ai/tool-defs";
import { runAiTool } from "@/lib/ai/tools";
import type { ActionProposal, AiChatMessage } from "@/lib/ai/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export function aiProviderConfigured(): {
  ok: boolean;
  provider: "gemini" | "openai" | null;
  message?: string;
} {
  const gemini = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ""
  ).trim();
  if (gemini) {
    return { ok: true, provider: "gemini" };
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return { ok: true, provider: "openai" };
  }
  return {
    ok: false,
    provider: null,
    message:
      "Configure GEMINI_API_KEY ou OPENAI_API_KEY nas variáveis de ambiente (Vercel / .env.local).",
  };
}

function systemPrompt(ctx: {
  staffName: string;
  pagePath?: string;
  customerId?: string;
  eventId?: string;
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const month = today.slice(5, 7);
  return `Você é a assistente operacional do Kairyuu Estoque (TCG). Fale SEMPRE em português brasileiro (pt-BR), de forma direta e precisa.

Hoje: ${today}
Staff: ${ctx.staffName}
Página atual: ${ctx.pagePath || "—"}
${ctx.customerId ? `customer_id no contexto: ${ctx.customerId}` : ""}
${ctx.eventId ? `event_id no contexto: ${ctx.eventId}` : ""}

Regras:
1. Use as ferramentas para ler dados reais. Nunca invente IDs, preços, quantidades, contagens ou clientes.
2. Sempre responda com números concretos depois de consultar as tools. Nunca termine sem texto útil.
3. Perguntas do tipo "quantas pessoas devem / pendentes / até o dia X":
   - Use report_pending_payments.
   - "até dia 15 deste mês" → due_on_or_before=${year}-${month}-15 (inclui atrasados e quem vence até essa data).
   - "atrasados" → only_overdue=true.
4. Se houver ambiguidade (vários clientes/eventos), liste opções e pergunte — não chute.
5. Ações que alteram dados (pago, cobrado, cancelar, enviar, notas, encomenda) DEVEM usar as tools propose_* — geram cartão de confirmação. Nunca diga que já executou sem o staff confirmar.
6. Preferir telefone/WhatsApp e IDs a nomes genéricos.
7. Respostas curtas, com números e nomes. Quando montar cobrança, devolva o texto completo pronto para copiar.
8. Não mexa em estoque físico de cartas (± qty) nem imports em massa — diga que isso ainda é manual na UI.
9. Se o contexto já tiver customer_id/event_id, use-os quando fizer sentido.`;
}

function fallbackFromToolResults(
  results: Array<{ name: string; result: unknown }>,
): string {
  for (const r of [...results].reverse()) {
    const payload = r.result as {
      ok?: boolean;
      data?: {
        answer_hint?: string;
        people_count?: number;
        items_count?: number;
        total_formatted?: string;
        people?: Array<{
          name?: string;
          phone?: string;
          items?: number;
          total_formatted?: string;
          earliest_due?: string | null;
        }>;
        message?: string;
        text?: string;
        hint?: string;
        count?: number;
      };
      error?: string;
    };
    if (!payload?.ok || !payload.data) continue;
    const d = payload.data;
    if (d.answer_hint) {
      const lines = [d.answer_hint];
      if (d.people?.length) {
        lines.push("");
        for (const p of d.people.slice(0, 15)) {
          lines.push(
            `• ${p.name}${p.phone ? ` (${p.phone})` : ""} — ${p.items} item(ns)${
              p.total_formatted ? ` · ${p.total_formatted}` : ""
            }${p.earliest_due ? ` · prazo ${p.earliest_due}` : ""}`,
          );
        }
        if ((d.people_count || 0) > 15) {
          lines.push(`… e mais ${(d.people_count || 0) - 15} pessoa(s)`);
        }
      }
      return lines.join("\n");
    }
    if (d.text) return d.text;
    if (d.hint) return d.hint;
    if (d.message) return d.message;
    if (typeof d.count === "number") return `Encontrei ${d.count} registro(s).`;
  }
  return "";
}

type ChatOutcome = {
  reply: string;
  proposals: ActionProposal[];
  provider: "gemini" | "openai";
  model: string;
};

export async function runStaffAiChat(opts: {
  supabase: SupabaseClient;
  messages: AiChatMessage[];
  staffName: string;
  pagePath?: string;
  customerId?: string;
  eventId?: string;
}): Promise<ChatOutcome> {
  const cfg = aiProviderConfigured();
  if (!cfg.ok || !cfg.provider) {
    throw new Error(cfg.message || "IA não configurada");
  }

  const proposals: ActionProposal[] = [];
  const sys = systemPrompt({
    staffName: opts.staffName,
    pagePath: opts.pagePath,
    customerId: opts.customerId,
    eventId: opts.eventId,
  });

  if (cfg.provider === "gemini") {
    return runGemini({
      supabase: opts.supabase,
      messages: opts.messages,
      system: sys,
      proposals,
    });
  }
  return runOpenAI({
    supabase: opts.supabase,
    messages: opts.messages,
    system: sys,
    proposals,
  });
}

async function executeToolCalls(
  supabase: SupabaseClient,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  proposals: ActionProposal[],
): Promise<Array<{ name: string; result: unknown }>> {
  const out: Array<{ name: string; result: unknown }> = [];
  for (const call of calls) {
    const result = await runAiTool(supabase, call.name, call.args || {});
    if (result.proposals?.length) proposals.push(...result.proposals);
    out.push({
      name: call.name,
      result: result.ok
        ? { ok: true, data: result.data, proposals: result.proposals }
        : { ok: false, error: result.error },
    });
  }
  return out;
}

function geminiApiKey(): string {
  const raw =
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  // echo | vercel env add no Windows às vezes grava \r\n / aspas
  return raw.trim().replace(/^["']|["']$/g, "");
}

async function runGemini(opts: {
  supabase: SupabaseClient;
  messages: AiChatMessage[];
  system: string;
  proposals: ActionProposal[];
}): Promise<ChatOutcome> {
  const key = geminiApiKey();
  if (!key) {
    throw new Error("GEMINI_API_KEY vazia no servidor.");
  }
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  // Auth keys novas (AQ.…): usar header, não ?key= na URL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  type GPart =
    | { text: string }
    | { functionCall: { name: string; args?: Record<string, unknown> } }
    | {
        functionResponse: {
          name: string;
          response: Record<string, unknown>;
        };
      };

  type GContent = { role: "user" | "model"; parts: GPart[] };

  const contents: GContent[] = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const tools = [
    {
      functionDeclarations: AI_TOOL_DECLARATIONS.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];

  let reply = "";
  const allToolResults: Array<{ name: string; result: unknown }> = [];
  for (let round = 0; round < 8; round++) {
    const forceText = round >= 6;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents,
        tools: forceText ? undefined : tools,
        toolConfig: forceText
          ? { functionCallingConfig: { mode: "NONE" } }
          : { functionCallingConfig: { mode: "AUTO" } },
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: GPart[]; role?: string };
        finishReason?: string;
      }>;
    };
    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const fnCalls = parts.filter(
      (p): p is {
        functionCall: { name: string; args?: Record<string, unknown> };
      } => "functionCall" in p && Boolean(p.functionCall?.name),
    );
    const textParts = parts
      .filter(
        (p): p is { text: string } =>
          "text" in p && typeof p.text === "string" && Boolean(p.text.trim()),
      )
      .map((p) => p.text);

    if (fnCalls.length && !forceText) {
      contents.push({ role: "model", parts });
      const results = await executeToolCalls(
        opts.supabase,
        fnCalls.map((f) => ({
          name: f.functionCall.name,
          args: (f.functionCall.args || {}) as Record<string, unknown>,
        })),
        opts.proposals,
      );
      allToolResults.push(...results);
      contents.push({
        role: "user",
        parts: results.map((r) => ({
          functionResponse: {
            name: r.name,
            response: r.result as Record<string, unknown>,
          },
        })),
      });
      // Empurra o modelo a concluir em texto na próxima rodada
      if (round >= 4) {
        contents.push({
          role: "user",
          parts: [
            {
              text: "Com base nos resultados das ferramentas acima, responda agora em português brasileiro, com números concretos. Não chame mais ferramentas.",
            },
          ],
        });
      }
      continue;
    }

    reply = textParts.join("\n").trim();
    if (reply) break;

    // Sem texto: tenta forçar resposta na próxima
    if (!forceText && allToolResults.length) {
      contents.push({
        role: "user",
        parts: [
          {
            text: "Responda agora em texto claro (pt-BR) usando os dados já obtidos. Não chame ferramentas.",
          },
        ],
      });
      continue;
    }
    break;
  }

  if (!reply) {
    reply = fallbackFromToolResults(allToolResults);
  }
  if (!reply && opts.proposals.length) {
    reply =
      "Preparei a(s) ação(ões) abaixo. Confira o cartão e confirme para aplicar.";
  }
  if (!reply) {
    reply =
      "Consultei o sistema, mas não consegui formatar a resposta. Reformule a pergunta (ex.: incluir a data no formato dia/mês).";
  }

  return {
    reply,
    proposals: opts.proposals,
    provider: "gemini",
    model,
  };
}

async function runOpenAI(opts: {
  supabase: SupabaseClient;
  messages: AiChatMessage[];
  system: string;
  proposals: ActionProposal[];
}): Promise<ChatOutcome> {
  const key = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  type OMsg =
    | { role: "system" | "user" | "assistant"; content: string }
    | {
        role: "assistant";
        content: string | null;
        tool_calls: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
      }
    | { role: "tool"; tool_call_id: string; content: string };

  const messages: OMsg[] = [
    { role: "system", content: opts.system },
    ...opts.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const tools = AI_TOOL_DECLARATIONS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  let reply = "";
  const allToolResults: Array<{ name: string; result: unknown }> = [];
  for (let round = 0; round < 8; round++) {
    const forceText = round >= 6;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages,
        tools: forceText ? undefined : tools,
        tool_choice: forceText ? undefined : "auto",
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) break;

    if (msg.tool_calls?.length && !forceText) {
      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });
      const parsed = msg.tool_calls.map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<
            string,
            unknown
          >;
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.function.name, args };
      });
      const results = await executeToolCalls(
        opts.supabase,
        parsed.map((p) => ({ name: p.name, args: p.args })),
        opts.proposals,
      );
      allToolResults.push(...results);
      for (let i = 0; i < parsed.length; i++) {
        messages.push({
          role: "tool",
          tool_call_id: parsed[i].id,
          content: JSON.stringify(results[i].result),
        });
      }
      if (round >= 4) {
        messages.push({
          role: "user",
          content:
            "Com base nos resultados das ferramentas, responda agora em português brasileiro com números concretos. Não chame mais ferramentas.",
        });
      }
      continue;
    }

    reply = (msg.content || "").trim();
    if (reply) break;
    if (!forceText && allToolResults.length) {
      messages.push({
        role: "user",
        content:
          "Responda agora em texto claro (pt-BR) usando os dados já obtidos.",
      });
      continue;
    }
    break;
  }

  if (!reply) reply = fallbackFromToolResults(allToolResults);
  if (!reply && opts.proposals.length) {
    reply =
      "Preparei a(s) ação(ões) abaixo. Confira o cartão e confirme para aplicar.";
  }
  if (!reply) {
    reply =
      "Consultei o sistema, mas não consegui formatar a resposta. Reformule a pergunta.";
  }

  return {
    reply,
    proposals: opts.proposals,
    provider: "openai",
    model,
  };
}
