/** Exporta as linhas atuais do evento no formato da planilha Resultado (CSV). */

export type ExportSaleLine = {
  product_title: string;
  customer_name_snapshot: string;
  phone_digits: string;
  valor_ou_opcao: string;
  unit_price: number | null;
  qty: number;
  import_status: string;
  certainty: string;
  arremate: boolean;
  poll_id: string;
  cancelled?: boolean;
  paid?: boolean;
  charged?: boolean;
  separated?: boolean;
  notes?: string;
};

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function moneyCell(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}

/** Gera CSV UTF-8 (com BOM) espelhando o Resultado corrigido na UI. */
export function buildResultadoCsv(lines: ExportSaleLine[]): string {
  const header = [
    "ordem",
    "bloco",
    "status",
    "carta",
    "cobranca_para",
    "telefone",
    "valor_ou_opcao",
    "arremate",
    "verificar_manual",
    "poll_id",
    "qty",
    "unit_price",
    "pago",
    "cobrado",
    "separado",
    "cancelado",
    "notes",
  ];

  const rows = lines.map((l, i) => {
    const st = l.import_status || "manual";
    const verificar =
      st === "verificar_manual" || l.certainty === "manual_review"
        ? "sim"
        : "";
    const valor =
      (l.valor_ou_opcao || "").trim() ||
      (l.unit_price != null ? moneyCell(l.unit_price) : "");
    return [
      String(i + 1),
      "",
      st,
      l.product_title || "",
      l.customer_name_snapshot || "",
      l.phone_digits || "",
      valor,
      l.arremate ? "sim" : "",
      verificar,
      l.poll_id || "",
      String(Number(l.qty) > 0 ? Number(l.qty) : 1),
      moneyCell(l.unit_price),
      l.paid ? "sim" : "",
      l.charged ? "sim" : "",
      l.separated ? "sim" : "",
      l.cancelled ? "sim" : "",
      l.notes || "",
    ]
      .map((c) => csvEscape(String(c)))
      .join(",");
  });

  return `\uFEFF${[header.join(","), ...rows].join("\n")}`;
}

export function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
