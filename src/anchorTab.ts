import { anchorUrl, anchorWsId } from "./anchor.js";
import { sortedTabs, urlOf } from "./snapshot.js";
import { getAnchorGroups, setAnchorGroup } from "./store.js";

/**
 * 目印タブの操作。ウィンドウの先頭に、ワークスペース名のタブグループへ入れた目印タブを1枚置く。
 * グループを折りたたむことで、タブの幅を取らずにワークスペース名だけをタブバーに出す。
 *
 * ピン留めはしない（ピン留めタブはグループに入れられず、正常終了後の再起動で1つのウィンドウに集められるため）。
 * そのためピン留めタブがあるウィンドウでは、その直後が先頭になる。
 */

const COLOR = "blue";

async function anchorTabs(windowId: number): Promise<chrome.tabs.Tab[]> {
  return (await sortedTabs(windowId)).filter((t) => anchorWsId(urlOf(t)) !== null);
}

/**
 * 目印が正しい状態になるよう直す。正しければ何も変更しないので、タブイベントのたびに呼んでよい。
 * 同時に実行すると目印が重複するので、呼び出し側で直列化すること（withLock の中で呼ぶ）
 */
export async function ensureAnchor(windowId: number, wsId: string, name: string): Promise<void> {
  const tabs = await sortedTabs(windowId);
  const anchors = tabs.filter((t) => anchorWsId(urlOf(t)) !== null);
  const found = anchors.find((t) => anchorWsId(urlOf(t)) === wsId);
  // タブの複製や他のウィンドウからの移動で紛れ込んだ目印は閉じる
  const strays = anchors.filter((t) => t !== found).map((t) => t.id!);
  if (strays.length) await chrome.tabs.remove(strays);

  let anchor =
    found ??
    (await chrome.tabs.create({ windowId, url: anchorUrl(wsId), active: false, index: tabs.filter((t) => t.pinned).length }));
  if (anchor.pinned) anchor = (await chrome.tabs.update(anchor.id!, { pinned: false })) ?? anchor;

  // ユーザーが作った同じ名前のグループを壊さないよう、前回使ったグループを覚えて見分ける
  // （再起動後は覚えていないので、目印が入っているグループを名前で確かめる）
  const groups = await chrome.tabGroups.query({ windowId });
  const known = (await getAnchorGroups())[wsId];
  const current = groups.find((g) => g.id === anchor.groupId);
  const own = current && (current.id === known || current.title === name) ? current : groups.find((g) => g.id === known);

  const groupId =
    own && own.id === anchor.groupId
      ? own.id
      : await chrome.tabs.group(
          own ? { tabIds: anchor.id!, groupId: own.id } : { tabIds: anchor.id!, createProperties: { windowId } },
        );

  // 目印で検索したタブや、ユーザーが入れたタブはグループの外へ出す
  const others = (await sortedTabs(windowId)).filter((t) => t.groupId === groupId && t.id !== anchor.id).map((t) => t.id!);
  if (others.length) await chrome.tabs.ungroup(others as [number, ...number[]]);

  const props: chrome.tabGroups.UpdateProperties = {};
  if (!own) props.color = COLOR;
  if (own?.title !== name) props.title = name;
  // 作り直したときだけ畳む（ユーザーが開いたグループは閉じない）。表示中のタブを含むグループは畳まない
  if ((!own || !found) && !anchor.active) props.collapsed = true;
  if (Object.keys(props).length) await chrome.tabGroups.update(groupId, props);

  const after = await sortedTabs(windowId);
  const pinned = after.filter((t) => t.pinned).length;
  if (after[pinned]?.groupId !== groupId) await chrome.tabGroups.move(groupId, { index: pinned });
  if (known !== groupId) await setAnchorGroup(wsId, groupId);
}

/** 目印を消して普通のウィンドウに戻す */
export async function removeAnchors(windowId: number): Promise<void> {
  const ids = (await anchorTabs(windowId)).map((t) => t.id!);
  if (ids.length) await chrome.tabs.remove(ids);
}

/** 目印のグループを解除してから閉じる（グループごと閉じると、ブラウザの保存済みタブグループに記録が残るため） */
export async function closeWindowWithAnchor(windowId: number): Promise<void> {
  const ids = (await anchorTabs(windowId)).map((t) => t.id!);
  if (ids.length) await chrome.tabs.ungroup(ids as [number, ...number[]]).catch((e) => console.warn("[anchor]", e));
  await chrome.windows.remove(windowId);
}
