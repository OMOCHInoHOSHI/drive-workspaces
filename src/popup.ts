import { send } from "./messaging.js";
import { getLocal, setLocal, type SortOrder } from "./store.js";
import type { StatusResponse } from "./types.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let currentWindowId = -1;
let sortOrder: SortOrder = "name";

type Item = StatusResponse["workspaces"][number];

function sortWorkspaces(items: Item[]): Item[] {
  const byName = (a: Item, b: Item) => a.name.localeCompare(b.name, "ja");
  return [...items].sort(sortOrder === "recent" ? (a, b) => b.updatedAt - a.updatedAt || byName(a, b) : byName);
}

function fmtTime(ms: number | null): string {
  if (!ms) return "未同期";
  const d = new Date(ms);
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 「自宅PC / Edge / ittama」のような最後に使った場所の表示 */
function placeLabel(w: StatusResponse["workspaces"][number]): string {
  return [w.deviceName, w.browser ?? "ブラウザ不明", w.profileName].filter(Boolean).join(" / ");
}

/**
 * 最後に別のブラウザ・プロファイルで使われていたワークスペースを開くときは確認する。
 * このウィンドウで既に開いている場合（フォーカスするだけ）と、記録の無い古いデータは確認しない。
 */
function confirmIfElsewhere(w: StatusResponse["workspaces"][number], current: StatusResponse["current"]): boolean {
  if (w.openWindowId !== null || w.browser === null) return true;
  const sameBrowser = w.browser === current.browser;
  const sameProfile = (w.profileName ?? "") === current.profileName;
  if (sameBrowser && sameProfile) return true;
  const here = [current.deviceName, current.browser, current.profileName].filter(Boolean).join(" / ");
  return confirm(
    `「${w.name}」は最後に別の場所で使われていました。\n\n` +
      `最後に使った場所: ${placeLabel(w)}\n` +
      `今のブラウザ: ${here}\n\n` +
      `このブラウザで開きますか？`,
  );
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function showError(e: unknown) {
  $("notice").replaceChildren(el("div", { className: "empty error", textContent: e instanceof Error ? e.message : String(e) }));
}

async function act(fn: () => Promise<unknown>) {
  try {
    await fn();
    await render();
  } catch (e) {
    showError(e);
  }
}

type MenuItem = { label: string; danger?: boolean; fn: () => Promise<unknown> };

/** 開いている「⋯」メニュー。同時に開くのは1つだけ */
let openMenu: { menu: HTMLElement; btn: HTMLElement } | null = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.btn.classList.remove("open");
  openMenu.btn.setAttribute("aria-expanded", "false");
  openMenu = null;
}

/**
 * ボタンの下にメニューを出す。リストのスクロール領域で切れないよう body 直下に fixed で置き、
 * 下に収まらなければ上に開く。
 */
function showMenu(btn: HTMLElement, items: MenuItem[]) {
  closeMenu();
  const menu = el("div", { className: "menu" });
  menu.setAttribute("role", "menu");
  for (const it of items) {
    const b = el("button", { textContent: it.label, className: it.danger ? "danger" : "", type: "button" });
    b.setAttribute("role", "menuitem");
    b.onclick = (ev) => {
      ev.stopPropagation();
      closeMenu();
      void act(it.fn);
    };
    menu.append(b);
  }
  menu.onclick = (ev) => ev.stopPropagation();
  document.body.append(menu);

  const r = btn.getBoundingClientRect();
  const { offsetWidth: mw, offsetHeight: mh } = menu;
  const gap = 2;
  const margin = 4;
  let top = r.bottom + gap;
  if (top + mh > window.innerHeight - margin) top = Math.max(margin, r.top - gap - mh);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(margin, r.right - mw)}px`;

  btn.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  openMenu = { menu, btn };
}

document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenu) {
    e.preventDefault();
    const { btn } = openMenu;
    closeMenu();
    btn.focus();
  }
});
$("list").addEventListener("scroll", closeMenu);

async function render() {
  const s = await send<StatusResponse>({ type: "status" });
  closeMenu();
  const notice = $("notice");
  notice.replaceChildren();

  if (!s.configured || !s.signedIn) {
    const btn = el("button", { className: "primary", textContent: "設定を開く" });
    btn.onclick = () => chrome.runtime.openOptionsPage();
    notice.append(
      el("div", { className: "empty" }, s.configured ? "Google にサインインしてください。" : "初回設定が必要です。", " ", btn),
    );
    $("createRow").style.display = "none";
  } else {
    $("createRow").style.display = "";
  }
  if (s.lastError) notice.append(el("div", { className: "empty error", textContent: `同期エラー: ${s.lastError}` }));

  const mine = s.workspaces.find((w) => w.openWindowId === currentWindowId);
  $("current").textContent = mine ? `このウィンドウ: ${mine.name}` : "このウィンドウはワークスペースではありません";
  $("newName").toggleAttribute("disabled", !!mine);
  $("create").toggleAttribute("disabled", !!mine);

  const list = $("list");
  list.replaceChildren();
  if (s.workspaces.length === 0) {
    list.append(el("div", { className: "empty", textContent: "ワークスペースはまだありません。" }));
  }
  for (const w of sortWorkspaces(s.workspaces)) {
    const items: MenuItem[] = [
      {
        label: "名前変更",
        fn: async () => {
          const name = prompt("新しい名前", w.name);
          if (name) await send({ type: "rename", wsId: w.id, name });
        },
      },
    ];
    if (w.openWindowId !== null) items.push({ label: "閉じる", fn: () => send({ type: "close", wsId: w.id }) });
    if (w.openWindowId !== null && w.openWindowId === currentWindowId) {
      items.push({ label: "関連付け解除", fn: () => send({ type: "detach", windowId: currentWindowId }) });
    }
    items.push({
      label: "削除",
      danger: true,
      fn: async () => {
        if (confirm(`「${w.name}」を削除しますか？\n全端末から消えます（開いているウィンドウ自体は閉じません）。`)) {
          await send({ type: "delete", wsId: w.id });
        }
      },
    });

    const more = el("button", { className: "more", textContent: "⋯", title: "操作", type: "button" });
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.onclick = (ev) => {
      ev.stopPropagation();
      if (openMenu?.btn === more) closeMenu();
      else showMenu(more, items);
    };

    const row = el(
      "div",
      { className: "ws", title: "クリックで開く" },
      el(
        "div",
        { className: "meta" },
        el("div", { className: "name", textContent: w.name }),
        el("div", { className: "sub", textContent: `${w.tabCount} 個のタブ · ${fmtTime(w.updatedAt)}` }),
        el("div", { className: "sub place", textContent: `最終: ${placeLabel(w)}` }),
      ),
      ...(w.openWindowId !== null
        ? [
            el(
              "div",
              { className: "tags" },
              el("span", { className: "chip", textContent: "開いています" }),
              ...(w.openWindowId === currentWindowId ? [el("span", { className: "chip here", textContent: "このウィンドウ" })] : []),
            ),
          ]
        : []),
      more,
    );
    row.onclick = () => {
      if (!confirmIfElsewhere(w, s.current)) return;
      void act(() => send({ type: "open", wsId: w.id }));
    };
    list.append(row);
  }

  $("status").textContent = `最終同期: ${fmtTime(s.lastSyncAt)}`;
}

$("create").onclick = () =>
  void act(async () => {
    const name = ($("newName") as HTMLInputElement).value;
    await send({ type: "createFromWindow", windowId: currentWindowId, name });
    ($("newName") as HTMLInputElement).value = "";
  });
$("newName").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter" && !(e as KeyboardEvent).isComposing) $("create").click();
});
$("sync").onclick = () =>
  void act(async () => {
    $("sync").setAttribute("disabled", "");
    try {
      await send({ type: "syncNow" });
    } finally {
      $("sync").removeAttribute("disabled");
    }
  });

$<HTMLSelectElement>("sort").onchange = () =>
  void act(async () => {
    sortOrder = $<HTMLSelectElement>("sort").value === "recent" ? "recent" : "name";
    await setLocal("sortOrder", sortOrder);
  });

void (async () => {
  currentWindowId = (await chrome.windows.getCurrent()).id ?? -1;
  sortOrder = (await getLocal("sortOrder")) ?? "name";
  $<HTMLSelectElement>("sort").value = sortOrder;
  await render().catch(showError);
})();
