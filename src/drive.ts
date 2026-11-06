import { getAccessToken } from "./auth.js";
import type { GroupState, TabState, WorkspaceDoc } from "./types.js";

/**
 * Google Drive API v3（appDataFolder のみ使用。スコープ drive.appdata）。
 * appDataFolder はユーザーの Drive 画面には表示されない、このアプリ専用の隠しフォルダ。
 */

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FILE_PREFIX = "ws-";
const FILE_SUFFIX = ".json";

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
}

/** Drive から取得した JSON は外部データなので、使う前に最低限の構造を検証する */
export function isWorkspaceDoc(v: unknown): v is WorkspaceDoc {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d.schema === 1 &&
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    Array.isArray(d.tabs) &&
    d.tabs.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as TabState).url === "string" &&
        typeof (t as TabState).title === "string" &&
        typeof (t as TabState).pinned === "boolean" &&
        typeof (t as TabState).active === "boolean" &&
        ((t as TabState).group === null || typeof (t as TabState).group === "number"),
    ) &&
    Array.isArray(d.groups) &&
    d.groups.every(
      (g) =>
        typeof g === "object" &&
        g !== null &&
        typeof (g as GroupState).key === "number" &&
        typeof (g as GroupState).title === "string" &&
        typeof (g as GroupState).collapsed === "boolean",
    )
  );
}

export function fileNameFor(wsId: string): string {
  return `${FILE_PREFIX}${wsId}${FILE_SUFFIX}`;
}

export function isWorkspaceFile(name: string): boolean {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX);
}

async function request(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const token = await getAccessToken(retried);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && !retried) return request(url, init, true);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

export async function listFiles(): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API}/files`);
    url.searchParams.set("spaces", "appDataFolder");
    url.searchParams.set("fields", "nextPageToken,files(id,name,modifiedTime)");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const json = (await (await request(url.toString())).json()) as { files: DriveFile[]; nextPageToken?: string };
    files.push(...json.files.filter((f) => isWorkspaceFile(f.name)));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return files;
}

export async function download(fileId: string): Promise<WorkspaceDoc> {
  const res = await request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
  const json: unknown = await res.json();
  if (!isWorkspaceDoc(json)) {
    throw new Error(`ワークスペースデータの形式が不正です（file ${fileId}）。このファイルは無視されます`);
  }
  return json;
}

/** メタデータだけを取得する（送信の直前に、手元が知っている版から更新されていないか確かめる） */
export async function getMeta(fileId: string): Promise<DriveFile> {
  const res = await request(`${API}/files/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime`);
  return (await res.json()) as DriveFile;
}

export async function create(doc: WorkspaceDoc): Promise<DriveFile> {
  const boundary = "dw" + crypto.randomUUID();
  const metadata = { name: fileNameFor(doc.id), parents: ["appDataFolder"], mimeType: "application/json" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(doc)}\r\n--${boundary}--`;
  const res = await request(`${UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await res.json()) as DriveFile;
}

export async function update(fileId: string, doc: WorkspaceDoc): Promise<DriveFile> {
  // v3 は ETag による条件付き更新(If-Match)を公開していないため後勝ちになる
  const res = await request(
    `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) },
  );
  return (await res.json()) as DriveFile;
}

export async function remove(fileId: string): Promise<void> {
  await request(`${API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }).catch((e: Error) => {
    if (!e.message.includes("404")) throw e; // 既に消えていれば良い
  });
}

export async function getStartPageToken(): Promise<string> {
  const json = (await (await request(`${API}/changes/startPageToken`)).json()) as { startPageToken: string };
  return json.startPageToken;
}

export interface Change {
  fileId: string;
  removed: boolean;
  file?: DriveFile & { trashed?: boolean };
}

/** pageToken 以降の appDataFolder 内の変更を取得。戻り値の newToken を次回に使う */
export async function listChanges(pageToken: string): Promise<{ changes: Change[]; newToken: string }> {
  const changes: Change[] = [];
  let token: string | undefined = pageToken;
  let newToken = pageToken;
  while (token) {
    const url = new URL(`${API}/changes`);
    url.searchParams.set("pageToken", token);
    url.searchParams.set("spaces", "appDataFolder");
    url.searchParams.set("includeRemoved", "true");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set(
      "fields",
      "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,modifiedTime,trashed))",
    );
    const json = (await (await request(url.toString())).json()) as {
      changes: Change[];
      nextPageToken?: string;
      newStartPageToken?: string;
    };
    changes.push(...json.changes);
    token = json.nextPageToken;
    if (json.newStartPageToken) newToken = json.newStartPageToken;
  }
  return { changes, newToken };
}
