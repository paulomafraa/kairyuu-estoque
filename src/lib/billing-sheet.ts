/**
 * Lista de cobrança a partir de uma aba de pré-venda.
 * Colunas: Item, Valor (total da linha), Cliente, Contato, Pagamento (opcional).
 * Telefone em branco na linha seguinte do mesmo cliente repete o de cima.
 */

import { looksLikePhoneName, type BillingDraftItem, type BillingDraftProblem } from "./billing";
import { buildPrevendaBillingMessage, greetingName } from "./cobranca-msg";
import { parseMoneyCell } from "./encomenda-template";

export type SheetBillingLine = { title: string; total: number | null };

export type SheetBillingGroup = {
  name: string;
  /** Dígitos crus da planilha, antes de colocar o 55. */
  phoneRaw: string;
  lines: SheetBillingLine[];
  /** Outros nomes que caíram no mesmo telefone. */
  extraNames: string[];
};

export type BillingSheetParse = {
  /** Abas que têm o cabeçalho de pré-venda. */
  sheets: string[];
  sheetUsed: string;
  /** AAAA-MM-DD lido do final do nome da aba (1410 → 14/10), ou null. */
  eventDate: string | null;
  groups: SheetBillingGroup[];
  paidSkipped: number;
  lineCount: number;
};

function loose(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(cell: unknown): string {
  if (cell == null) return "";
  if (typeof cell === "number" && Number.isFinite(cell)) {
    return String(Math.round(cell));
  }
  return String(cell).trim();
}

function moneyCell(cell: unknown): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (cell == null || cell === "") return null;
  return parseMoneyCell(String(cell));
}

/** 10/11 dígitos ganham 55. 12/13 começando com 55 ficam. O resto é inválido. */
export function sheetPhoneDigits(raw: string): { phone: string | null; problem: string | null } {
  const text = raw.trim();
  if (!text) return { phone: null, problem: "sem telefone" };
  if (/e[+-]/i.test(text)) {
    return {
      phone: null,
      problem: "telefone virou notação científica no Excel — formate a célula como texto e reescreva o número",
    };
  }
  const d = text.replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return { phone: d, problem: null };
  // 10 dígitos = DDD + 8, celular antigo sem o 9. WhatsApp usa o formato com 9.
  if (d.length === 10) return { phone: `55${d.slice(0, 2)}9${d.slice(2)}`, problem: null };
  if (d.length === 11) return { phone: `55${d}`, problem: null };
  return { phone: null, problem: `telefone fora do padrão (${d || text})` };
}

function dateFromSheetName(name: string, today = new Date()): string | null {
  const m = name.trim().match(/(\d{2})(\d{2})\s*$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  let year = today.getFullYear();
  const candidate = new Date(year, mm - 1, dd);
  if (candidate.getTime() - today.getTime() > 45 * 86_400_000) year -= 1;
  const iso = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const check = new Date(`${iso}T12:00:00`);
  if (check.getMonth() !== mm - 1 || check.getDate() !== dd) return null;
  return iso;
}

type Cols = { item: number; valor: number; cliente: number; contato: number; pagamento: number };

function findHeader(matrix: unknown[][]): { row: number; cols: Cols } | null {
  const limit = Math.min(matrix.length, 15);
  for (let r = 0; r < limit; r++) {
    const cells = (matrix[r] || []).map((c) => loose(cellText(c)));
    const at = (pred: (h: string) => boolean) => cells.findIndex(pred);
    const item = at((h) => h === "item" || h === "produto" || h === "descricao");
    const cliente = at((h) => h === "cliente" || h === "nome");
    const valor = at((h) => h === "valor" || h === "total" || h.startsWith("valor"));
    const contato = at(
      (h) => h === "contato" || h === "telefone" || h === "celular" || h === "whatsapp" || h === "phone",
    );
    if (item < 0 || cliente < 0 || valor < 0 || contato < 0) continue;
    const pagamento = at((h) => h === "pagamento" || h === "pago" || h === "status");
    return { row: r, cols: { item, valor, cliente, contato, pagamento } };
  }
  return null;
}

function isPaid(cell: unknown): boolean {
  const t = cellText(cell);
  if (!t || t === "-" || t === "—" || loose(t) === "nao" || loose(t) === "não") return false;
  return true;
}

export function parseBillingMatrix(matrix: unknown[][], sheetName: string): Omit<BillingSheetParse, "sheets"> {
  const header = findHeader(matrix);
  const groups = new Map<string, SheetBillingGroup>();
  const order: string[] = [];
  let paidSkipped = 0;
  let lineCount = 0;
  if (!header) {
    return {
      sheetUsed: sheetName,
      eventDate: dateFromSheetName(sheetName),
      groups: [],
      paidSkipped: 0,
      lineCount: 0,
    };
  }

  let lastName = "";
  let lastPhone = "";
  const { cols } = header;

  for (let r = header.row + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    let name = cellText(row[cols.cliente]).replace(/\s+/g, " ").trim();
    let phoneRaw = cellText(row[cols.contato]);
    const title = cellText(row[cols.item]).replace(/\s+/g, " ").trim();
    const samePerson = !name || loose(name) === loose(lastName);
    if (!phoneRaw && samePerson) phoneRaw = lastPhone;
    if (!name) name = lastName;
    if (!title && !name && !phoneRaw) continue;
    if (name) lastName = name;
    if (cellText(row[cols.contato])) lastPhone = cellText(row[cols.contato]);
    if (cols.pagamento >= 0 && isPaid(row[cols.pagamento])) {
      if (title) paidSkipped += 1;
      continue;
    }
    if (!title) continue;
    lineCount += 1;
    const key = phoneRaw.replace(/\D/g, "") ? `p:${phoneRaw.replace(/\D/g, "")}` : `n:${loose(name) || r}`;
    let g = groups.get(key);
    if (!g) {
      g = { name: name || phoneRaw || "(sem nome)", phoneRaw, lines: [], extraNames: [] };
      groups.set(key, g);
      order.push(key);
    } else if (name && loose(name) !== loose(g.name) && !g.extraNames.some((n) => loose(n) === loose(name))) {
      g.extraNames.push(name);
    }
    g.lines.push({ title, total: moneyCell(row[cols.valor]) });
  }

  return {
    sheetUsed: sheetName,
    eventDate: dateFromSheetName(sheetName),
    groups: order.map((k) => groups.get(k)!),
    paidSkipped,
    lineCount,
  };
}

function matrixOf(XLSX: typeof import("xlsx"), sheet: import("xlsx").WorkSheet): unknown[][] {
  return (XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: true,
  }) || []) as unknown[][];
}

export async function parseBillingXlsxBuffer(
  data: ArrayBuffer | Uint8Array,
  sheetName?: string,
): Promise<BillingSheetParse> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(data, { type: "array" });
  const matching: string[] = [];
  for (const name of wb.SheetNames) {
    const parsed = parseBillingMatrix(matrixOf(XLSX, wb.Sheets[name]), name);
    if (parsed.lineCount > 0) matching.push(name);
  }
  const sheetUsed =
    (sheetName && matching.includes(sheetName) && sheetName) ||
    (sheetName && wb.SheetNames.includes(sheetName) && sheetName) ||
    matching[matching.length - 1] ||
    wb.SheetNames[wb.SheetNames.length - 1] ||
    "";
  const parsed = sheetUsed
    ? parseBillingMatrix(matrixOf(XLSX, wb.Sheets[sheetUsed]), sheetUsed)
    : { sheetUsed: "", eventDate: null, groups: [], paidSkipped: 0, lineCount: 0 };
  return { ...parsed, sheets: matching };
}

export async function parseBillingXlsxFile(file: File, sheetName?: string): Promise<BillingSheetParse> {
  return parseBillingXlsxBuffer(await file.arrayBuffer(), sheetName);
}

export function buildSheetBillingDraft(
  groups: SheetBillingGroup[],
  opts: { roundName: string; eventDate: string | null; paymentDue: string | null },
): { items: BillingDraftItem[]; problems: BillingDraftProblem[]; mergedNames: number } {
  const items: BillingDraftItem[] = [];
  const problems: BillingDraftProblem[] = [];
  let mergedNames = 0;

  for (const g of groups) {
    const { phone, problem } = sheetPhoneDigits(g.phoneRaw);
    if (!phone) {
      problems.push({
        name: g.name,
        phone: g.phoneRaw,
        reason: `${problem} · ${g.lines.length} item(ns)`,
      });
      continue;
    }
    const missing = g.lines.filter((l) => l.total == null || !Number.isFinite(Number(l.total))).length;
    const greeting = greetingName(g.name, phone, looksLikePhoneName);
    const { text, total, missingPrice } = buildPrevendaBillingMessage({
      customerName: greeting,
      roundName: opts.roundName || "Pré-venda",
      eventDate: opts.eventDate,
      paymentDue: opts.paymentDue,
      lines: g.lines,
    });
    if (missingPrice > 0 || missing > 0) {
      problems.push({
        name: g.name,
        phone,
        reason: `${missingPrice || missing} item(ns) sem valor`,
      });
      continue;
    }
    if (g.extraNames.length) mergedNames += 1;
    items.push({
      customer_id: null,
      customer_name: g.name || phone,
      phone_digits: phone,
      text,
      total,
      sale_line_ids: [],
      event_ids: [],
    });
  }

  items.sort((a, b) => a.customer_name.localeCompare(b.customer_name, "pt-BR", { sensitivity: "base" }));
  return { items, problems, mergedNames };
}
