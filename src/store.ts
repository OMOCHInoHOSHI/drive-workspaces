import { type OutboxEntry, sameEntry } from "./outbox.js";
import type { AuthState, CachedWorkspace, Settings } from "./types.js";

/**
 * chrome.storage のラッパー。
 * MV3 のサービスワーカーは30秒の無操作で停止されるため、状態はメモリではなく必ずここに置く。
 */

// ---- 排他制御（read-modify-write を直列に実行する） ----
// withLock（sync 側）とは別に、storage への読み書きを短時間で直列化する。
// タブイベント由来の putOutbox が送信後の removeOutboxIf の読み書きの合間に割り込むと
// 新しく積んだ状態が消えるため、ストレージ操作単位で順序を保証する。
let storageQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const p = storageQueue.then(fn, fn);
  storageQueue = p.catch(() => undefined);
  return p;
}

interface LocalSchema {
  settings: Settings;
  auth: AuthState;
  deviceId: string;
  workspaces: Record<string, CachedWorkspace>;
  /** windowId(文字列) → wsId。windowId はブラウザ再起動で変わるので起動時に貼り直す */
  windowMap: Record<string, string>;
  pageToken: string;
  lastSyncAt: number;
  lastError: string | null;
  /** ポップアップ一覧の並び順（プロファイルごと） */
  sortOrder: SortOrder;
  /** 未送信のワークスペースの最新状態（wsId → 状態）。ブラウザ再起動をまたいで残すため local に置く */
  outbox: Record<string, OutboxEntry>;
}

export type SortOrder = "recent" | "name";

export async function getLocal<K extends keyof LocalSchema>(key: K): Promise<LocalSchema[K] | undefined> {
  const r = await chrome.storage.local.get(key);
  return r[key] as LocalSchema[K] | undefined;
}

export async function setLocal<K extends keyof LocalSchema>(key: K, value: LocalSchema[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeLocal(key: keyof LocalSchema): Promise<void> {
  await chrome.storage.local.remove(key);
}

export async function getDeviceId(): Promise<string> {
  return serialize(async () => {
    let id = await getLocal("deviceId");
    if (!id) {
      id = crypto.randomUUID();
      await setLocal("deviceId", id);
    }
    return id;
  });
}

export async function getWorkspaces(): Promise<Record<string, CachedWorkspace>> {
  return (await getLocal("workspaces")) ?? {};
}

export async function putWorkspace(ws: CachedWorkspace): Promise<void> {
  await serialize(async () => {
    const all = await getWorkspaces();
    all[ws.doc.id] = ws;
    await setLocal("workspaces", all);
  });
}

export async function deleteWorkspaceCache(wsId: string): Promise<void> {
  await serialize(async () => {
    const all = await getWorkspaces();
    delete all[wsId];
    await setLocal("workspaces", all);
  });
}

export async function getWindowMap(): Promise<Record<string, string>> {
  return (await getLocal("windowMap")) ?? {};
}

export async function mapWindow(windowId: number, wsId: string): Promise<void> {
  await serialize(async () => {
    const map = await getWindowMap();
    // 1ワークスペース = 1ウィンドウ。古い対応は消す
    for (const [w, id] of Object.entries(map)) if (id === wsId) delete map[w];
    map[String(windowId)] = wsId;
    await setLocal("windowMap", map);
  });
}

export async function unmapWindow(windowId: number): Promise<void> {
  await serialize(async () => {
    const map = await getWindowMap();
    delete map[String(windowId)];
    await setLocal("windowMap", map);
  });
}

export async function unmapWorkspace(wsId: string): Promise<void> {
  await serialize(async () => {
    const map = await getWindowMap();
    for (const [w, id] of Object.entries(map)) if (id === wsId) delete map[w];
    await setLocal("windowMap", map);
  });
}

export async function windowOf(wsId: string): Promise<number | null> {
  const map = await getWindowMap();
  for (const [w, id] of Object.entries(map)) if (id === wsId) return Number(w);
  return null;
}

export async function getOutbox(): Promise<Record<string, OutboxEntry>> {
  return (await getLocal("outbox")) ?? {};
}

/**
 * 状態を outbox に積む。skipIf はストレージ操作と同じ直列化の中で評価する
 *（リモート適用の開始と「積むかどうかの判定」が入れ違わないようにするため）。積んだら true
 */
export async function putOutbox(wsId: string, entry: OutboxEntry, skipIf?: () => boolean): Promise<boolean> {
  return serialize(async () => {
    if (skipIf?.()) return false;
    const box = await getOutbox();
    box[wsId] = entry;
    await setLocal("outbox", box);
    return true;
  });
}

/** 1件読む。putOutbox と同じ直列化を通すので、先に始まった書き込みの結果が必ず見える */
export async function getOutboxEntry(wsId: string): Promise<OutboxEntry | undefined> {
  return serialize(async () => (await getOutbox())[wsId]);
}

/** 送信した状態がまだ outbox の最新なら消す（送信中に新しい状態が積まれていたら残す） */
export async function removeOutboxIf(wsId: string, sent: OutboxEntry): Promise<void> {
  await serialize(async () => {
    const box = await getOutbox();
    if (!sameEntry(box[wsId], sent)) return;
    delete box[wsId];
    await setLocal("outbox", box);
  });
}

export async function removeOutbox(wsId: string): Promise<void> {
  await serialize(async () => {
    const box = await getOutbox();
    if (!(wsId in box)) return;
    delete box[wsId];
    await setLocal("outbox", box);
  });
}
