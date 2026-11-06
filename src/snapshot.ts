import { aliasedUrl, type TabAlias } from "./alias.js";
import { anchorWsId } from "./anchor.js";
import type { GroupState, TabState, WorkspaceDoc } from "./types.js";

/**
 * ウィンドウの状態の取得（capture）と、保存状態のウィンドウへの適用（apply）。
 * 同期対象は http/https のタブのみ。chrome:// や edge:// はブラウザごとに違い、
 * 他ブラウザで開けないため対象外（ローカルにはそのまま残す）。
 * 目印タブはウィンドウごとの印なので、https でも対象外。
 */

const NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

export interface Snapshot {
  tabs: TabState[];
  groups: GroupState[];
}

/** 読み込み中のタブは url が空のことがあるので pendingUrl を優先 */
export function urlOf(tab: chrome.tabs.Tab): string {
  return tab.pendingUrl || tab.url || "";
}

export function isSyncable(url: string): boolean {
  return (url.startsWith("https://") || url.startsWith("http://")) && anchorWsId(url) === null;
}

export async function sortedTabs(windowId: number): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.sort((a, b) => a.index - b.index);
}

/** aliases: 反映で作ったタブの別名。別名があるタブは実際の URL の代わりに要求した URL を記録する */
export async function capture(windowId: number, aliases: Record<string, TabAlias> = {}): Promise<Snapshot> {
  const [tabs, groupList] = await Promise.all([sortedTabs(windowId), chrome.tabGroups.query({ windowId })]);
  const groupInfo = new Map(groupList.map((g) => [g.id, g]));
  const keyOf = new Map<number, number>();
  const groups: GroupState[] = [];
  const out: TabState[] = [];

  for (const t of tabs) {
    const url = aliasedUrl(t.id, urlOf(t), aliases);
    if (!isSyncable(url)) continue;
    let group: number | null = null;
    if (t.groupId !== NONE && !t.pinned) {
      let key = keyOf.get(t.groupId);
      if (key === undefined) {
        key = groups.length;
        keyOf.set(t.groupId, key);
        const g = groupInfo.get(t.groupId);
        groups.push({ key, title: g?.title ?? "", color: g?.color ?? "grey", collapsed: g?.collapsed ?? false });
      }
      group = key;
    }
    out.push({ url, title: t.title ?? "", pinned: !!t.pinned, group, active: !!t.active });
  }
  return { tabs: out, groups };
}

/**
 * 同期判定用のハッシュ。タイトル（読み込みで変わる）とアクティブタブ（切り替えのたびに変わる）は含めない。
 * これを含めると、タブを切り替えるだけで他端末のウィンドウが操作されてしまう。
 */
export function hashOf(s: Pick<WorkspaceDoc, "tabs" | "groups">): string {
  const norm = JSON.stringify([
    s.tabs.map((t) => [t.url, t.pinned, t.group]),
    s.groups.map((g) => [g.key, g.title, g.color, g.collapsed]),
  ]);
  // cyrb53（暗号用途ではない。変化検出だけが目的）
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < norm.length; i++) {
    const ch = norm.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ":" + s.tabs.length;
}

/**
 * 保存状態をウィンドウに差分適用する。
 * 全部閉じて開き直すと作業中のタブ（入力中のフォーム等）が消えるため、URLが一致するタブは再利用する。
 */
export async function applyToWindow(
  windowId: number,
  doc: Pick<WorkspaceDoc, "tabs" | "groups">,
  activate: boolean,
  aliases: Record<string, TabAlias> = {},
  /** タブを作るたびに、すぐ呼ぶ（途中で失敗しても、作ったタブには別名が付くように） */
  onCreated?: (tabId: number, url: string, actual: string, loaded: boolean) => Promise<void>,
): Promise<void> {
  const desired = doc.tabs.filter((t) => isSyncable(t.url));
  const current = await sortedTabs(windowId);
  // 照合も別名で行う（リダイレクトされたタブを「URL 不一致」として作り直さないため）
  const keyOf = (t: chrome.tabs.Tab) => aliasedUrl(t.id, urlOf(t), aliases);
  const pool = current.filter((t) => t.id !== undefined && isSyncable(keyOf(t)));

  // 1. URL一致で既存タブを割り当て、足りない分は作成
  // 同一 URL が複数あるときはピン留め状態も一致しているタブを優先する
  //（URL先頭からの割り当てだとピン留め↔通常の付け替え・移動が発生するため）
  const used = new Set<number>();
  const ids: number[] = [];
  for (const d of desired) {
    const urlMatch = (t: chrome.tabs.Tab) => !used.has(t.id!) && keyOf(t) === d.url;
    const m = pool.find((t) => urlMatch(t) && !!t.pinned === d.pinned) ?? pool.find(urlMatch);
    if (m) {
      used.add(m.id!);
      ids.push(m.id!);
    } else {
      const t = await chrome.tabs.create({ windowId, url: d.url, active: false, pinned: d.pinned });
      used.add(t.id!);
      ids.push(t.id!);
      await onCreated?.(t.id!, d.url, urlOf(t), t.status === "complete");
    }
  }

  // 2. 不要なタブを削除（最後のタブを消すとウィンドウごと閉じるので、空になるなら新しいタブを残す）。
  // 目印タブは数えない（目印だけになると、目印を操作対象のタブとして表示してしまうため）
  const extras = pool.filter((t) => !used.has(t.id!)).map((t) => t.id!);
  const nonSyncableCount = current.filter((t) => !pool.includes(t) && anchorWsId(urlOf(t)) === null).length;
  if (ids.length === 0 && nonSyncableCount === 0) await chrome.tabs.create({ windowId, active: true });
  if (extras.length) await chrome.tabs.remove(extras);

  // 3. グループ構成・並び順が違えば、いったんグループを外して並べ直してから再グループ化
  const after = new Map((await sortedTabs(windowId)).map((t) => [t.id!, t]));
  const currentGroups = new Map<number, number[]>();
  ids.forEach((id) => {
    const g = after.get(id)?.groupId ?? NONE;
    if (g !== NONE) currentGroups.set(g, [...(currentGroups.get(g) ?? []), id]);
  });
  const desiredGroups = new Map<number, number[]>();
  desired.forEach((d, i) => {
    if (d.group !== null && !d.pinned) desiredGroups.set(d.group, [...(desiredGroups.get(d.group) ?? []), ids[i]!]);
  });
  const curSig = [...currentGroups.values()].map((v) => v.join(",")).sort().join("|");
  const desSig = [...desiredGroups.values()].map((v) => v.join(",")).sort().join("|");
  const orderNow = [...after.values()].filter((t) => used.has(t.id!)).map((t) => t.id!);
  const orderChanged = orderNow.join(",") !== ids.join(",");

  // ピン留め
  for (let i = 0; i < desired.length; i++) {
    const t = after.get(ids[i]!);
    if (t && !!t.pinned !== desired[i]!.pinned) await chrome.tabs.update(ids[i]!, { pinned: desired[i]!.pinned });
  }

  if (curSig !== desSig || orderChanged) {
    const grouped = ids.filter((id) => (after.get(id)?.groupId ?? NONE) !== NONE);
    if (grouped.length) await chrome.tabs.ungroup(grouped);

    const pinnedIds = ids.filter((_, i) => desired[i]!.pinned);
    const unpinnedIds = ids.filter((_, i) => !desired[i]!.pinned);
    if (pinnedIds.length) await chrome.tabs.move(pinnedIds, { index: 0 });
    if (unpinnedIds.length) {
      const pinnedTotal = (await chrome.tabs.query({ windowId, pinned: true })).length;
      await chrome.tabs.move(unpinnedIds, { index: pinnedTotal });
    }

    for (const g of doc.groups) {
      const tabIds = desiredGroups.get(g.key);
      if (!tabIds?.length) continue;
      const gid = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], createProperties: { windowId } });
      await chrome.tabGroups.update(gid, { title: g.title, color: g.color, collapsed: g.collapsed });
    }
  } else {
    // 構成は同じ。タイトル・色・折りたたみだけ合わせる
    for (const g of doc.groups) {
      const first = desiredGroups.get(g.key)?.[0];
      const gid = first !== undefined ? after.get(first)?.groupId : undefined;
      if (gid !== undefined && gid !== NONE) {
        await chrome.tabGroups.update(gid, { title: g.title, color: g.color, collapsed: g.collapsed });
      }
    }
  }

  if (activate) {
    const i = desired.findIndex((t) => t.active);
    const id = ids[i >= 0 ? i : 0];
    if (id !== undefined) await chrome.tabs.update(id, { active: true });
  }
}

/** ブラウザ再起動後にウィンドウとワークスペースを再対応づけするための類似度（Jaccard） */
export function similarity(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
