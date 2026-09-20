/**
 * Data em que o leilão/encomenda aconteceu (não a data em que o staff
 * lançou no estoque). Prefere a data escrita no nome do evento.
 */

function inferYear(day: number, month: number, now = new Date()): number {
  let year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  const diffDays = (candidate.getTime() - now.getTime()) / 86_400_000;
  if (diffDays > 90) year -= 1;
  return year;
}

/** Extrai dd/mm[/aa] do nome (ex.: "leilão dia 30/08/26"). */
export function parseDateFromEventName(name: string): string | null {
  const raw = (name || "").trim();
  if (!raw) return null;
  const re = /\b(\d{1,2})[/.\\-](\d{1,2})(?:[/.\\-](\d{2,4}))?\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    let year = match[3] ? Number(match[3]) : inferYear(day, month);
    if (year < 100) year += 2000;
    const dt = new Date(year, month - 1, day);
    if (
      dt.getFullYear() !== year ||
      dt.getMonth() !== month - 1 ||
      dt.getDate() !== day
    ) {
      continue;
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

export function dateInputFromIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

/** YYYY-MM-DD do dia em que o evento aconteceu. */
export function eventHappenedOn(opts: {
  name?: string | null;
  opened_at?: string | null;
}): string | null {
  const fromName = parseDateFromEventName(opts.name || "");
  if (fromName) return fromName;
  const fromOpened = dateInputFromIso(opts.opened_at);
  return fromOpened || null;
}

/** Grava opened_at ao meio-dia local, sem virar o dia por fuso. */
export function eventHappenedAtIso(ymd: string): string {
  return `${ymd}T12:00:00`;
}
