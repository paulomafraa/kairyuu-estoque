export type CardSortMode = "enquete" | "nome";

export function parsePollTime(raw: string | null | undefined): number | null {
  const t = (raw || "").trim();
  if (!t) return null;
  const ms = Date.parse(t);
  if (Number.isFinite(ms)) return ms;
  const br = t.match(
    /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!br) return null;
  let year = Number(br[3]);
  if (year < 100) year += 2000;
  const dt = new Date(
    year,
    Number(br[2]) - 1,
    Number(br[1]),
    Number(br[4] || 0),
    Number(br[5] || 0),
    Number(br[6] || 0),
  );
  const n = dt.getTime();
  return Number.isFinite(n) ? n : null;
}

export function cardSortMs(opts: {
  pollCreatedAt?: string | null;
  sortIndex?: number | null;
  createdAt?: string | null;
}): number {
  const poll = parsePollTime(opts.pollCreatedAt);
  if (poll != null) return poll;
  if (opts.sortIndex != null && Number.isFinite(opts.sortIndex)) {
    return opts.sortIndex;
  }
  const created = parsePollTime(opts.createdAt);
  if (created != null) return created;
  return Number.POSITIVE_INFINITY;
}

export function compareByCardSort(
  aTitle: string,
  aMs: number,
  bTitle: string,
  bMs: number,
  mode: CardSortMode,
): number {
  if (mode === "nome") return aTitle.localeCompare(bTitle, "pt-BR");
  return aMs - bMs || aTitle.localeCompare(bTitle, "pt-BR");
}
