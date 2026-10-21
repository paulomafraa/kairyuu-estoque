/** Lê os itens de uma mensagem de cobrança para virar linhas de evento. */

export type ParsedBillingProduct = {
  title: string;
  qty: number;
  /** Preço unitário. O valor na mensagem é o total da linha. */
  unitPrice: number | null;
};

const SKIP_LINE =
  /^(ol[aá],|a kairyuu|resumo |——|🗓️|o pagamento|sobre a entrega|nos avise|lembrando|• |\*|total\b|subtotal\b)/i;

/** "Carta ×2 — R$ 20,00" ou "Booster box — R$ 360,00". */
export function parseBillingItemLines(text: string): ParsedBillingProduct[] {
  const out: ParsedBillingProduct[] = [];
  for (const raw of (text || "").split(/\n/)) {
    const line = raw.trim();
    if (!line || SKIP_LINE.test(line)) continue;
    const m = line.match(/^(.+?)\s+[—–-]\s+R\$\s*(\?|[\d.]+,\d{2})\s*$/i);
    if (!m) continue;
    let title = m[1].trim();
    let qty = 1;
    const times = title.match(/\s×\s*(\d+)$/);
    if (times && times.index != null) {
      qty = Math.max(1, Number(times[1]) || 1);
      title = title.slice(0, times.index).trim();
    }
    if (!title) continue;
    const shown = m[2] === "?" ? null : Number(m[2].replace(/\./g, "").replace(",", "."));
    const unitPrice =
      shown == null || !Number.isFinite(shown)
        ? null
        : Math.round((shown / qty) * 100) / 100;
    out.push({ title, qty, unitPrice });
  }
  return out;
}
