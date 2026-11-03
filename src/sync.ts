import { detectBrowser } from "./browser.js";
import * as drive from "./drive.js";
import { newAlias, restoreAliases, staleUrlMap } from "./alias.js";
import { needsUpload, type OutboxEntry, shouldEnqueue } from "./outbox.js";
import { applyToWindow, capture, hashOf, isSyncable, similarity, urlOf } from "./snapshot.js";
import {
  commitRestoredAliases,
  deleteWorkspaceCache,
  getAliases,
  getDeviceId,
  getLocal,
  getOutbox,
  getOutboxEntry,
  getStaleAliases,
  getWindowMap,
  getWorkspaces,
  mapWindow,
  putAlias,
  putOutbox,
  putWorkspace,
  removeOutbox,
  removeAliasesOfWorkspace,
  removeOutboxIf,
  setLocal,
  unmapWindow,
  unmapWorkspace,
  windowOf,
} from "./store.js";
import type { CachedWorkspace, WorkspaceDoc } from "./types.js";

/**
 * 同期の中核。
 * - ローカル → Drive: タブの変更時にすぐ状態を撮影して outbox に積み、デバウンス or 定期アラームで outbox から送信
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

/**
 * リモート変更を適用中のウィンドウ（windowId → 重なっているガードの数）。
 * この間は撮影しない（エコー防止・適用途中の状態を送らないため）。撮影依頼はガード解除後に撮り直す
 */
const applying = new Map<number, number>();
function isApplying(windowId: number): boolean {
  return (applying.get(windowId) ?? 0) > 0;
}
/** 適用ガード中に来た撮影依頼（windowId → wsId） */
const recaptureAfterApply = new Map<number, string>();

/**
 * ウィンドウごとの進行中のタブイベント処理・撮影。リモート適用はこれが空になるのを待ってからガードを立てる
 *（ガード直前に始まった撮影が捨てられ、その操作を適用で消してしまうのを防ぐため）
 */
const inFlight = new Map<number, Set<Promise<unknown>>>();

/** タブイベント処理を登録する。イベントを受けたその場で（await の前に）呼ぶこと */
export function trackWindowWork<T>(windowId: number, p: Promise<T>): Promise<T> {
  let set = inFlight.get(windowId);
  if (!set) inFlight.set(windowId, (set = new Set()));
  const s = set;
  s.add(p);
  const done = () => {
    s.delete(p);
    if (s.size === 0 && inFlight.get(windowId) === s) inFlight.delete(windowId);
  };
  p.then(done, done);
  return p;
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
export async function whoAmI(): Promise<Pick<WorkspaceDoc, "updatedBy" | "deviceName" | "browser" | "profileName">> {
  const s = await getLocal("settings");
  return {
    updatedBy: await getDeviceId(),
    deviceName: s?.deviceName || "不明な端末",
    browser: s?.browserName || detectBrowser(),
    profileName: s?.profileName || "",
  };
}

/**
 * 適用ガードを立てて fn を実行する。fn はウィンドウに実際に適用したら true を返す。
 * 適用したときは、それで発生したタブイベントが届き切るのを待つため 1.5 秒後に解除し、適用しなかったときはすぐ解除する
 */
async function withApplyGuard(windowId: number, fn: () => Promise<boolean>): Promise<void> {
  applying.set(windowId, (applying.get(windowId) ?? 0) + 1);
  let applied = true; // 途中で失敗したときは、適用が途中まで進んでいるかもしれないので待つ側に倒す
  try {
    applied = await fn();
  } finally {
    if (applied) setTimeout(() => releaseApplyGuard(windowId), 1500);
    else releaseApplyGuard(windowId);
  }
}

function releaseApplyGuard(windowId: number): void {
  const n = (applying.get(windowId) ?? 1) - 1;
  if (n > 0) {
    applying.set(windowId, n);
    return;
  }
  applying.delete(windowId);
  // ガード中のユーザー操作を取りこぼさないよう撮り直す（適用しただけなら同期済みと同じなので積まれない）
  const wsId = recaptureAfterApply.get(windowId);
  if (wsId !== undefined) {
    recaptureAfterApply.delete(windowId);
    void captureToOutbox(windowId, wsId);
  }
}

const IDLE_WAIT_MAX_MS = 3000;

/**
 * 進行中のタブイベント処理・撮影が終わるのを待ってから、await を挟まずにガードを立てる。
 * 操作が続いて待ちが終わらないと同期全体（withLock）が止まるので、最大 IDLE_WAIT_MAX_MS で打ち切る。
 * 打ち切っても、ガード中の撮影は捨てて解除後に撮り直し、ガード内で未送信を確認するので、上書きは起きない
 *（その場合に失われうるのは、打ち切り時点で撮影途中だった操作だけ）
 */
async function withApplyGuardWhenIdle(windowId: number, fn: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + IDLE_WAIT_MAX_MS;
  for (let set = inFlight.get(windowId); set?.size; set = inFlight.get(windowId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...set]),
      new Promise<void>((r) => (timer = setTimeout(r, remaining))),
    ]);
    clearTimeout(timer);
  }
  return withApplyGuard(windowId, fn);
}

/** 反映で作ったタブに、要求した URL を別名として付ける関数（applyToWindow の onCreated に渡す） */
function aliasRecorder(wsId: string): (tabId: number, url: string, actual: string, loaded: boolean) => Promise<void> {
  return (tabId, url, actual, loaded) => putAlias(tabId, newAlias(wsId, url, actual, Date.now(), loaded));
}

// ---- ローカル → Drive ----

/** 閉じ始めたウィンドウ。撮影中に閉じ始めたら、途中までタブが消えた状態かもしれないので捨てる */
const closing = new Set<number>();
export function markClosing(windowId: number): void {
  if (closing.has(windowId)) return;
  closing.add(windowId);
  // windowId は使い回されないので、閉じ終わった頃に掃除するだけでよい
  setTimeout(() => closing.delete(windowId), 10_000);
}

/** outbox に積んだときの通知先（background が送信のデバウンスを登録する） */
let enqueuedListener: () => void = () => undefined;
export function onEnqueued(cb: () => void): void {
  enqueuedListener = cb;
}

// 撮影はウィンドウごとに直列化し、実行中に来た依頼は「次の1回」にまとめる（最新状態を1回撮れば足りる）
const captureRuns = new Map<number, Promise<void>>();
const captureQueued = new Set<number>();

/** ウィンドウの今の状態を撮影して outbox に積む */
export function captureToOutbox(windowId: number, wsId: string): Promise<void> {
  const prev = captureRuns.get(windowId);
  if (prev && captureQueued.has(windowId)) return prev; // 次の撮影が予約済み。それに相乗りする
  captureQueued.add(windowId);
  const run = (prev ?? Promise.resolve())
    .then(async () => {
      captureQueued.delete(windowId);
      await snapshotNow(windowId, wsId);
    })
    .catch((e) => console.warn("[capture]", e))
    .finally(() => {
      if (captureRuns.get(windowId) === run) captureRuns.delete(windowId);
    });
  captureRuns.set(windowId, run);
  return trackWindowWork(windowId, run);
}

/** 撮影結果を捨てるべきか。適用ガード中なら解除後に撮り直すよう予約する */
function shouldDiscard(windowId: number, wsId: string): boolean {
  if (closing.has(windowId)) return true;
  if (isApplying(windowId)) {
    recaptureAfterApply.set(windowId, wsId);
    return true;
  }
  return false;
}

async function snapshotNow(windowId: number, wsId: string): Promise<void> {
  if (shouldDiscard(windowId, wsId)) return;
  if (!(await windowExists(windowId))) {
    await unmapWindow(windowId); // onRemoved を取りこぼした古い対応を外す
    return;
  }
  const snap = await capture(windowId, await getAliases());
  if (shouldDiscard(windowId, wsId)) return;
  if ((await getWindowMap())[String(windowId)] !== wsId) return; // 撮影中に関連付けが外れた
  const h = hashOf(snap);
  const cached = (await getWorkspaces())[wsId];
  const pending = await getOutboxEntry(wsId);
  if (!shouldEnqueue(h, snap.tabs.length, cached, pending)) return;
  // 最終判定は書き込みと同じ直列化の中で行う（applyRemote の「ガード → 未送信確認」と入れ違わないように）
  const entry: OutboxEntry = { tabs: snap.tabs, groups: snap.groups, hash: h, queuedAt: Date.now() };
  if (await putOutbox(wsId, entry, () => shouldDiscard(windowId, wsId))) enqueuedListener();
}

async function uploadEntry(wsId: string, entry: OutboxEntry): Promise<void> {
  const cached = (await getWorkspaces())[wsId];
  // 削除済み、または同期済みの状態に戻っていれば送らずに破棄
  if (!cached || !needsUpload(entry, cached)) {
    await removeOutboxIf(wsId, entry);
    return;
  }
  const doc: WorkspaceDoc = {
    ...cached.doc,
    tabs: entry.tabs,
    groups: entry.groups,
    updatedAt: Date.now(),
    ...(await whoAmI()),
  };
  const f = cached.fileId ? await drive.update(cached.fileId, doc) : await drive.create(doc);
  await putWorkspace({ doc, fileId: f.id, modifiedTime: f.modifiedTime, syncedHash: entry.hash });
  await removeOutboxIf(wsId, entry);
}

/**
 * outbox を送信する。失敗したものは outbox に残り、次回（デバウンス or 定期アラーム）に再送される。
 * 1件の失敗で他のワークスペースの送信を止めないよう、全件試してから最初のエラーを投げる。
 */
export async function flushOutbox(only?: string): Promise<void> {
  const box = await getOutbox();
  let firstError: unknown;
  for (const [wsId, entry] of Object.entries(box)) {
    if (only !== undefined && wsId !== only) continue;
    try {
      await uploadEntry(wsId, entry);
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError !== undefined) throw firstError;
}

// ---- Drive → ローカル ----

async function applyRemote(doc: WorkspaceDoc, file: drive.DriveFile): Promise<void> {
  const all = await getWorkspaces();
  const cached = all[doc.id];
  if (cached && Date.parse(cached.modifiedTime) >= Date.parse(file.modifiedTime)) return; // 手元の方が新しい or 同じ

  const h = hashOf(doc);

  /** キャッシュを更新する。未送信の手元の変更があっても、名前などはリモートの値を採る（次の送信で手元のタブとともに書き戻す） */
  const store = async () => {
    // 同期済みの状態に戻っただけの未送信は、syncedHash を書き換える前に捨てる
    //（残すと「リモートと違う手元の変更」に化けて、リモートの最新を古い状態で上書きしてしまう）
    const cur = (await getWorkspaces())[doc.id];
    const pending = await getOutboxEntry(doc.id);
    if (pending && cur && !needsUpload(pending, cur)) await removeOutboxIf(doc.id, pending);
    await putWorkspace({ doc, fileId: file.id, modifiedTime: file.modifiedTime, syncedHash: h });
  };

  const winId = await windowOf(doc.id);
  const live = winId !== null && (await windowExists(winId));
  if (winId !== null && !live) await unmapWindow(winId);
  if (winId === null || !live) {
    await store();
    return;
  }
  // 進行中の撮影が outbox に積み終わるのを待ってからガードを立て、ガードの中で未送信を確認する。
  // ガード中の撮影は捨てられて解除後に撮り直されるので、確認と適用の間に古い状態が積まれる入れ違いが起きない
  await withApplyGuardWhenIdle(winId, async () => {
    await store();
    if (await getOutboxEntry(doc.id)) return false; // 未送信の手元の変更があれば、タブは手元を優先する
    const aliases = await getAliases();
    if (hashOf(await capture(winId, aliases)) === h) return false;
    await applyToWindow(winId, doc, false, aliases, aliasRecorder(doc.id));
    return true;
  });
}

async function handleRemoteDelete(fileId: string): Promise<void> {
  const all = await getWorkspaces();
  const hit = Object.values(all).find((w) => w.fileId === fileId);
  if (!hit) return;
  // ウィンドウは閉じずに関連付けだけ外す（他端末で消しても手元のタブは失わない）
  await unmapWorkspace(hit.doc.id);
  await removeAliasesOfWorkspace(hit.doc.id);
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
    try {
      const doc = await drive.download(f.id);
      await applyRemote(doc, f);
    } catch (e) {
      // 形式不正・一時的な取得失敗のファイルは無視して続行（全体の同期を止めない）
      console.warn("[sync] skip file:", f.name, e);
    }
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
    try {
      const doc = await drive.download(c.fileId);
      await applyRemote(doc, c.file);
    } catch (e) {
      console.warn("[sync] skip change:", c.file.name, e);
    }
  }
  await setLocal("pageToken", result.newToken);
}

/** 定期実行: 先に手元の変更を上げてから、リモートを取り込む */
export async function syncAll(): Promise<void> {
  try {
    // 送信に失敗しても取り込みは行う（他端末で削除されたワークスペースへの送信が詰まり続けないように）。
    // 未送信のものは applyRemote で上書きされないので、取り込みを先に行っても手元の変更は失われない
    const flushError = await flushOutbox().then(
      () => undefined,
      (e: unknown) => e ?? new Error("送信に失敗しました"),
    );
    await pull();
    if (flushError !== undefined) await flushOutbox();
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
  // 開く前に未送信を送り、最新を取り込む（失敗しても手元のキャッシュで開く）
  await flushOutbox(wsId).catch(() => undefined);
  await pull().catch(() => undefined);
  const cached = (await getWorkspaces())[wsId];
  if (!cached) throw new Error("ワークスペースが見つかりません");
  // 送れなかった未送信の状態があれば（オフライン等）、そちらで開く
  const pending = await getOutboxEntry(wsId);
  const doc = pending ? { ...cached.doc, tabs: pending.tabs, groups: pending.groups } : cached.doc;

  const existing = await windowOf(wsId);
  if (existing !== null && (await windowExists(existing))) {
    await chrome.windows.update(existing, { focused: true });
    return;
  }
  const urls = doc.tabs.map((t) => t.url).filter(isSyncable);
  const win = await chrome.windows.create(urls.length ? { url: urls, focused: true } : { focused: true });
  const winId = win?.id;
  if (winId === undefined) throw new Error("ウィンドウを作成できませんでした");
  // 適用が終わるまで（＋関連付けの間）のタブイベントを無視するため、ガードを先に立てる
  await withApplyGuard(winId, async () => {
    // 作ったタブに要求した URL を別名として付ける（リダイレクトされても要求した URL で記録・照合する）。
    // windows.create の戻り値に頼らず、タブを取り直す（並びは urls の順。actual は今見えている URL）
    const record = aliasRecorder(wsId);
    const tabs = (await chrome.tabs.query({ windowId: winId })).sort((a, b) => a.index - b.index);
    if (urls.length > 0 && tabs.length === urls.length) {
      // まとめて呼ぶ（取り直した直後に全タブを同期的に「保存待ち」にして、保存前のイベントを取りこぼさない）
      await Promise.all(
        tabs.map((t, i) => (t.id === undefined ? undefined : record(t.id, urls[i]!, urlOf(t), t.status === "complete"))),
      );
    }
    await mapWindow(winId, wsId);
    await applyToWindow(winId, doc, true, await getAliases(), record);
    return true;
  });
  // 未送信があるときは、古いタブのまま Drive に書かないよう touch しない（後の送信で時刻も更新される）
  if (!pending) await touch(wsId);
}

/** 開いただけ（タブの変更なし）でも「最後に使った場所」と時刻を更新する（最近使った順の並び替えに使う） */
async function touch(wsId: string): Promise<void> {
  const cached = (await getWorkspaces())[wsId];
  if (!cached) return;
  const doc: WorkspaceDoc = { ...cached.doc, ...(await whoAmI()), updatedAt: Date.now() };
  const f = await drive.update(cached.fileId, doc);
  await putWorkspace({ ...cached, doc, modifiedTime: f.modifiedTime });
}

/** 開いているウィンドウの今の状態を outbox に積んで、そのワークスペースだけすぐ送る */
async function captureAndFlush(wsId: string): Promise<void> {
  const winId = await windowOf(wsId);
  if (winId !== null && (await windowExists(winId))) await captureToOutbox(winId, wsId);
  await flushOutbox(wsId);
}

export async function closeWorkspace(wsId: string): Promise<void> {
  // 送信に失敗しても outbox に残って後で再送されるので、閉じる操作は止めない
  await captureAndFlush(wsId).catch((e) => console.warn("[close]", e));
  const winId = await windowOf(wsId);
  await unmapWorkspace(wsId);
  await removeAliasesOfWorkspace(wsId);
  if (winId !== null && (await windowExists(winId))) await chrome.windows.remove(winId);
}

export async function renameWorkspace(wsId: string, name: string): Promise<void> {
  await captureAndFlush(wsId);
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
  await removeAliasesOfWorkspace(wsId);
  await deleteWorkspaceCache(wsId);
  // 関連付けとキャッシュを外した後に消す（間に来たタブイベントで積み直されないように）
  await removeOutbox(wsId);
}

/** ブラウザ再起動後、開いているウィンドウとワークスペースをURLの一致度で再対応づけする */
export async function rematchWindows(): Promise<void> {
  const map = await getWindowMap();
  const mappedWs = new Set(Object.values(map));
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const all = Object.values(await getWorkspaces());
  const box = await getOutbox();
  const stale = await getStaleAliases();
  const candidates: { win: number; ws: CachedWorkspace; score: number }[] = [];

  for (const w of windows) {
    if (w.id === undefined || map[String(w.id)] || w.incognito) continue;
    const actualUrls = (w.tabs ?? []).map(urlOf);
    for (const ws of all) {
      if (mappedWs.has(ws.doc.id)) continue;
      // 再起動前にリダイレクトされていたタブは、要求した URL に読み替えて比べる
      const toRequested = staleUrlMap(stale, ws.doc.id);
      const urls = actualUrls.map((u) => toRequested.get(u) ?? u).filter(isSyncable);
      // 未送信があればそちらが最後の状態（送信前に再起動した場合など）
      const tabs = box[ws.doc.id]?.tabs ?? ws.doc.tabs;
      const score = similarity(urls, tabs.map((t) => t.url));
      if (score >= 0.5) candidates.push({ win: w.id, ws, score });
    }
  }
  // スコアの高い組から確定（1対1）
  candidates.sort((a, b) => b.score - a.score);
  const usedWin = new Set<number>();
  let rest = stale;
  for (const c of candidates) {
    if (usedWin.has(c.win) || mappedWs.has(c.ws.doc.id)) continue;
    // 再起動前の別名を、復元されたタブへ付け直す（関連付けより前に付けて、直後の撮影でリダイレクト先を送らないようにする）
    const tabs = (windows.find((w) => w.id === c.win)?.tabs ?? []).flatMap((t) =>
      t.id === undefined ? [] : [{ id: t.id, url: urlOf(t), loaded: t.status === "complete" }],
    );
    const r = restoreAliases(rest, c.ws.doc.id, tabs, Date.now());
    rest = r.rest;
    await commitRestoredAliases(r.restored, rest);
    await mapWindow(c.win, c.ws.doc.id);
    usedWin.add(c.win);
    mappedWs.add(c.ws.doc.id);
  }
}

/** ワークスペースとウィンドウの関連付けを外す（別名も消す。以後は普通のウィンドウとして扱う） */
export async function detachWindow(windowId: number): Promise<void> {
  const wsId = (await getWindowMap())[String(windowId)];
  await unmapWindow(windowId);
  if (wsId) await removeAliasesOfWorkspace(wsId);
}
