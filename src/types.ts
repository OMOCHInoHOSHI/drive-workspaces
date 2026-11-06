/** Drive に保存する1ワークスペース分のデータ（ws-<id>.json の中身） */
export interface WorkspaceDoc {
  schema: 1;
  id: string;
  name: string;
  /** 最後に書き込んだ端末の時計による時刻（表示用。競合判定には Drive の modifiedTime を使う） */
  updatedAt: number;
  updatedBy: string; // deviceId
  deviceName: string;
  /** 最後に使ったブラウザ（"Edge" "Chrome" など）。この項目の追加前に作られたデータには無い */
  browser?: string;
  /** 最後に使ったブラウザのプロファイル名（設定画面で手入力したもの） */
  profileName?: string;
  tabs: TabState[];
  groups: GroupState[];
}

export interface TabState {
  url: string;
  title: string;
  pinned: boolean;
  /** GroupState.key。グループに属さなければ null */
  group: number | null;
  active: boolean;
}

export interface GroupState {
  /** ワークスペース内でのみ有効な連番（ブラウザの groupId は端末ごとに違うため使わない） */
  key: number;
  title: string;
  color: chrome.tabGroups.ColorEnum;
  collapsed: boolean;
}

/** ローカルにキャッシュするワークスペース情報 */
export interface CachedWorkspace {
  doc: WorkspaceDoc;
  fileId: string;
  /** Drive が返した modifiedTime（サーバー時刻）。これで新旧を判定する */
  modifiedTime: string;
  /** 最後に同期した内容のハッシュ（エコー防止・無駄なアップロード防止） */
  syncedHash: string;
}

export interface Settings {
  clientId: string;
  clientSecret: string;
  deviceName: string;
  /** ブラウザ名の手動指定。空なら自動判定 */
  browserName?: string;
  /** ブラウザのプロファイル名（例: ittama、ユーザー1）。拡張機能からは取得できないため手入力 */
  profileName?: string;
}

export interface AuthState {
  refreshToken: string;
  accessToken: string;
  expiresAt: number; // epoch ms
}

/** popup / options → background のメッセージ */
export type Request =
  | { type: "status" }
  | { type: "createFromWindow"; windowId: number; name: string }
  | { type: "open"; wsId: string }
  | { type: "close"; wsId: string }
  | { type: "rename"; wsId: string; name: string }
  | { type: "delete"; wsId: string }
  | { type: "detach"; windowId: number }
  | { type: "link"; windowId: number; wsId: string }
  | { type: "resolveConflict"; wsId: string; keep: "remote" | "local" }
  | { type: "syncNow" };

export interface StatusResponse {
  signedIn: boolean;
  configured: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  /** このブラウザ・プロファイル自身の情報（別の場所で使っていたワークスペースを開くときの確認に使う） */
  current: { deviceName: string; browser: string; profileName: string };
  workspaces: {
    id: string;
    name: string;
    tabCount: number;
    updatedAt: number;
    deviceName: string;
    browser: string | null;
    profileName: string | null;
    openWindowId: number | null;
    /** 手元と Drive の内容が違い、どちらを残すか確認待ち */
    conflict: boolean;
  }[];
}

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
