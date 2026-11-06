import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type BindState, conflictsWithRemote, decideOnBind } from "../src/conflict.js";
import type { OutboxEntry } from "../src/outbox.js";

const entry = (hash: string): OutboxEntry => ({ tabs: [], groups: [], hash, queuedAt: 1 });

describe("conflictsWithRemote", () => {
  it("未送信が無ければ競合しない", () => {
    assert.equal(conflictsWithRemote("remote", "base", undefined), false);
  });

  it("タブが変わっていない更新（名前や時刻だけ）は競合しない", () => {
    assert.equal(conflictsWithRemote("base", "base", entry("local")), false);
  });

  it("両方が同じ内容に変わっていれば競合しない", () => {
    assert.equal(conflictsWithRemote("same", "base", entry("same")), false);
  });

  it("両方が違う内容に変わっていれば競合する", () => {
    assert.equal(conflictsWithRemote("remote", "base", entry("local")), true);
  });
});

describe("decideOnBind", () => {
  const state = (o: Partial<BindState>): BindState => ({
    windowHash: "base",
    tabCount: 2,
    syncedHash: "base",
    baseHash: "base",
    hasPending: false,
    ...o,
  });

  it("ウィンドウと Drive が同じなら、そのまま", () => {
    assert.equal(decideOnBind(state({})), "keep");
    assert.equal(decideOnBind(state({ baseHash: undefined })), "keep");
    assert.equal(decideOnBind(state({ windowHash: "new", syncedHash: "new" })), "keep");
  });

  it("ウィンドウだけが変わっていれば、手元の変更として扱う", () => {
    assert.equal(decideOnBind(state({ windowHash: "local" })), "keep");
    assert.equal(decideOnBind(state({ windowHash: "local", hasPending: true })), "keep");
  });

  it("Drive だけが変わっていれば、Drive の内容を反映する", () => {
    assert.equal(decideOnBind(state({ syncedHash: "remote" })), "apply");
  });

  it("両方が変わっていれば確認する", () => {
    assert.equal(decideOnBind(state({ windowHash: "local", syncedHash: "remote" })), "conflict");
  });

  it("ウィンドウが変わっていなくても、未送信があれば確認する", () => {
    assert.equal(decideOnBind(state({ syncedHash: "remote", hasPending: true })), "conflict");
  });

  it("最後に一致した内容が不明で、内容が違えば確認する", () => {
    assert.equal(decideOnBind(state({ windowHash: "local", baseHash: undefined })), "conflict");
  });

  it("同期対象のタブが無いウィンドウには Drive の内容を反映する", () => {
    assert.equal(decideOnBind(state({ windowHash: "empty", tabCount: 0, baseHash: undefined })), "apply");
  });
});
