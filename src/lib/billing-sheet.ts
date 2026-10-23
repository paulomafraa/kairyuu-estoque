/**
 * Lista de cobrança a partir de uma aba de pré-venda.
 * Colunas: Item, Valor (total da linha), Cliente, Contato, Pagamento (opcional).
 * Telefone em branco só repete o de cima quando o nome também está em branco
 * (continuação do mesmo bloco). Se o nome vem escrito de novo e o contato
 * está vazio, o telefone copiado só vale quando esse nome existe em no máximo
 * uma ficha. Dois clientes com o mesmo nome exigem o telefone na linha.
 */

import { looksLikePhoneName, type BillingDraftItem, type BillingDraftProblem } from "./billing";
import { buildPrevendaBillingMessage, greetingName } from "./cobranca-msg";
import { parseMoneyCell } from "./encomenda-template";

export type SheetBillingLine = {
  title: string;
  total: number | null;
  /** Contato vazio; o telefone foi o da linha anterior com o mesmo nome. */
  phoneCopiedByName?: boolean;
};

export type SheetNameRef = { name: string };

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
  let lastCopied = false;
  const { cols } = header;

  for (let r = header.row + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const nameCell = cellText(row[cols.cliente]).replace(/\s+/g, " ").trim();
    const phoneCell = cellText(row[cols.contato]);
    let name = nameCell;
    let phoneRaw = phoneCell;
    let copiedByName = false;
    if (!nameCell && !phoneCell) {
      name = lastName;
      phoneRaw = lastPhone;
      copiedByName = lastCopied;
    } else if (!phoneCell && nameCell && lastPhone && loose(nameCell) === loose(lastName)) {
      phoneRaw = lastPhone;
      copiedByName = true;
    }
    const title = cellText(row[cols.item]).replace(/\s+/g, " ").trim();
    if (!title && !name && !phoneRaw) continue;
    if (name) lastName = name;
    if (phoneCell) lastPhone = phoneCell;
    lastCopied = copiedByName;
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
    g.lines.push({
      title,
      total: moneyCell(row[cols.valor]),
      phoneCopiedByName: copiedByName || undefined,
    });
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

function nameCounts(customers: SheetNameRef[] | null | undefined): Map<string, number> | null {
  if (!customers?.length) return null;
  const map = new Map<string, number>();
  for (const c of customers) {
    const key = loose(c.name || "");
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

export function buildSheetBillingDraft(
  groups: SheetBillingGroup[],
  opts: { roundName: string; eventDate: string | null; paymentDue: string | null },
  customers?: SheetNameRef[] | null,
): { items: BillingDraftItem[]; problems: BillingDraftProblem[]; mergedNames: number } {
  const items: BillingDraftItem[] = [];
  const problems: BillingDraftProblem[] = [];
  let mergedNames = 0;
  const knownNames = nameCounts(customers);

  for (const g of groups) {
    const copied = g.lines.filter((l) => l.phoneCopiedByName);
    const sameName = knownNames?.get(loose(g.name)) || 0;
    const ambiguous = copied.length > 0 && (knownNames == null || sameName > 1);
    const lines = ambiguous ? g.lines.filter((l) => !l.phoneCopiedByName) : g.lines;
    if (copied.length && ambiguous) {
      problems.push({
        name: g.name,
        phone: "",
        reason:
          sameName > 1
            ? `Há ${sameName} clientes com esse nome e ${copied.length} item(ns) sem telefone na planilha. Coloque o contato para não cobrar a pessoa errada`
            : `${copied.length} item(ns) sem telefone na planilha. O nome sozinho não define o contato`,
      });
    }
    if (!lines.length) continue;
    const { phone, problem } = sheetPhoneDigits(g.phoneRaw);
    if (!phone) {
      problems.push({
        name: g.name,
        phone: g.phoneRaw,
        reason: `${problem} · ${lines.length} item(ns)`,
      });
      continue;
    }
    const missing = lines.filter((l) => l.total == null || !Number.isFinite(Number(l.total))).length;
    const greeting = greetingName(g.name, phone, looksLikePhoneName);
    const { text, total, missingPrice } = buildPrevendaBillingMessage({
      customerName: greeting,
      roundName: opts.roundName || "Pré-venda",
      eventDate: opts.eventDate,
      paymentDue: opts.paymentDue,
      lines,
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
