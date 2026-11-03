/**
 * 反映で作ったタブの「要求した URL」の別名。chrome API に依存しない純関数だけを置く。
 *
 * 他端末の状態を反映して作ったタブは、その端末の環境（未ログイン・言語・モバイル判定など）でリダイレクトされることがある。
 * そのまま撮影すると、リダイレクト先が他端末に送られ、元のタブがリダイレクト先で置き換えられてしまう。
 * そこで、ユーザー自身がそのタブを移動させるまでは、実際の URL の代わりに要求した URL を記録する。
 *
 * ユーザー自身の移動とみなす条件: 一度でも読み込みが完了した後で、タブがアクティブで、前回の URL 変化・読み込み完了から
 * REDIRECT_WINDOW_MS 以上たってから URL が変わったとき（初回の読み込みが遅いサイトのリダイレクトを誤判定しないよう、完了前は外さない）。
 * 背面のタブはユーザーがクリックや入力で移動させられず、リダイレクトはたいてい読み込み中か直後に起きるため。
 * 判定は URL が実際に変わったときだけ行う。読み込み開始だけ（再読み込み、破棄されたタブや再起動後の未読み込みタブを
 * アクティブにしたときの読み込み）はユーザーによる移動ではないので、別名を外さない。
 */

export interface TabAlias {
  wsId: string;
  /** 要求した URL（撮影ではこちらを記録する） */
  url: string;
  /** 最後に見えた実際の URL（ブラウザ再起動後に、復元されたタブへ別名を付け直すのに使う） */
  actual: string;
  /** 最後に URL 変化・読み込み完了があった時刻 */
  settledAt: number;
  /** 付けてから一度でも読み込みが完了したか */
  loaded: boolean;
}

export const REDIRECT_WINDOW_MS = 3000;

export interface TabChange {
  url?: string;
  status?: string;
}

/** タブの変化を受けて別名を更新する。null は別名を外す（以後は実際の URL を記録する） */
export function nextAlias(alias: TabAlias, change: TabChange, active: boolean, now: number): TabAlias | null {
  if (change.url !== undefined && change.url !== alias.actual) {
    // 要求した URL に戻った（ログインし直して元のページに戻った等）なら、もう別名は要らない
    if (change.url === alias.url) return null;
    if (alias.loaded && active && now - alias.settledAt >= REDIRECT_WINDOW_MS) return null;
    return { ...alias, actual: change.url, settledAt: now }; // リダイレクトとみなす
  }
  if (change.status === "complete") return { ...alias, settledAt: now, loaded: true };
  return alias;
}

/** 撮影・照合に使う URL */
export function aliasedUrl(tabId: number | undefined, actual: string, aliases: Record<string, TabAlias>): string {
  return tabId === undefined ? actual : (aliases[String(tabId)]?.url ?? actual);
}

/** ブラウザ再起動前の別名から、そのワークスペースの「実際の URL → 要求した URL」の対応を作る */
export function staleUrlMap(stale: TabAlias[], wsId: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of stale) if (a.wsId === wsId && !m.has(a.actual)) m.set(a.actual, a.url);
  return m;
}

/**
 * 再起動後に対応づけたウィンドウのタブへ、再起動前の別名を付け直す。
 * 同じ実際の URL のタブが複数あっても、別名1件につき1タブだけに付ける
 */
export function restoreAliases(
  stale: TabAlias[],
  wsId: string,
  tabs: { id: number; url: string; loaded: boolean }[],
  now: number,
): { restored: Record<string, TabAlias>; rest: TabAlias[] } {
  const restored: Record<string, TabAlias> = {};
  const rest: TabAlias[] = [];
  const used = new Set<number>();
  for (const a of stale) {
    const t = a.wsId === wsId ? tabs.find((x) => !used.has(x.id) && x.url === a.actual) : undefined;
    if (!t) {
      rest.push(a);
      continue;
    }
    used.add(t.id);
    // 読み込み済みならそのまま。未読み込み（アクティブにしたときに読み込まれる）なら完了を待つ側にする
    restored[String(t.id)] = { ...a, settledAt: now, loaded: t.loaded };
  }
  return { restored, rest };
}

/**
 * 別名を新しく付ける。actual は付けた時点で見えている実際の URL、loaded はその時点で読み込みが完了しているか
 *（付ける前に完了イベントが過ぎていると、以後ずっと未完了扱いになってユーザーの移動を取りこぼすため）
 */
export function newAlias(wsId: string, url: string, actual: string, now: number, loaded = false): TabAlias {
  return { wsId, url, actual: actual || url, settledAt: now, loaded };
}

/** 別名のうち、存在しないタブのものを除く（同じセッション内で tabId は使い回されない） */
export function pruneAliases(aliases: Record<string, TabAlias>, liveTabIds: Set<number>): Record<string, TabAlias> {
  return Object.fromEntries(Object.entries(aliases).filter(([id]) => liveTabIds.has(Number(id))));
}
