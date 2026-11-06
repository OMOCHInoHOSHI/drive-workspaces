import type { OutboxEntry } from "./outbox.js";

/**
 * 手元の変更と別の端末の更新の競合判定。chrome API に依存しない純関数だけを置く。
 *
 * どちらを残すかは自動で決めない（片方の変更が失われるため）。
 * 判定したら送信も反映も止め、ユーザーが選ぶまで両方をそのまま残す。
 */

/** Drive の更新を受け取ったときに、未送信の手元の変更と競合するか（syncedHash は受け取る前の値） */
export function conflictsWithRemote(remoteHash: string, syncedHash: string, pending: OutboxEntry | undefined): boolean {
  if (!pending) return false;
  if (remoteHash === syncedHash) return false; // 名前や時刻だけの更新。タブは変わっていない
  return pending.hash !== remoteHash; // 同じ内容になっていれば、どちらを残しても同じ
}

/** 結び付けたウィンドウの扱い。keep: そのまま（違いがあれば手元の変更として送る）/ apply: Drive の内容を反映する / conflict: 確認する */
export type BindAction = "keep" | "apply" | "conflict";

export interface BindState {
  /** ウィンドウの今の内容 */
  windowHash: string;
  /** ウィンドウの同期対象のタブの数 */
  tabCount: number;
  /** Drive の内容 */
  syncedHash: string;
  /** ウィンドウが最後に Drive と一致した内容。手動で結び付けるときなど、当てにできなければ undefined */
  baseHash: string | undefined;
  /** 未送信の変更があるか */
  hasPending: boolean;
}

/**
 * ウィンドウと Drive のどちらが変わったかを判定する。
 * ウィンドウを閉じている間も Drive は更新されるので、復元したウィンドウは Drive より古いことがある。
 * そのまま送ると別の端末の更新を古い内容で上書きしてしまう
 */
export function decideOnBind(s: BindState): BindAction {
  if (s.windowHash === s.syncedHash) return "keep";
  if (s.tabCount === 0) return "apply"; // 目印だけのウィンドウ。失うタブが無い
  if (s.baseHash === s.syncedHash) return "keep"; // Drive は動いていないので、ウィンドウ側の変更
  if (s.baseHash === s.windowHash && !s.hasPending) return "apply"; // ウィンドウは動いていないので、Drive 側の変更
  return "conflict";
}
