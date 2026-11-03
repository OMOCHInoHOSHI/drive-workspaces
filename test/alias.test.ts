import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aliasedUrl,
  newAlias,
  nextAlias,
  pruneAliases,
  REDIRECT_WINDOW_MS,
  restoreAliases,
  staleUrlMap,
  type TabAlias,
} from "../src/alias.js";

const REQ = "https://site.example/app/123";
const LOGIN = "https://site.example/login?continue=app";
// 既定は「読み込み完了済み」。未完了の挙動は loaded: false で個別に確かめる
const alias = (o: Partial<TabAlias> = {}): TabAlias => ({
  wsId: "ws",
  url: REQ,
  actual: REQ,
  settledAt: 0,
  loaded: true,
  ...o,
});
const LATER = REDIRECT_WINDOW_MS;

describe("nextAlias", () => {
  it("読み込み直後の URL 変化はリダイレクトとみなして別名を保つ（アクティブでも）", () => {
    const a = nextAlias(alias(), { url: LOGIN }, true, LATER - 1);
    assert.deepEqual(a, alias({ actual: LOGIN, settledAt: LATER - 1 }));
  });

  it("背面のタブの URL 変化は、時間がたっていてもリダイレクトとみなす", () => {
    const a = nextAlias(alias(), { url: LOGIN }, false, 60_000);
    assert.equal(a?.url, REQ);
    assert.equal(a?.actual, LOGIN);
  });

  it("アクティブなタブで、落ち着いてから URL が変わったらユーザー自身の移動として外す", () => {
    assert.equal(nextAlias(alias(), { url: "https://site.example/other" }, true, LATER), null);
  });

  it("要求した URL に戻ったら外す", () => {
    assert.equal(nextAlias(alias({ actual: LOGIN }), { url: REQ }, false, 1), null);
  });

  it("読み込み完了で落ち着いた時刻を更新し、直後のスクリプトによるリダイレクトも保つ", () => {
    const done = nextAlias(alias({ actual: LOGIN, loaded: false }), { status: "complete" }, true, 10_000)!;
    assert.equal(done.settledAt, 10_000);
    assert.equal(done.loaded, true);
    const a = nextAlias(done, { url: "https://site.example/login/step2" }, true, 10_000 + LATER - 1);
    assert.equal(a?.url, REQ);
  });

  it("一度も読み込みが完了していなければ、時間がたっていても外さない（初回の読み込みが遅いサイトのリダイレクト）", () => {
    const a = nextAlias(alias({ loaded: false }), { url: LOGIN }, true, 5_000);
    assert.equal(a?.url, REQ);
    assert.equal(a?.actual, LOGIN);
  });

  it("読み込み完了前でも、要求した URL に戻ったら外す", () => {
    assert.equal(nextAlias(alias({ actual: LOGIN, loaded: false }), { url: REQ }, true, 5_000), null);
  });

  it("読み込み開始だけ（再読み込み・破棄されたタブの読み込み）では外さない", () => {
    const a = alias({ actual: LOGIN });
    assert.equal(nextAlias(a, { status: "loading" }, true, 60_000), a);
  });

  it("URL が実際の URL と同じなら変化とみなさない", () => {
    const a = alias({ actual: LOGIN });
    assert.equal(nextAlias(a, { url: LOGIN }, true, 60_000), a);
  });
});

describe("aliasedUrl", () => {
  it("別名があれば要求した URL、なければ実際の URL", () => {
    const aliases = { "5": alias({ actual: LOGIN }) };
    assert.equal(aliasedUrl(5, LOGIN, aliases), REQ);
    assert.equal(aliasedUrl(6, LOGIN, aliases), LOGIN);
    assert.equal(aliasedUrl(undefined, LOGIN, aliases), LOGIN);
  });
});

describe("staleUrlMap / restoreAliases", () => {
  const stale = [
    alias({ actual: LOGIN }),
    alias({ wsId: "other", url: "https://b.example/", actual: "https://b.example/login" }),
  ];

  it("そのワークスペースの実際の URL → 要求した URL の対応を作る", () => {
    const m = staleUrlMap(stale, "ws");
    assert.equal(m.get(LOGIN), REQ);
    assert.equal(m.size, 1);
  });

  it("実際の URL が一致するタブへ付け直し、使わなかった別名は残す", () => {
    const { restored, rest } = restoreAliases(stale, "ws", [{ id: 10, url: LOGIN, loaded: true }], 99);
    assert.deepEqual(restored, { "10": alias({ actual: LOGIN, settledAt: 99, loaded: true }) });
    assert.deepEqual(rest, [stale[1]]);
  });

  it("未読み込みの復元タブには、読み込み完了を待つ別名を付ける", () => {
    const { restored } = restoreAliases(stale, "ws", [{ id: 10, url: LOGIN, loaded: false }], 99);
    assert.equal(restored["10"]?.loaded, false);
  });

  it("同じ URL のタブが複数あっても、別名1件につき1タブだけに付ける", () => {
    const { restored } = restoreAliases([stale[0]!], "ws", [
      { id: 1, url: LOGIN, loaded: true },
      { id: 2, url: LOGIN, loaded: true },
    ], 0);
    assert.deepEqual(Object.keys(restored), ["1"]);
  });

  it("別のワークスペースの別名は付けない", () => {
    const { restored, rest } = restoreAliases(stale, "ws", [{ id: 1, url: "https://b.example/login", loaded: true }], 0);
    assert.deepEqual(restored, {});
    assert.equal(rest.length, 2);
  });
});

describe("newAlias / pruneAliases", () => {
  it("新しい別名は未読み込みで、actual が空なら要求した URL で埋める", () => {
    assert.deepEqual(newAlias("ws", REQ, "", 5), { wsId: "ws", url: REQ, actual: REQ, settledAt: 5, loaded: false });
    assert.equal(newAlias("ws", REQ, LOGIN, 5).actual, LOGIN);
    assert.equal(newAlias("ws", REQ, LOGIN, 5, true).loaded, true);
  });

  it("存在しないタブの別名を除く", () => {
    const all = { "1": alias(), "2": alias() };
    assert.deepEqual(Object.keys(pruneAliases(all, new Set([2, 3]))), ["2"]);
  });
});
