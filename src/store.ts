import type { AuthState, CachedWorkspace, Settings } from "./types.js";

/**
 * chrome.storage のラッパー。
 * MV3 のサービスワーカーは30秒の無操作で停止されるため、状態はメモリではなく必ずここに置く。
 */

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
}

export type SortOrder = "recent" | "name";

interface SessionSchema {
  /** ローカル変更があり未アップロードのワークスペース */
  dirty: Record<string, true>;
}

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

export async function getSession<K extends keyof SessionSchema>(key: K): Promise<SessionSchema[K] | undefined> {
  const r = await chrome.storage.session.get(key);
  return r[key] as SessionSchema[K] | undefined;
}

export async function setSession<K extends keyof SessionSchema>(key: K, value: SessionSchema[K]): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function getDeviceId(): Promise<string> {
  let id = await getLocal("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    await setLocal("deviceId", id);
  }
  return id;
}

export async function getWorkspaces(): Promise<Record<string, CachedWorkspace>> {
  return (await getLocal("workspaces")) ?? {};
}

export async function putWorkspace(ws: CachedWorkspace): Promise<void> {
  const all = await getWorkspaces();
  all[ws.doc.id] = ws;
  await setLocal("workspaces", all);
}

export async function deleteWorkspaceCache(wsId: string): Promise<void> {
  const all = await getWorkspaces();
  delete all[wsId];
  await setLocal("workspaces", all);
}

export async function getWindowMap(): Promise<Record<string, string>> {
  return (await getLocal("windowMap")) ?? {};
}

export async function mapWindow(windowId: number, wsId: string): Promise<void> {
  const map = await getWindowMap();
  // 1ワークスペース = 1ウィンドウ。古い対応は消す
  for (const [w, id] of Object.entries(map)) if (id === wsId) delete map[w];
  map[String(windowId)] = wsId;
  await setLocal("windowMap", map);
}

export async function unmapWindow(windowId: number): Promise<void> {
  const map = await getWindowMap();
  delete map[String(windowId)];
  await setLocal("windowMap", map);
}

export async function unmapWorkspace(wsId: string): Promise<void> {
  const map = await getWindowMap();
  for (const [w, id] of Object.entries(map)) if (id === wsId) delete map[w];
  await setLocal("windowMap", map);
}

export async function windowOf(wsId: string): Promise<number | null> {
  const map = await getWindowMap();
  for (const [w, id] of Object.entries(map)) if (id === wsId) return Number(w);
  return null;
}

export async function markDirty(wsId: string): Promise<void> {
  const d = (await getSession("dirty")) ?? {};
  d[wsId] = true;
  await setSession("dirty", d);
}

export async function takeDirty(): Promise<string[]> {
  const d = (await getSession("dirty")) ?? {};
  await setSession("dirty", {});
  return Object.keys(d);
}

export async function clearDirty(wsId: string): Promise<void> {
  const d = (await getSession("dirty")) ?? {};
  delete d[wsId];
  await setSession("dirty", d);
}
