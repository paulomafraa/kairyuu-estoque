/** Normaliza telefone para só dígitos (chave de importação). */
export function normalizePhoneDigits(raw: string): string {
  return (raw || "").replace(/\D/g, "");
}

export function parseClientsCsv(text: string): Array<{
  phone: string;
  name: string;
}> {
  const raw = text.replace(/^\uFEFF/, "").trim();
  if (!raw) return [];

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const split = (line: string) => {
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
    return out.map((s) => s.trim());
  };

  let start = 0;
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const hasHeader =
    header.includes("telefone") ||
    header.includes("phone") ||
    header.includes("nome") ||
    header.includes("name");

  let phoneIdx = 0;
  let nameIdx = 1;
  if (hasHeader) {
    start = 1;
    phoneIdx = Math.max(
      0,
      header.findIndex((h) =>
        ["telefone", "phone", "celular", "whatsapp"].includes(h),
      ),
    );
    nameIdx = header.findIndex((h) => ["nome", "name", "pushname"].includes(h));
    if (nameIdx < 0) nameIdx = phoneIdx === 0 ? 1 : 0;
  }

  const byPhone = new Map<string, { phone: string; name: string }>();
  for (let i = start; i < lines.length; i++) {
    const cols = split(lines[i]);
    const phone = normalizePhoneDigits(cols[phoneIdx] || "");
    if (!/^\d{10,15}$/.test(phone)) continue;
    const name = (cols[nameIdx] || "").trim() || phone;
    byPhone.set(phone, { phone, name });
  }
  return [...byPhone.values()];
}
