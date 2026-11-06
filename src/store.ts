import type { TabAlias } from "./alias.js";
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

interface SessionSchema {
  /** このブラウザセッションで別名を整理済みか（済むまでは存在しないタブの別名を掃除しない） */
  aliasesReady: true;
  /** ワークスペース → 目印のタブグループ ID。groupId はブラウザ再起動で変わるので session に置く */
  anchorGroups: Record<string, number>;
  /** windowId → 目印を作り直した時刻。回数の制限に使う（サービスワーカーが止まっても数え直さないよう session に置く） */
  anchorRecreations: Record<string, number[]>;
}

interface LocalSchema {
  settings: Settings;
  auth: AuthState;
  deviceId: string;
  workspaces: Record<string, CachedWorkspace>;
  /** windowId(文字列) → wsId。windowId はブラウザ再起動で変わるので、起動時に捨てて目印タブから作り直す */
  windowMap: Record<string, string>;
  pageToken: string;
  lastSyncAt: number;
  lastError: string | null;
  /** ポップアップ一覧の並び順（プロファイルごと） */
  sortOrder: SortOrder;
  /** 未送信のワークスペースの最新状態（wsId → 状態）。ブラウザ再起動をまたいで残すため local に置く */
  outbox: Record<string, OutboxEntry>;
  /**
   * ウィンドウが最後に Drive と一致した内容（wsId → ハッシュ）。ウィンドウを閉じている間の Drive の更新では変わらないので、
   * 復元したウィンドウとワークスペースのどちらが変わったかを見分けられる
   */
  windowBase: Record<string, string>;
  /** 手元と Drive の内容が違い、どちらを残すか確認待ちのワークスペース（wsId → 検出時刻） */
  conflicts: Record<string, number>;
  /** 反映で作ったタブの別名（tabId → 別名）。tabId はブラウザ再起動で変わるので、起動時に staleAliases へ移す */
  tabAliases: Record<string, TabAlias>;
  /** ブラウザ再起動前の別名。結び付けたウィンドウのタブへ付け直す */
  staleAliases: TabAlias[];
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

export async function getWindowBases(): Promise<Record<string, string>> {
  return (await getLocal("windowBase")) ?? {};
}

export async function setWindowBase(wsId: string, hash: string): Promise<void> {
  await serialize(async () => {
    const all = await getWindowBases();
    if (all[wsId] === hash) return;
    await setLocal("windowBase", { ...all, [wsId]: hash });
  });
}

export async function removeWindowBase(wsId: string): Promise<void> {
  await serialize(async () => {
    const all = await getWindowBases();
    if (!(wsId in all)) return;
    delete all[wsId];
    await setLocal("windowBase", all);
  });
}

export async function getConflicts(): Promise<Record<string, number>> {
  return (await getLocal("conflicts")) ?? {};
}

export async function markConflict(wsId: string): Promise<void> {
  await serialize(async () => {
    const all = await getConflicts();
    if (wsId in all) return;
    await setLocal("conflicts", { ...all, [wsId]: Date.now() });
  });
}

export async function clearConflict(wsId: string): Promise<void> {
  await serialize(async () => {
    const all = await getConflicts();
    if (!(wsId in all)) return;
    delete all[wsId];
    await setLocal("conflicts", all);
  });
}

// ---- 反映で作ったタブの別名 ----
// タブの読み込みイベントのたびに読むので、メモリにも持つ（別名を使うのは background だけ）。
// サービスワーカーが再起動したら最初の読み書きで storage から読み直す

let aliasCache: Record<string, TabAlias> | undefined;
/** putAlias で保存待ちのタブ。保存前に来たイベントを「別名なし」として捨てないため */
const pendingAliasTabs = new Map<number, number>();

async function loadAliases(): Promise<Record<string, TabAlias>> {
  aliasCache ??= (await getLocal("tabAliases")) ?? {};
  return aliasCache;
}

async function saveAliases(next: Record<string, TabAlias>): Promise<void> {
  aliasCache = next;
  await setLocal("tabAliases", next);
}

/** 別名が無いことが確実なら true（メモリに読み込み済みで、そのタブの別名が無い）。storage は読まない */
export function surelyNoAlias(tabId: number): boolean {
  return aliasCache !== undefined && !pendingAliasTabs.has(tabId) && !(String(tabId) in aliasCache);
}

/** putAlias / updateAlias と同じ直列化を通して読む（先に始まった更新の結果が必ず見える） */
export async function getAliases(): Promise<Record<string, TabAlias>> {
  return serialize(async () => ({ ...(await loadAliases()) }));
}

export async function putAlias(tabId: number, alias: TabAlias): Promise<void> {
  // 直列化の前に（同期的に）保存待ちとして印を付ける
  pendingAliasTabs.set(tabId, (pendingAliasTabs.get(tabId) ?? 0) + 1);
  try {
    await serialize(async () => saveAliases({ ...(await loadAliases()), [String(tabId)]: alias }));
  } finally {
    const n = (pendingAliasTabs.get(tabId) ?? 1) - 1;
    if (n > 0) pendingAliasTabs.set(tabId, n);
    else pendingAliasTabs.delete(tabId);
  }
}

/** 別名があれば fn で更新する。外したら true */
export async function updateAlias(tabId: number, fn: (a: TabAlias) => TabAlias | null): Promise<boolean> {
  return serialize(async () => {
    const all = await loadAliases();
    const cur = all[String(tabId)];
    if (!cur) return false;
    const next = fn(cur);
    if (next === cur) return false;
    const copy = { ...all };
    if (next) copy[String(tabId)] = next;
    else delete copy[String(tabId)];
    await saveAliases(copy);
    return next === null;
  });
}

/** 条件に合う別名を消す */
export async function removeAliasesWhere(pred: (tabId: number, a: TabAlias) => boolean): Promise<void> {
  await serialize(async () => {
    const all = await loadAliases();
    const kept = Object.fromEntries(Object.entries(all).filter(([id, a]) => !pred(Number(id), a)));
    if (Object.keys(kept).length !== Object.keys(all).length) await saveAliases(kept);
  });
}

export async function removeAlias(tabId: number): Promise<void> {
  await removeAliasesWhere((id) => id === tabId);
}

export async function removeAliasesOfWorkspace(wsId: string): Promise<void> {
  await removeAliasesWhere((_id, a) => a.wsId === wsId);
}

/** prerender 等でタブが差し替わったときに別名を引き継ぐ */
export async function moveAlias(fromTabId: number, toTabId: number): Promise<void> {
  await serialize(async () => {
    const all = await loadAliases();
    const cur = all[String(fromTabId)];
    if (!cur) return;
    const copy = { ...all, [String(toTabId)]: cur };
    delete copy[String(fromTabId)];
    await saveAliases(copy);
  });
}

/** ブラウザ起動時: tabId が変わるので、今の別名を「再起動前の別名」へ移す */
export async function rotateAliasesOnStartup(): Promise<void> {
  await serialize(async () => {
    await setLocal("staleAliases", Object.values(await loadAliases()));
    await saveAliases({});
    await markAliasesReady();
  });
}

/**
 * 別名を整理済みとして記録する（storage.session はブラウザ終了で消える）。
 * 起動直後、退避前に掃除が走って「再起動後に付け直すための別名」を消さないようにするため
 */
export async function markAliasesReady(): Promise<void> {
  await chrome.storage.session.set({ aliasesReady: true } satisfies Partial<SessionSchema>);
}

export async function aliasesReady(): Promise<boolean> {
  const r = await chrome.storage.session.get("aliasesReady");
  return r.aliasesReady === true;
}

export async function getAnchorGroups(): Promise<Record<string, number>> {
  const r = await chrome.storage.session.get("anchorGroups");
  return (r.anchorGroups as SessionSchema["anchorGroups"] | undefined) ?? {};
}

export async function setAnchorGroup(wsId: string, groupId: number): Promise<void> {
  await serialize(async () => {
    const anchorGroups = { ...(await getAnchorGroups()), [wsId]: groupId };
    await chrome.storage.session.set({ anchorGroups } satisfies Partial<SessionSchema>);
  });
}

export async function getAnchorRecreations(windowId: number): Promise<number[]> {
  const r = await chrome.storage.session.get("anchorRecreations");
  return (r.anchorRecreations as SessionSchema["anchorRecreations"] | undefined)?.[String(windowId)] ?? [];
}

export async function setAnchorRecreations(windowId: number, times: number[]): Promise<void> {
  await serialize(async () => {
    const r = await chrome.storage.session.get("anchorRecreations");
    const all = (r.anchorRecreations as SessionSchema["anchorRecreations"] | undefined) ?? {};
    await chrome.storage.session.set({
      anchorRecreations: { ...all, [String(windowId)]: times },
    } satisfies Partial<SessionSchema>);
  });
}

export async function getStaleAliases(): Promise<TabAlias[]> {
  return (await getLocal("staleAliases")) ?? [];
}

/** 再起動前の別名の一部をタブに付け直し、残りを staleAliases に戻す */
export async function commitRestoredAliases(restored: Record<string, TabAlias>, rest: TabAlias[]): Promise<void> {
  await serialize(async () => {
    await saveAliases({ ...(await loadAliases()), ...restored });
    await setLocal("staleAliases", rest);
  });
}
