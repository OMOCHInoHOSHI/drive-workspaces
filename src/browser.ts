/**
 * 実行中のブラウザの種類を判定する。
 * User-Agent Client Hints（navigator.userAgentData.brands）を使う。サービスワーカーでも使える。
 * Vivaldi などブランド名を出さないブラウザは判定できないので "Chromium" になる
 * （設定画面のブラウザ名で上書きできる）。
 */

interface UADataLike {
  brands?: { brand: string; version: string }[];
}

const KNOWN: [match: string, label: string][] = [
  ["Microsoft Edge", "Edge"],
  ["Opera GX", "Opera GX"],
  ["Opera", "Opera"],
  ["Brave", "Brave"],
  ["Vivaldi", "Vivaldi"],
  ["Google Chrome", "Chrome"],
];

export function detectBrowser(): string {
  const nav = globalThis.navigator as Navigator & { userAgentData?: UADataLike; brave?: unknown };
  const brands = (nav.userAgentData?.brands ?? []).map((b) => b.brand);
  for (const [match, label] of KNOWN) if (brands.includes(match)) return label;
  if (nav.brave !== undefined) return "Brave";
  // Client Hints が無い場合の保険（UA 文字列）
  const ua = nav.userAgent ?? "";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/")) return "Opera";
  return "Chromium";
}
