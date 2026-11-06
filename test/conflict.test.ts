import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { conflictsWithRemote } from "../src/conflict.js";
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
