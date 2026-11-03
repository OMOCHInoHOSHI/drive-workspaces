import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashOf, isSyncable, similarity, urlOf } from "../src/snapshot.js";
import type { GroupState, TabState } from "../src/types.js";

const tab = (url: string, o: Partial<TabState> = {}): TabState => ({
  url,
  title: "タイトル",
  pinned: false,
  group: null,
  active: false,
  ...o,
});

describe("urlOf", () => {
  it("pendingUrl があれば優先する", () => {
    const t = { pendingUrl: "https://a.example/", url: "about:blank" } as chrome.tabs.Tab;
    assert.equal(urlOf(t), "https://a.example/");
  });

  it("pendingUrl が無ければ url を返す", () => {
    const t = { url: "https://b.example/" } as chrome.tabs.Tab;
    assert.equal(urlOf(t), "https://b.example/");
  });

  it("どちらも無ければ空文字", () => {
    assert.equal(urlOf({} as chrome.tabs.Tab), "");
  });
});

describe("isSyncable", () => {
  it("http/https のみ同期対象", () => {
    assert.equal(isSyncable("https://example.com/"), true);
    assert.equal(isSyncable("http://example.com/"), true);
  });

  it("ブラウザ固有ページ・スクリプト・ローカルファイルは対象外", () => {
    assert.equal(isSyncable("chrome://extensions"), false);
    assert.equal(isSyncable("edge://settings"), false);
    assert.equal(isSyncable("javascript:void(0)"), false);
    assert.equal(isSyncable("data:text/html,hi"), false);
    assert.equal(isSyncable("file:///C:/tmp/x.html"), false);
    assert.equal(isSyncable(""), false);
  });
});

describe("hashOf", () => {
  const snap = (tabs: TabState[], groups: GroupState[] = []) => ({ tabs, groups });

  it("同じ内容なら同じハッシュ", () => {
    const a = snap([tab("https://x/")], []);
    const b = snap([tab("https://x/")], []);
    assert.equal(hashOf(a), hashOf(b));
  });

  it("タイトルの違いは無視する（読み込み中の変化で同期しないため）", () => {
    const a = snap([tab("https://x/", { title: "A" })], []);
    const b = snap([tab("https://x/", { title: "B" })], []);
    assert.equal(hashOf(a), hashOf(b));
  });

  it("アクティブタブの違いは無視する（タブ切り替えで同期しないため）", () => {
    const a = snap([tab("https://x/", { active: true }), tab("https://y/")], []);
    const b = snap([tab("https://x/"), tab("https://y/", { active: true })], []);
    assert.equal(hashOf(a), hashOf(b));
  });

  it("URL・ピン留め・グループ・並び順の違いは検出する", () => {
    const pinned = snap([tab("https://x/", { pinned: true })], []);
    const notPinned = snap([tab("https://x/")], []);
    assert.notEqual(hashOf(pinned), hashOf(notPinned));

    const grouped = snap([tab("https://x/", { group: 0 })], [{ key: 0, title: "g", color: "blue", collapsed: false }]);
    assert.notEqual(hashOf(grouped), hashOf(snap([tab("https://x/")], [])));

    const collapsed = snap(
      [tab("https://x/", { group: 0 })],
      [{ key: 0, title: "g", color: "blue", collapsed: true }],
    );
    assert.notEqual(hashOf(grouped), hashOf(collapsed));

    const reversed = snap([tab("https://x/"), tab("https://y/")], []);
    assert.notEqual(hashOf(reversed), hashOf(snap([tab("https://y/"), tab("https://x/")], [])));
  });
});

describe("similarity", () => {
  it("Jaccard 係数を返す", () => {
    assert.equal(similarity([], []), 0);
    assert.equal(similarity(["a"], ["a"]), 1);
    assert.equal(similarity(["a"], ["b"]), 0);
    assert.equal(similarity(["a"], ["a", "b"]), 0.5);
  });
});
