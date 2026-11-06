/**
 * ウィンドウの目印タブの URL。chrome API に依存しない純関数だけを置く。
 *
 * windowId はブラウザ再起動で変わり、ウィンドウ自体に名前などの情報を付ける API もない。
 * そこでウィンドウの先頭に「ワークスペース ID を URL に持つタブ」を置き、それでウィンドウを見分ける。
 * タブはセッション復元で URL ごと戻るので、いつ復元されても同じワークスペースに結び付けられる。
 * ID は # 以降に入れる（サーバーへは送られない）。ワークスペース名は URL に入れない。
 */

const ANCHOR_PAGE = "https://www.google.com/";
const MARK = "#dw=";
/** 同じウィンドウで目印を作り直せる回数と、その数え直しの間隔 */
const RECREATE_LIMIT = 3;
const RECREATE_WINDOW_MS = 10 * 60 * 1000;

export function anchorUrl(wsId: string): string {
  return `${ANCHOR_PAGE}${MARK}${wsId}`;
}

/** 目印の URL ならワークスペース ID を返す。リダイレクトされても # 以降は引き継がれるので、パスは見ない */
export function anchorWsId(url: string): string | null {
  if (!url.includes(MARK)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hash.startsWith(MARK)) return null;
  if (u.hostname !== "google.com" && !u.hostname.endsWith(".google.com")) return null;
  return u.hash.slice(MARK.length) || null;
}

/**
 * 今までの作り直しの時刻のうち、回数の制限に数えるものを返す。
 * 目印の URL が別のサイトへリダイレクトされる環境では、作り直すたびに目印が失われてタブが増え続けるので、回数を制限する
 */
export function recentRecreations(times: number[], now: number): number[] {
  return times.filter((t) => now - t < RECREATE_WINDOW_MS);
}

export function canRecreateAnchor(times: number[], now: number): boolean {
  return recentRecreations(times, now).length < RECREATE_LIMIT;
}
