import { AuthRequiredError, isSignedIn } from "./auth.js";
import { debounceWithMaxWait } from "./outbox.js";
import { getLocal, getOutbox, getWindowMap, getWorkspaces, setLocal, unmapWindow } from "./store.js";
import {
  captureToOutbox,
  closeWorkspace,
  createFromWindow,
  deleteWorkspace,
  markClosing,
  onEnqueued,
  openWorkspace,
  rematchWindows,
  renameWorkspace,
  syncAll,
  trackWindowWork,
  whoAmI,
  withLock,
} from "./sync.js";
import type { Request, Response, StatusResponse } from "./types.js";

/**
 * サービスワーカー。イベントリスナーは必ずトップレベルで同期的に登録する
 * （停止→再起動時にイベントを取りこぼさないため）。
 */

const TICK = "tick";
const REMATCH = "rematch";
// 撮影はイベントごとに即時に行うので、送信だけ短くまとめる。操作が続いても最大 MAX_WAIT_MS で送る
const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 2000;
const FOCUS_SYNC_INTERVAL_MS = 3000;

async function ready(): Promise<boolean> {
  return isSignedIn();
}

function runSync(): Promise<void> {
  return withLock(async () => {
    if (!(await ready())) return;
    await syncAll();
  }).catch((e) => {
    if (!(e instanceof AuthRequiredError)) console.warn("[sync]", e);
  });
}

async function ensureAlarm(): Promise<void> {
  // Chrome 120 以降は最短30秒（0.5分）
  const a = await chrome.alarms.get(TICK);
  if (!a) await chrome.alarms.create(TICK, { periodInMinutes: 0.5 });
}

// ---- タブ変更の検知 ----

// outbox に積まれたら送信を予約する。
// サービスワーカーが止まってタイマーが消えても、outbox は storage に残っているので定期アラームで送られる
onEnqueued(debounceWithMaxWait(() => void runSync(), DEBOUNCE_MS, MAX_WAIT_MS));

/**
 * タブイベントを受けたその場で（await の前に）処理中として登録する。
 * リモート適用はこれが終わるのを待つので、適用直前の操作が適用で消されない
 */
function onWindowChanged(windowId: number | undefined): Promise<void> {
  if (windowId === undefined || windowId < 0) return Promise.resolve();
  return trackWindowWork(windowId, handleWindowChanged(windowId));
}

async function handleWindowChanged(windowId: number): Promise<void> {
  const wsId = (await getWindowMap())[String(windowId)];
  if (!wsId) return;
  // ウィンドウが生きているうちに撮影しておく（×で閉じられた後は読めないため）。
  // リモート適用中なら撮影は見送られ、適用ガードの解除後に撮り直される
  await captureToOutbox(windowId, wsId);
}

chrome.tabs.onCreated.addListener((tab) => void onWindowChanged(tab.windowId));
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.url !== undefined || info.pinned !== undefined || info.groupId !== undefined) {
    void onWindowChanged(tab.windowId);
  }
});
chrome.tabs.onRemoved.addListener((_id, info) => {
  // ウィンドウを閉じるときのタブ削除は無視（空の状態を保存してしまうため）
  if (info.isWindowClosing) markClosing(info.windowId);
  else void onWindowChanged(info.windowId);
});
chrome.tabs.onMoved.addListener((_id, info) => void onWindowChanged(info.windowId));
chrome.tabs.onAttached.addListener((_id, info) => void onWindowChanged(info.newWindowId));
chrome.tabs.onDetached.addListener((_id, info) => void onWindowChanged(info.oldWindowId));
chrome.tabGroups.onCreated.addListener((g) => void onWindowChanged(g.windowId));
chrome.tabGroups.onUpdated.addListener((g) => void onWindowChanged(g.windowId));
chrome.tabGroups.onRemoved.addListener((g) => void onWindowChanged(g.windowId));
chrome.tabGroups.onMoved.addListener((g) => void onWindowChanged(g.windowId));

chrome.windows.onRemoved.addListener((windowId) => {
  markClosing(windowId);
  void withLock(() => unmapWindow(windowId));
});

// フォーカスが移ったときに同期する（30秒ポーリングの待ち時間を体感上減らす）。
// 取り込みだけでなく送信も先に行う（未送信の変更を先に Drive へ上げる）
let lastFocusSync = 0;
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (Date.now() - lastFocusSync < FOCUS_SYNC_INTERVAL_MS) return;
  lastFocusSync = Date.now();
  void runSync();
});

// ---- 定期実行・起動 ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK) void runSync();
  if (alarm.name === REMATCH) void withLock(rematchWindows);
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    // windowId はブラウザ再起動で変わるため、古い対応表は捨てて貼り直す
    await setLocal("windowMap", {});
    await ensureAlarm();
    // セッション復元でウィンドウが出そろうのを待つ。念のため30秒後にもう一度
    setTimeout(() => void withLock(rematchWindows), 3000);
    await chrome.alarms.create(REMATCH, { delayInMinutes: 0.5 });
    void runSync();
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
  void runSync();
});

// ---- popup / options からのメッセージ ----

async function status(): Promise<StatusResponse> {
  const [all, map, signedIn, settings, lastSyncAt, lastError, box] = await Promise.all([
    getWorkspaces(),
    getWindowMap(),
    isSignedIn(),
    getLocal("settings"),
    getLocal("lastSyncAt"),
    getLocal("lastError"),
    getOutbox(),
  ]);
  const me = await whoAmI();
  const alive = new Set((await chrome.windows.getAll()).map((w) => w.id));
  const winOf = new Map<string, number>();
  for (const [w, id] of Object.entries(map)) if (alive.has(Number(w))) winOf.set(id, Number(w));
  return {
    signedIn,
    configured: !!settings?.clientId && !!settings?.clientSecret,
    lastSyncAt: lastSyncAt ?? null,
    lastError: lastError ?? null,
    current: { deviceName: me.deviceName, browser: me.browser ?? "", profileName: me.profileName ?? "" },
    // 並び順は表示側（popup）が持つ
    workspaces: Object.values(all).map((w) => ({
      id: w.doc.id,
      name: w.doc.name,
      // 未送信があればそちらが最新のタブ数
      tabCount: (box[w.doc.id]?.tabs ?? w.doc.tabs).length,
      updatedAt: w.doc.updatedAt,
      deviceName: w.doc.deviceName,
      browser: w.doc.browser ?? null,
      profileName: w.doc.profileName || null,
      openWindowId: winOf.get(w.doc.id) ?? null,
    })),
  };
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "status":
      return status();
    case "syncNow":
      return withLock(syncAll);
    case "createFromWindow":
      return withLock(() => createFromWindow(req.windowId, req.name));
    case "open":
      return withLock(() => openWorkspace(req.wsId));
    case "close":
      return withLock(() => closeWorkspace(req.wsId));
    case "rename":
      return withLock(() => renameWorkspace(req.wsId, req.name));
    case "delete":
      return withLock(() => deleteWorkspace(req.wsId));
    case "detach":
      return withLock(() => unmapWindow(req.windowId));
  }
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse: (r: Response) => void) => {
  // externally_connectable 未設定なら同一拡張からのみだが、防衛的に送信元を確認する
  if (sender.id !== undefined ? sender.id !== chrome.runtime.id : sender.url?.startsWith(chrome.runtime.getURL("")) !== true) {
    sendResponse({ ok: false, error: "許可されていない送信元からのメッセージです" });
    return false;
  }
  handle(req)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // 非同期で応答する
});
