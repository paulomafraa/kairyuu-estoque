/** Planilha-template de encomenda: custo JP, venda, liga. */

export type EncomendaCostRow = {
  product_title: string;
  cost_jp: number | null;
  price_sale: number | null;
  price_liga: number | null;
  link: string;
};

/** Normaliza texto solto (acentos / espaços). */
export function normalizeLoose(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Chave de casamento: nome da carta + numeração (ex. "altaria|087/076").
 * Ignora condição, idioma, preço e demais sufixos.
 * Numerações iguais em cartas diferentes não colidem porque o nome entra na chave.
 */
export function productMatchKey(title: string): string {
  const raw = normalizeLoose(title);
  if (!raw) return "";

  // Numeração tipo (087/076), (097JP/086), (101/100)
  const numMatch = raw.match(
    /\(\s*([0-9]{1,4}(?:jp)?\s*\/\s*[0-9]{1,4})\s*\)/i,
  );
  const number = numMatch
    ? numMatch[1].replace(/\s+/g, "").toLowerCase()
    : "";

  let namePart = raw;
  if (numMatch && numMatch.index != null) {
    namePart = raw.slice(0, numMatch.index);
  } else {
    // Sem parênteses: corta em " - " (comum no resultado do bot)
    const dash = namePart.indexOf(" - ");
    if (dash > 0) namePart = namePart.slice(0, dash);
  }

  namePart = namePart
    .replace(/[-–—|]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (number) return `${namePart}|${number}`;
  return namePart;
}

/** Alias legado — agora usa nome + numeração. */
export function normalizeProductKey(title: string): string {
  return productMatchKey(title);
}

function parseMoneyCell(raw: string): number | null {
  const t = (raw || "").trim();
  if (!t || t === "-" || /^R\$\s*-?\s*$/i.test(t)) return null;
  const m = t.match(/([\d.]+(?:,\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parse do CSV de preparação (Carta, ValorJP, Valor de venda, Valor da liga, Link). */
export function parseEncomendaTemplateCsv(text: string): EncomendaCostRow[] {
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Une linhas quebradas dentro de aspas
  const lines: string[] = [];
  let buf = "";
  let inQ = false;
  for (const ch of raw) {
    if (ch === '"') inQ = !inQ;
    if (ch === "\n" && !inQ) {
      if (buf.trim()) lines.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf.trim()) lines.push(buf);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]).map((h) =>
    h
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " "),
  );
  const iCarta = header.findIndex((h) => h.includes("carta"));
  const iJp = header.findIndex((h) => h.includes("jp") || h.includes("japao"));
  const iSale = header.findIndex(
    (h) => h.includes("venda") && !h.includes("liga"),
  );
  const iLiga = header.findIndex((h) => h.includes("liga"));
  const iLink = header.findIndex((h) => h.includes("link"));

  const out: EncomendaCostRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const title = (iCarta >= 0 ? cols[iCarta] : cols[0] || "").trim();
    if (!title) continue;
    out.push({
      product_title: title,
      cost_jp: parseMoneyCell(iJp >= 0 ? cols[iJp] || "" : ""),
      price_sale: parseMoneyCell(iSale >= 0 ? cols[iSale] || "" : ""),
      price_liga: parseMoneyCell(iLiga >= 0 ? cols[iLiga] || "" : ""),
      link: (iLink >= 0 ? cols[iLink] || "" : "").trim(),
    });
  }
  return out;
}

/** Custo JP + 10% de imposto. */
export function costWithTax(costJp: number | null): number | null {
  if (costJp == null || !Number.isFinite(costJp)) return null;
  return Math.round(costJp * 1.1 * 100) / 100;
}

export function estimatedProfit(
  sale: number | null,
  costJp: number | null,
): number | null {
  if (sale == null || costJp == null) return null;
  const taxed = costWithTax(costJp);
  if (taxed == null) return null;
  return Math.round((sale - taxed) * 100) / 100;
}
