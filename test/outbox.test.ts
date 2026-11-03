import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { debounceWithMaxWait, needsUpload, type OutboxEntry, sameEntry, shouldEnqueue } from "../src/outbox.js";
import type { CachedWorkspace, TabState } from "../src/types.js";

const tab = (url: string): TabState => ({ url, title: "", pinned: false, group: null, active: false });

const cached = (syncedHash: string, tabCount = 1): CachedWorkspace => ({
  doc: {
    schema: 1,
    id: "ws",
    name: "テスト",
    updatedAt: 0,
    updatedBy: "device",
    deviceName: "PC",
    tabs: Array.from({ length: tabCount }, (_, i) => tab(`https://example.com/${i}`)),
    groups: [],
  },
  fileId: "file",
  modifiedTime: "2026-01-01T00:00:00.000Z",
  syncedHash,
});

const entry = (hash: string, queuedAt = 1): OutboxEntry => ({ tabs: [tab("https://a.example/")], groups: [], hash, queuedAt });

describe("sameEntry", () => {
  it("hash と queuedAt が両方一致したときだけ同じとみなす", () => {
    assert.equal(sameEntry(entry("h", 1), entry("h", 1)), true);
    assert.equal(sameEntry(entry("h", 2), entry("h", 1)), false);
    assert.equal(sameEntry(entry("x", 1), entry("h", 1)), false);
    assert.equal(sameEntry(undefined, entry("h", 1)), false);
  });
});

describe("shouldEnqueue", () => {
  it("同期済みと違う状態なら積む", () => {
    assert.equal(shouldEnqueue("new", 1, cached("old"), undefined), true);
  });

  it("同期済みと同じで未送信も無ければ積まない", () => {
    assert.equal(shouldEnqueue("same", 1, cached("same"), undefined), false);
  });

  it("キャッシュに無いワークスペースは積まない", () => {
    assert.equal(shouldEnqueue("new", 1, undefined, undefined), false);
  });

  it("タブがあったのに空になった状態は積まない（閉じる途中の安全装置）", () => {
    assert.equal(shouldEnqueue("empty", 0, cached("old", 3), undefined), false);
    assert.equal(shouldEnqueue("empty", 0, cached("old", 3), entry("pending")), false);
  });

  it("もともと空のワークスペースなら空の状態も積める", () => {
    assert.equal(shouldEnqueue("empty", 0, cached("old", 0), undefined), true);
  });

  it("未送信があるときは、その状態から変わっていれば積む", () => {
    assert.equal(shouldEnqueue("b", 1, cached("synced"), entry("a")), true);
    assert.equal(shouldEnqueue("a", 1, cached("synced"), entry("a")), false);
  });

  it("未送信があるときは、同期済みの状態に戻った場合も積む（送信時に破棄させる）", () => {
    assert.equal(shouldEnqueue("synced", 1, cached("synced"), entry("a")), true);
  });
});

describe("needsUpload", () => {
  it("同期済みと違うときだけ送る", () => {
    assert.equal(needsUpload(entry("a"), cached("synced")), true);
    assert.equal(needsUpload(entry("synced"), cached("synced")), false);
  });
});

describe("debounceWithMaxWait", () => {
  it("最後の呼び出しから wait 後に1回だけ実行する", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    const fn = mock.fn();
    const call = debounceWithMaxWait(fn, 500, 2000, () => now);
    call();
    now = 300;
    t.mock.timers.tick(300);
    call();
    now = 700;
    t.mock.timers.tick(400);
    assert.equal(fn.mock.callCount(), 0);
    now = 800;
    t.mock.timers.tick(100);
    assert.equal(fn.mock.callCount(), 1);
  });

  it("呼び出しが続いても最初の呼び出しから maxWait で実行する", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    const fn = mock.fn();
    const call = debounceWithMaxWait(fn, 500, 2000, () => now);
    // 0, 300, ..., 1800ms に呼び出し（wait より短い間隔なので末尾デバウンスだけでは実行されない）
    for (let i = 0; i <= 6; i++) {
      call();
      now += 300;
      t.mock.timers.tick(300);
      if (now < 2000) assert.equal(fn.mock.callCount(), 0, `${now}ms 時点では未実行`);
    }
    // 2000ms を過ぎた時点（2100ms）で1回だけ実行済み
    assert.equal(fn.mock.callCount(), 1);
  });

  it("タイマーが遅れて maxWait を過ぎていたら、次の呼び出しで即時に実行する", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    const fn = mock.fn();
    const call = debounceWithMaxWait(fn, 500, 2000, () => now);
    call();
    now = 2500; // タイマーを進めずに時刻だけ進める（イベントループの遅延を模擬）
    call();
    assert.equal(fn.mock.callCount(), 1);
    t.mock.timers.tick(1000);
    assert.equal(fn.mock.callCount(), 1, "予約済みのタイマーは取り消されている");
  });

  it("実行後は最初からやり直す", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    const fn = mock.fn();
    const call = debounceWithMaxWait(fn, 500, 2000, () => now);
    call();
    now = 500;
    t.mock.timers.tick(500);
    assert.equal(fn.mock.callCount(), 1);
    now = 10_000;
    call();
    now = 10_400;
    t.mock.timers.tick(400);
    assert.equal(fn.mock.callCount(), 1);
    now = 10_500;
    t.mock.timers.tick(100);
    assert.equal(fn.mock.callCount(), 2);
  });
});
