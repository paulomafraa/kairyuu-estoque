import { productMatchKey } from "@/lib/encomenda-template";

const MARK = "kairyuu-card-order";
const RE = /<!--kairyuu-card-order:([\s\S]*?)-->/;

export function parseEmbeddedCardOrder(
  notes: string | null | undefined,
): Record<string, number> {
  const m = (notes || "").match(RE);
  if (!m?.[1]) return {};
  try {
    const raw = JSON.parse(m[1]) as Record<string, number>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function embedCardOrder(
  notes: string | null | undefined,
  order: Record<string, number>,
): string {
  const block = `<!--${MARK}:${JSON.stringify(order)}-->`;
  const stripped = (notes || "").replace(RE, "").trimEnd();
  return stripped ? `${stripped}\n${block}` : block;
}

export function orderMapFromTitles(titles: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  let i = 0;
  for (const title of titles) {
    const key = productMatchKey(title);
    if (!key || out[key] != null) continue;
    i += 1;
    out[key] = i;
  }
  return out;
}
