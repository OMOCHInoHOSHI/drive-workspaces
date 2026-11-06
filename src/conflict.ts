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
