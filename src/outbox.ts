import type { CachedWorkspace, GroupState, TabState } from "./types.js";

/**
 * 送信待ちキュー（outbox）の判定ロジック。chrome API に依存しない純関数だけを置く。
 *
 * タブが変わった時点でウィンドウの状態を撮影して outbox に積み、送信はそこから行う。
 * 送信時にウィンドウを読み直さないので、×ボタンで閉じた後やブラウザ再起動後でも最後の状態を送れる。
 * 積むのは操作（追加・削除）ではなくワークスペースごとの最新状態1件で、何度送り直しても結果は同じになる。
 */

export interface OutboxEntry {
  tabs: TabState[];
  groups: GroupState[];
  /** hashOf(tabs, groups) */
  hash: string;
  queuedAt: number;
}

/** 送信後に消してよいか（送信中に新しい状態が積まれていたら消さない） */
export function sameEntry(a: OutboxEntry | undefined, b: OutboxEntry): boolean {
  return !!a && a.hash === b.hash && a.queuedAt === b.queuedAt;
}

/** 撮影した状態を outbox に積むべきか */
export function shouldEnqueue(
  hash: string,
  tabCount: number,
  cached: CachedWorkspace | undefined,
  pending: OutboxEntry | undefined,
): boolean {
  if (!cached) return false;
  // 安全装置: ウィンドウを閉じる途中などで空になった状態は積まない
  if (tabCount === 0 && cached.doc.tabs.length > 0) return false;
  // 未送信がある場合は、同期済みの状態に戻ったときも積む（送信時に「送る必要なし」として破棄される）
  if (pending) return pending.hash !== hash;
  return hash !== cached.syncedHash;
}

/** outbox の状態を Drive に送る必要があるか */
export function needsUpload(entry: OutboxEntry, cached: CachedWorkspace): boolean {
  return entry.hash !== cached.syncedHash;
}

/**
 * 末尾デバウンス（最後の呼び出しから wait 後に実行）。ただし最初の呼び出しから maxWait を超えたら待たずに実行する。
 * 連続してタブを操作している間も、送信が無期限に先送りされないようにするため。
 */
export function debounceWithMaxWait(
  fn: () => void,
  wait: number,
  maxWait: number,
  now: () => number = Date.now,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = undefined;
    firstAt = undefined;
    fn();
  };
  return () => {
    const t = now();
    firstAt ??= t;
    clearTimeout(timer);
    const remaining = firstAt + maxWait - t;
    if (remaining <= 0) fire();
    else timer = setTimeout(fire, Math.min(wait, remaining));
  };
}
