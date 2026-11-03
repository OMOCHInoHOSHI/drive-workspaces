import { send } from "./messaging.js";
import type { StatusResponse } from "./types.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let currentWindowId = -1;

function fmtTime(ms: number | null): string {
  if (!ms) return "未同期";
  const d = new Date(ms);
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

async function render() {
  const s = await send<StatusResponse>({ type: "status" });
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
  for (const w of s.workspaces) {
    const actions = el("div", { className: "actions" });
    const mk = (label: string, cls: string, fn: () => Promise<unknown>) => {
      const b = el("button", { textContent: label, className: cls });
      b.onclick = (ev) => {
        ev.stopPropagation();
        void act(fn);
      };
      actions.append(b);
    };
    mk("名前変更", "", async () => {
      const name = prompt("新しい名前", w.name);
      if (name) await send({ type: "rename", wsId: w.id, name });
    });
    if (w.openWindowId !== null) mk("閉じる", "", () => send({ type: "close", wsId: w.id }));
    if (w.openWindowId !== null && w.openWindowId === currentWindowId) {
      mk("関連付け解除", "", () => send({ type: "detach", windowId: currentWindowId }));
    }
    mk("削除", "danger", async () => {
      if (confirm(`「${w.name}」を削除しますか？\n全端末から消えます（開いているウィンドウ自体は閉じません）。`)) {
        await send({ type: "delete", wsId: w.id });
      }
    });

    const row = el(
      "div",
      { className: "ws", title: "クリックで開く" },
      el(
        "div",
        { className: "meta" },
        el("div", { className: "name", textContent: w.name }),
        el("div", { className: "sub", textContent: `${w.tabCount} 個のタブ · ${fmtTime(w.updatedAt)} ${w.deviceName}` }),
      ),
      ...(w.openWindowId !== null ? [el("span", { className: "chip", textContent: "開いています" })] : []),
      actions,
    );
    row.onclick = () => void act(() => send({ type: "open", wsId: w.id }));
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

void (async () => {
  currentWindowId = (await chrome.windows.getCurrent()).id ?? -1;
  await render().catch(showError);
})();
