import { normalizePhoneDigits } from "./clients-csv";

export type ResultadoRow = {
  ordem?: string;
  bloco?: string;
  status: string;
  carta: string;
  cobranca_para: string;
  telefone: string;
  valor_ou_opcao: string;
  arremate: string;
  verificar_manual: string;
  cliques_sem_opcao?: string;
  poll_id: string;
};

export type ParsedSaleLine = {
  phone_digits: string;
  customer_name_snapshot: string;
  product_title: string;
  valor_ou_opcao: string;
  unit_price: number | null;
  import_status:
    | "arrematado"
    | "lance"
    | "voto"
    | "verificar_manual"
    | "sem_voto"
    | "manual";
  certainty: "certain" | "manual_review";
  arremate: boolean;
  poll_id: string;
  qty: number;
};

/** Opção firme de encomenda (!encE) — ignora 💙💙💙. */
export function isEncQueroOption(name: string): boolean {
  const n = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return n.includes("quero");
}

/** Opção de interesse (💙) — não é pedido. */
export function isEncInterestOption(name: string): boolean {
  const t = (name || "").trim();
  if (!t) return false;
  if (isEncQueroOption(t)) return false;
  if (t.includes("💙") || t.includes("❤") || t.includes("♥")) return true;
  return false;
}

/** Linha fora da cobrança/estoque ativo (arquivada ou 💙 em encomenda). */
export function isShelvedSaleLine(
  line: {
    archived?: boolean | null;
    import_status?: string;
    valor_ou_opcao?: string;
  },
  kind?: string | null,
): boolean {
  if (line.archived) return true;
  if (
    kind === "encomenda" &&
    (line.import_status === "voto" || line.import_status === "manual") &&
    isEncInterestOption(line.valor_ou_opcao || "")
  ) {
    return true;
  }
  return false;
}

function normHeader(h: string) {
  return h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Extrai número de textos tipo "é minha por R$ 12,50" / "R$ 10,00". */
export function parseMoneyFromOption(text: string): number | null {
  const m = text.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!m) return null;
  const raw = m[1].replace(/\./g, "").replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function mapStatus(status: string): ParsedSaleLine["import_status"] {
  const s = status.trim().toLowerCase();
  if (s === "arrematado") return "arrematado";
  if (s === "lance") return "lance";
  if (s === "voto") return "voto";
  if (s === "sem_voto" || s.includes("sem_voto") || s === "sem voto") {
    return "sem_voto";
  }
  if (s.includes("verificar")) return "verificar_manual";
  return "manual";
}

export function isCertainResultado(row: {
  status: string;
  verificar_manual: string;
  telefone: string;
  cobranca_para?: string;
}): boolean {
  if ((row.verificar_manual || "").trim().toLowerCase() === "sim") return false;
  const st = mapStatus(row.status);
  if (st === "verificar_manual" || st === "sem_voto") return false;
  if (!normalizePhoneDigits(row.telefone)) return false;
  if (st !== "arrematado" && st !== "lance" && st !== "voto") return false;
  return true;
}

/** Classifica linha do Resultado em dono certo / revisão / sem votos. */
export function classifyResultadoBucket(
  row: ResultadoRow,
): "certain" | "review" | "no_votes" | null {
  const title = (row.carta || "").trim();
  if (!title) return null;
  const st = mapStatus(row.status || "");
  const phone = normalizePhoneDigits(row.telefone || "");
  const ver =
    (row.verificar_manual || "").trim().toLowerCase() === "sim" ||
    st === "verificar_manual";

  if (st === "sem_voto") return "no_votes";
  if (ver) return "review";
  // Lance/arremate sem telefone = ninguém votou (planilhas antigas)
  if (
    (st === "lance" || st === "arrematado" || st === "manual") &&
    !phone
  ) {
    return "no_votes";
  }
  if (st === "arrematado" || st === "lance" || st === "voto") {
    return phone ? "certain" : "no_votes";
  }
  return "review";
}

/** Classifica linha já salva no estoque (inclui legado: lance sem telefone). */
export function classifyStoredLeilaoLine(line: {
  import_status?: string;
  certainty?: string;
  phone_digits?: string | null;
  valor_ou_opcao?: string | null;
  notes?: string | null;
}): "certain" | "review" | "no_votes" {
  const phone = String(line.phone_digits || "").trim();
  const st = (line.import_status || "").trim();
  const hint = `${line.valor_ou_opcao || ""} ${line.notes || ""}`.toLowerCase();

  // Já resolvido no estoque (ex.: atribuição da revisão ❓) — prioridade sobre
  // valor_ou_opcao legado "verificar_manual".
  if (
    line.certainty === "certain" &&
    phone &&
    (st === "arrematado" || st === "lance" || st === "manual")
  ) {
    return "certain";
  }

  if (st === "verificar_manual" || hint.includes("verificar_manual")) {
    return "review";
  }
  if (st === "sem_voto" || hint.includes("sem_voto")) return "no_votes";

  // Planilhas antigas: status lance/arremate sem telefone = sem votos
  if (
    !phone &&
    (st === "lance" || st === "arrematado" || st === "manual" || !st)
  ) {
    return "no_votes";
  }

  // Só trata como sem votos se for lance/arremate vazio — não misturar com ❓
  if (
    !phone &&
    line.certainty === "manual_review" &&
    (st === "lance" || st === "arrematado" || st === "manual")
  ) {
    return "no_votes";
  }

  if (line.certainty === "manual_review") return "review";
  return "certain";
}

export function resultadoToSaleLine(row: ResultadoRow): ParsedSaleLine | null {
  const title = (row.carta || "").trim();
  if (!title) return null;

  const bucket = classifyResultadoBucket(row);
  if (!bucket) return null;

  let import_status = mapStatus(row.status || "");
  if (bucket === "no_votes" && import_status !== "sem_voto") {
    import_status = "sem_voto";
  }
  if (bucket === "review" && import_status !== "verificar_manual") {
    import_status = "verificar_manual";
  }

  const phone = normalizePhoneDigits(row.telefone || "");
  const valor = (row.valor_ou_opcao || "").trim();

  return {
    phone_digits: phone,
    customer_name_snapshot: (row.cobranca_para || "").trim(),
    product_title: title,
    valor_ou_opcao: valor,
    unit_price: parseMoneyFromOption(valor) ?? parseMoneyFromOption(title),
    import_status,
    certainty: bucket === "certain" ? "certain" : "manual_review",
    arremate:
      (row.arremate || "").trim().toLowerCase() === "sim" ||
      import_status === "arrematado",
    poll_id: (row.poll_id || "").trim(),
    qty: 1,
  };
}

/**
 * Filtra linhas conforme o tipo do evento.
 * - leilão: arremate/lance certos + revisão ❓ + sem votos (controle do que saiu)
 * - encomenda: só votos em "Eu quero…"
 */
export function filterLinesForKind(
  lines: ParsedSaleLine[],
  kind: "leilao" | "encomenda" | "outro" | string | undefined,
): { keep: ParsedSaleLine[]; skipped: number } {
  if (kind === "encomenda") {
    const keep = lines.filter(
      (l) =>
        l.import_status === "voto" && isEncQueroOption(l.valor_ou_opcao),
    );
    return { keep, skipped: lines.length - keep.length };
  }
  if (kind === "leilao") {
    const keep = lines.filter((l) =>
      ["arrematado", "lance", "verificar_manual", "sem_voto"].includes(
        l.import_status,
      ),
    );
    return { keep, skipped: lines.length - keep.length };
  }
  return { keep: lines, skipped: 0 };
}

function rowsFromMatrix(matrix: string[][]): ResultadoRow[] {
  if (!matrix.length) return [];
  const header = matrix[0].map(normHeader);
  const idx = (names: string[]) =>
    header.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const iStatus = idx(["status"]);
  const iCarta = idx(["carta", "titulo", "enquete"]);
  const iNome = idx(["cobranca_para", "cobranca", "nome"]);
  const iTel = idx(["telefone", "telefone_jid", "phone"]);
  const iValor = idx(["valor_ou_opcao", "valor", "opcao"]);
  const iArr = idx(["arremate"]);
  const iVer = idx(["verificar_manual", "verificar"]);
  const iPoll = idx(["poll_id", "pollid"]);

  if (iCarta < 0) return [];

  const out: ResultadoRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const line = matrix[r];
    if (!line || !line.some((c) => String(c || "").trim())) continue;
    out.push({
      status: String(line[iStatus] ?? ""),
      carta: String(line[iCarta] ?? ""),
      cobranca_para: String(iNome >= 0 ? line[iNome] ?? "" : ""),
      telefone: String(iTel >= 0 ? line[iTel] ?? "" : ""),
      valor_ou_opcao: String(iValor >= 0 ? line[iValor] ?? "" : ""),
      arremate: String(iArr >= 0 ? line[iArr] ?? "" : ""),
      verificar_manual: String(iVer >= 0 ? line[iVer] ?? "" : ""),
      poll_id: String(iPoll >= 0 ? line[iPoll] ?? "" : ""),
    });
  }
  return out;
}

function parseCsvMatrix(text: string): string[][] {
  const raw = text.replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const matrix: string[][] = [];
  for (const line of lines) {
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
      if ((ch === "," || ch === ";") && !inQ) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    matrix.push(out.map((s) => s.trim()));
  }
  return matrix;
}

export function parseResultadoCsv(text: string): {
  certain: ParsedSaleLine[];
  review: ParsedSaleLine[];
  noVotes: ParsedSaleLine[];
} {
  const rows = rowsFromMatrix(parseCsvMatrix(text));
  return splitResultadoBuckets(rows);
}

export async function parseResultadoFile(file: File): Promise<{
  certain: ParsedSaleLine[];
  review: ParsedSaleLine[];
  noVotes: ParsedSaleLine[];
  sheetUsed: string;
}> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = await file.text();
    const parsed = parseResultadoCsv(text);
    return { ...parsed, sheetUsed: "csv" };
  }

  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName =
    wb.SheetNames.find((s) => normHeader(s) === "resultado") ||
    wb.SheetNames.find((s) => normHeader(s).includes("resultado")) ||
    wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  }) as string[][];
  const rows = rowsFromMatrix(matrix);
  return { ...splitResultadoBuckets(rows), sheetUsed: sheetName };
}

function splitResultadoBuckets(rows: ResultadoRow[]) {
  const certain: ParsedSaleLine[] = [];
  const review: ParsedSaleLine[] = [];
  const noVotes: ParsedSaleLine[] = [];
  for (const row of rows) {
    const bucket = classifyResultadoBucket(row);
    const line = resultadoToSaleLine(row);
    if (!line || !bucket) continue;
    if (bucket === "certain") certain.push(line);
    else if (bucket === "no_votes") noVotes.push(line);
    else review.push(line);
  }
  return { certain, review, noVotes };
}

/** Dias até o vencimento (negativo = atrasado). */
export function daysUntil(due: string | null | undefined, now = new Date()): number | null {
  if (!due) return null;
  const d = new Date(`${due.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const a = new Date(now);
  a.setHours(12, 0, 0, 0);
  return Math.round((d.getTime() - a.getTime()) / 86_400_000);
}

export function paymentUrgency(
  paid: boolean,
  cancelled: boolean,
  due: string | null | undefined,
  warnDays = 3,
): "ok" | "warn" | "overdue" | "none" {
  if (cancelled || paid) return "ok";
  const left = daysUntil(due);
  if (left == null) return "none";
  if (left < 0) return "overdue";
  if (left <= warnDays) return "warn";
  return "ok";
}
