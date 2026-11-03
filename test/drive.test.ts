import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fileNameFor, isWorkspaceDoc, isWorkspaceFile } from "../src/drive.js";
import type { WorkspaceDoc } from "../src/types.js";

const validDoc = (): WorkspaceDoc => ({
  schema: 1,
  id: "11111111-2222-3333-4444-555555555555",
  name: "テスト",
  updatedAt: 0,
  updatedBy: "device",
  deviceName: "PC",
  tabs: [{ url: "https://example.com/", title: "例", pinned: false, group: null, active: true }],
  groups: [],
});

describe("fileNameFor / isWorkspaceFile", () => {
  it("ws-<id>.json を作る", () => {
    assert.equal(fileNameFor("abc"), "ws-abc.json");
  });

  it("ワークスペースのファイル名だけ判定する", () => {
    assert.equal(isWorkspaceFile("ws-abc.json"), true);
    assert.equal(isWorkspaceFile("ws-.json"), true);
    assert.equal(isWorkspaceFile("other.json"), false);
    assert.equal(isWorkspaceFile("ws-abc.txt"), false);
    assert.equal(isWorkspaceFile("abc.json"), false);
    assert.equal(isWorkspaceFile(""), false);
  });
});

describe("isWorkspaceDoc", () => {
  it("正常なデータを受け入れる", () => {
    assert.equal(isWorkspaceDoc(validDoc()), true);
  });

  it("オブジェクト以外・null・undefined を拒否する", () => {
    assert.equal(isWorkspaceDoc(null), false);
    assert.equal(isWorkspaceDoc(undefined), false);
    assert.equal(isWorkspaceDoc("str"), false);
    assert.equal(isWorkspaceDoc(42), false);
  });

  it("スキーマ番号・必須文字列を検証する", () => {
    assert.equal(isWorkspaceDoc({ ...validDoc(), schema: 2 }), false);
    assert.equal(isWorkspaceDoc({ ...validDoc(), id: 123 }), false);
    assert.equal(isWorkspaceDoc({ ...validDoc(), name: null }), false);
  });

  it("tabs の要素を検証する", () => {
    assert.equal(isWorkspaceDoc({ ...validDoc(), tabs: "x" }), false);
    assert.equal(isWorkspaceDoc({ ...validDoc(), tabs: [null] }), false);
    assert.equal(isWorkspaceDoc({ ...validDoc(), tabs: [{ url: "https://x/" }] }), false);
    assert.equal(
      isWorkspaceDoc({ ...validDoc(), tabs: [{ url: "https://x/", title: "t", pinned: false, group: "0", active: false }] }),
      false,
    );
    assert.equal(
      isWorkspaceDoc({ ...validDoc(), tabs: [{ url: "https://x/", title: "t", pinned: false, group: 0, active: false }] }),
      true,
    );
  });

  it("groups の要素を検証する", () => {
    assert.equal(isWorkspaceDoc({ ...validDoc(), groups: [1] }), false);
    assert.equal(isWorkspaceDoc({ ...validDoc(), groups: [{ title: "g" }] }), false);
    assert.equal(
      isWorkspaceDoc({ ...validDoc(), groups: [{ key: 0, title: "g", color: "blue", collapsed: false }] }),
      true,
    );
  });

  it("未知のプロパティがあっても受け入れる（前方互換）", () => {
    assert.equal(isWorkspaceDoc({ ...validDoc(), futureField: true }), true);
  });
});
