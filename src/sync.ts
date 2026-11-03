import { detectBrowser } from "./browser.js";
import * as drive from "./drive.js";
import { applyToWindow, capture, hashOf, isSyncable, similarity, urlOf } from "./snapshot.js";
import {
  clearDirty,
  deleteWorkspaceCache,
  getDeviceId,
  getLocal,
  getWindowMap,
  getWorkspaces,
  mapWindow,
  markDirty,
  putWorkspace,
  setLocal,
  takeDirty,
  unmapWindow,
  unmapWorkspace,
  windowOf,
} from "./store.js";
import type { CachedWorkspace, WorkspaceDoc } from "./types.js";

/**
 * 同期の中核。
 * - ローカル → Drive: タブの変更で dirty を立て、デバウンス or 定期アラームでアップロード
 * - Drive → ローカル: changes.list を定期ポーリングし、新しいものだけ取り込んでウィンドウに差分適用
 * - 競合: Drive v3 は条件付き更新ができないので、ワークスペース単位で後勝ち（Drive の modifiedTime 基準）
 */

// ---- 排他制御（同期処理は直列に実行する） ----
let chain: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

/** リモート変更を適用中のウィンドウ。この間のタブイベントは無視する（エコー防止） */
const applying = new Set<number>();
export function isApplying(windowId: number): boolean {
  return applying.has(windowId);
}

async function windowExists(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

/** この端末・ブラウザの識別情報。ワークスペースを書き込むたびに「最後に使った場所」として記録する */
export async function whoAmI(): Promise<Pick<WorkspaceDoc, "updatedBy" | "deviceName" | "browser">> {
  const s = await getLocal("settings");
  return {
    updatedBy: await getDeviceId(),
    deviceName: s?.deviceName || "不明な端末",
    browser: s?.browserName || detectBrowser(),
  };
}

async function applyGuarded(windowId: number, doc: Pick<WorkspaceDoc, "tabs" | "groups">, activate: boolean) {
  applying.add(windowId);
  try {
    await applyToWindow(windowId, doc, activate);
  } finally {
    // 適用で発生したタブイベントが届き切るのを少し待ってから解除
    setTimeout(() => applying.delete(windowId), 1500);
  }
}

// ---- ローカル → Drive ----

async function pushWorkspace(wsId: string): Promise<void> {
  const winId = await windowOf(wsId);
  if (winId === null) return;
  if (!(await windowExists(winId))) {
    await unmapWindow(winId);
    return;
  }
  if (applying.has(winId)) {
    await markDirty(wsId); // 次の機会に再試行
    return;
  }
  const cached = (await getWorkspaces())[wsId];
  if (!cached) return;

  const snap = await capture(winId);
  // 安全装置: ウィンドウを閉じる途中などで空になった状態は書き込まない
  if (snap.tabs.length === 0 && cached.doc.tabs.length > 0) return;
  const h = hashOf(snap);
  if (h === cached.syncedHash) return;

  const doc: WorkspaceDoc = {
    ...cached.doc,
    tabs: snap.tabs,
    groups: snap.groups,
    updatedAt: Date.now(),
    ...(await whoAmI()),
  };
  const f = cached.fileId ? await drive.update(cached.fileId, doc) : await drive.create(doc);
  await putWorkspace({ doc, fileId: f.id, modifiedTime: f.modifiedTime, syncedHash: h });
}

export async function flushDirty(): Promise<void> {
  const ids = await takeDirty();
  for (const id of ids) {
    try {
      await pushWorkspace(id);
    } catch (e) {
      await markDirty(id); // 失敗したら次回に持ち越す
      throw e;
    }
  }
}

// ---- Drive → ローカル ----

async function applyRemote(doc: WorkspaceDoc, file: drive.DriveFile): Promise<void> {
  const all = await getWorkspaces();
  const cached = all[doc.id];
  if (cached && Date.parse(cached.modifiedTime) >= Date.parse(file.modifiedTime)) return; // 手元の方が新しい or 同じ

  const h = hashOf(doc);
  await putWorkspace({ doc, fileId: file.id, modifiedTime: file.modifiedTime, syncedHash: h });

  const winId = await windowOf(doc.id);
  if (winId === null) return;
  if (!(await windowExists(winId))) {
    await unmapWindow(winId);
    return;
  }
  const now = hashOf(await capture(winId));
  if (now !== h) await applyGuarded(winId, doc, false);
  await clearDirty(doc.id);
}

async function handleRemoteDelete(fileId: string): Promise<void> {
  const all = await getWorkspaces();
  const hit = Object.values(all).find((w) => w.fileId === fileId);
  if (!hit) return;
  // ウィンドウは閉じずに関連付けだけ外す（他端末で消しても手元のタブは失わない）
  await unmapWorkspace(hit.doc.id);
  await deleteWorkspaceCache(hit.doc.id);
}

async function fullSync(): Promise<void> {
  // 先にトークンを取ってから一覧を取ることで、一覧取得中の変更も次回の差分で拾える
  const token = await drive.getStartPageToken();
  const files = await drive.listFiles();
  const all = await getWorkspaces();
  const seen = new Set(files.map((f) => f.id));

  for (const f of files) {
    const cached = Object.values(all).find((w) => w.fileId === f.id);
    if (cached && cached.modifiedTime === f.modifiedTime) continue;
    const doc = await drive.download(f.id);
    await applyRemote(doc, f);
  }
  for (const w of Object.values(all)) {
    if (w.fileId && !seen.has(w.fileId)) await handleRemoteDelete(w.fileId);
  }
  await setLocal("pageToken", token);
}

export async function pull(): Promise<void> {
  const token = await getLocal("pageToken");
  if (!token) return fullSync();

  let result: Awaited<ReturnType<typeof drive.listChanges>>;
  try {
    result = await drive.listChanges(token);
  } catch (e) {
    // トークンが無効になった場合などは全件同期に戻す
    if (String(e).includes("400") || String(e).includes("404")) return fullSync();
    throw e;
  }
  for (const c of result.changes) {
    if (c.removed || c.file?.trashed) {
      await handleRemoteDelete(c.fileId);
      continue;
    }
    if (!c.file || !drive.isWorkspaceFile(c.file.name)) continue;
    const cached = Object.values(await getWorkspaces()).find((w) => w.fileId === c.fileId);
    if (cached && cached.modifiedTime === c.file.modifiedTime) continue; // 自分の書き込み
    const doc = await drive.download(c.fileId);
    await applyRemote(doc, c.file);
  }
  await setLocal("pageToken", result.newToken);
}

/** 定期実行: 先に手元の変更を上げてから、リモートを取り込む */
export async function syncAll(): Promise<void> {
  try {
    await flushDirty();
    await pull();
    await setLocal("lastSyncAt", Date.now());
    await setLocal("lastError", null);
    await chrome.action.setBadgeText({ text: "" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setLocal("lastError", msg);
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: "!" });
    throw e;
  }
}

// ---- 操作 ----

export async function createFromWindow(windowId: number, name: string): Promise<string> {
  const map = await getWindowMap();
  if (map[String(windowId)]) throw new Error("このウィンドウは既にワークスペースです");
  const snap = await capture(windowId);
  const doc: WorkspaceDoc = {
    schema: 1,
    id: crypto.randomUUID(),
    name: name.trim() || "無題のワークスペース",
    updatedAt: Date.now(),
    ...(await whoAmI()),
    tabs: snap.tabs,
    groups: snap.groups,
  };
  const f = await drive.create(doc);
  await putWorkspace({ doc, fileId: f.id, modifiedTime: f.modifiedTime, syncedHash: hashOf(doc) });
  await mapWindow(windowId, doc.id);
  return doc.id;
}

export async function openWorkspace(wsId: string): Promise<void> {
  // 開く前に最新を取り込む（失敗しても手元のキャッシュで開く）
  await pull().catch(() => undefined);
  const cached = (await getWorkspaces())[wsId];
  if (!cached) throw new Error("ワークスペースが見つかりません");

  const existing = await windowOf(wsId);
  if (existing !== null && (await windowExists(existing))) {
    await chrome.windows.update(existing, { focused: true });
    return;
  }
  const urls = cached.doc.tabs.map((t) => t.url).filter(isSyncable);
  const win = await chrome.windows.create(urls.length ? { url: urls, focused: true } : { focused: true });
  if (win?.id === undefined) throw new Error("ウィンドウを作成できませんでした");
  await mapWindow(win.id, wsId);
  await applyGuarded(win.id, cached.doc, true);
  await touch(wsId);
}

/** 開いただけ（タブの変更なし）でも「最後に使った場所」を更新する */
async function touch(wsId: string): Promise<void> {
  const cached = (await getWorkspaces())[wsId];
  if (!cached) return;
  const me = await whoAmI();
  const changed = (Object.keys(me) as (keyof typeof me)[]).some((k) => cached.doc[k] !== me[k]);
  if (!changed) return;
  const doc: WorkspaceDoc = { ...cached.doc, ...me, updatedAt: Date.now() };
  const f = await drive.update(cached.fileId, doc);
  await putWorkspace({ ...cached, doc, modifiedTime: f.modifiedTime });
}

export async function closeWorkspace(wsId: string): Promise<void> {
  await pushWorkspace(wsId);
  const winId = await windowOf(wsId);
  await unmapWorkspace(wsId);
  if (winId !== null && (await windowExists(winId))) await chrome.windows.remove(winId);
}

export async function renameWorkspace(wsId: string, name: string): Promise<void> {
  await pushWorkspace(wsId);
  const cached = (await getWorkspaces())[wsId];
  if (!cached) throw new Error("ワークスペースが見つかりません");
  const doc: WorkspaceDoc = {
    ...cached.doc,
    name: name.trim() || cached.doc.name,
    updatedAt: Date.now(),
    ...(await whoAmI()),
  };
  const f = await drive.update(cached.fileId, doc);
  await putWorkspace({ ...cached, doc, modifiedTime: f.modifiedTime });
}

export async function deleteWorkspace(wsId: string): Promise<void> {
  const cached = (await getWorkspaces())[wsId];
  if (cached?.fileId) await drive.remove(cached.fileId);
  await unmapWorkspace(wsId);
  await deleteWorkspaceCache(wsId);
}

/** ブラウザ再起動後、開いているウィンドウとワークスペースをURLの一致度で再対応づけする */
export async function rematchWindows(): Promise<void> {
  const map = await getWindowMap();
  const mappedWs = new Set(Object.values(map));
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const all = Object.values(await getWorkspaces());
  const candidates: { win: number; ws: CachedWorkspace; score: number }[] = [];

  for (const w of windows) {
    if (w.id === undefined || map[String(w.id)] || w.incognito) continue;
    const urls = (w.tabs ?? []).map(urlOf).filter(isSyncable);
    for (const ws of all) {
      if (mappedWs.has(ws.doc.id)) continue;
      const score = similarity(urls, ws.doc.tabs.map((t) => t.url));
      if (score >= 0.5) candidates.push({ win: w.id, ws, score });
    }
  }
  // スコアの高い組から確定（1対1）
  candidates.sort((a, b) => b.score - a.score);
  const usedWin = new Set<number>();
  for (const c of candidates) {
    if (usedWin.has(c.win) || mappedWs.has(c.ws.doc.id)) continue;
    await mapWindow(c.win, c.ws.doc.id);
    usedWin.add(c.win);
    mappedWs.add(c.ws.doc.id);
  }
}
