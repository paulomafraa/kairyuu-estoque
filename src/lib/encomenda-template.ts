/** Planilha-template de encomenda: custo JP, venda, liga. */

export type EncomendaCostRow = {
  product_title: string;
  cost_jp: number | null;
  price_sale: number | null;
  price_liga: number | null;
  link: string;
  sort_index?: number;
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

function sheetDdMm(name: string): string | null {
  const m =
    name.match(/(\d{2})(\d{2})\s*$/) || name.match(/(\d{2})(\d{2})(?:\s|$)/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${m[1]}${m[2]}`;
}

/** YYYY-MM-DD → DDMM da aba (ex.: 2026-08-26 → 2608). */
export function eventDateToSheetDdmm(ymd: string | null | undefined): string | null {
  const day = (ymd || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day.slice(8, 10)}${day.slice(5, 7)}`;
}

function isRoundSheetName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (
    /^(TUDO JUNTO|30 ANOS|Old orders|Cópia de Old orders)$/i.test(n) ||
    /^c[oó]pia de/i.test(n)
  ) {
    return false;
  }
  if (/^Encomendas/i.test(n)) return true;
  return /[-–]\s*\d{4}\s*$/.test(n) && Boolean(sheetDdMm(n));
}

export function looksLikeEncomendaCostWorkbook(sheetNames: string[]): boolean {
  return sheetNames.some(isRoundSheetName);
}

export type EncomendaXlsxParse = {
  rows: EncomendaCostRow[];
  sheetUsed: string;
  sheets: string[];
};

function parseSheetMatrix(matrix: unknown[][]): EncomendaCostRow[] {
  const out: EncomendaCostRow[] = [];
  let started = false;
  let sort = 0;
  for (let r = 0; r < matrix.length; r++) {
    const line = (matrix[r] || []).map((c) => String(c ?? "").trim());
    const nome = (line[0] || "").replace(/\s+/g, " ").trim();
    if (!nome) continue;
    if (/^carta$/i.test(nome)) {
      if (started) break;
      started = true;
      continue;
    }
    started = true;
    const cost_jp = parseMoneyCell(line[1] || "");
    const price_sale = parseMoneyCell(line[2] || "");
    const price_liga = parseMoneyCell(line[3] || "");
    const link = (line[4] || "").trim();
    if (price_sale == null && cost_jp == null && !link) continue;
    sort += 1;
    out.push({
      product_title: nome,
      cost_jp,
      price_sale,
      price_liga,
      link,
      sort_index: sort,
    });
  }
  return out;
}

function scoreRoundSheet(
  name: string,
  rowCount: number,
  hintDdmm: string | null,
): number {
  const ddmm = sheetDdMm(name);
  let score = rowCount;
  if (hintDdmm && ddmm === hintDdmm) score += 10000;
  if (ddmm) score += Number(ddmm);
  return score;
}

/** Lê Encomendas.xlsx (abas `Encomendas - 2608`) e escolhe a aba da data do evento. */
export async function parseEncomendaXlsx(
  file: File,
  eventYmd?: string | null,
): Promise<EncomendaXlsxParse> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const rounds = wb.SheetNames.filter(isRoundSheetName);
  const sheets = rounds.length ? rounds : wb.SheetNames;
  if (!sheets.length) {
    return { rows: [], sheetUsed: "", sheets: [] };
  }

  const hint = eventDateToSheetDdmm(eventYmd);
  let best = sheets[0];
  let bestScore = -1;
  for (const name of sheets) {
    const sheet = wb.Sheets[name];
    const matrix = (XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: false,
    }) || []) as unknown[][];
    const score = scoreRoundSheet(name, matrix.length, hint);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }

  const matrix = (XLSX.utils.sheet_to_json(wb.Sheets[best], {
    header: 1,
    defval: "",
    raw: false,
  }) || []) as unknown[][];
  return {
    rows: parseSheetMatrix(matrix),
    sheetUsed: best,
    sheets,
  };
}
