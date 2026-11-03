/** Drive に保存する1ワークスペース分のデータ（ws-<id>.json の中身） */
export interface WorkspaceDoc {
  schema: 1;
  id: string;
  name: string;
  /** 最後に書き込んだ端末の時計による時刻（表示用。競合判定には Drive の modifiedTime を使う） */
  updatedAt: number;
  updatedBy: string; // deviceId
  deviceName: string;
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
  | { type: "syncNow" };

export interface StatusResponse {
  signedIn: boolean;
  configured: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  workspaces: {
    id: string;
    name: string;
    tabCount: number;
    updatedAt: number;
    deviceName: string;
    openWindowId: number | null;
  }[];
}

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
