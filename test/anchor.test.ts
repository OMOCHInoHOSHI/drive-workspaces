import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { anchorUrl, anchorWsId } from "../src/anchor.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("anchorUrl / anchorWsId", () => {
  it("google.com の URL で、ID は # 以降に入る", () => {
    const u = new URL(anchorUrl(ID));
    assert.equal(u.origin, "https://www.google.com");
    assert.equal(u.pathname + u.search, "/");
    assert.ok(u.hash.includes(ID));
  });

  it("作った URL から ID を読み戻せる", () => {
    assert.equal(anchorWsId(anchorUrl(ID)), ID);
  });

  it("Google 内のリダイレクト先でも # 以降が残っていれば目印とみなす", () => {
    assert.equal(anchorWsId(`https://consent.google.com/m?continue=x#dw=${ID}`), ID);
    assert.equal(anchorWsId(`https://google.com/#dw=${ID}`), ID);
  });

  it("# 以降に ID が無い URL は目印ではない", () => {
    assert.equal(anchorWsId("https://www.google.com/"), null);
    assert.equal(anchorWsId("https://www.google.com/search?q=dw"), null);
    assert.equal(anchorWsId("https://www.google.com/#dw="), null);
    assert.equal(anchorWsId(`https://www.google.com/?x=#other=${ID}`), null);
    assert.equal(anchorWsId(`https://www.google.com/?dw=${ID}`), null);
  });

  it("Google 以外のサイトは目印とみなさない", () => {
    assert.equal(anchorWsId(`https://example.com/#dw=${ID}`), null);
    assert.equal(anchorWsId(`https://google.com.example.com/#dw=${ID}`), null);
    assert.equal(anchorWsId(`https://notgoogle.com/#dw=${ID}`), null);
    assert.equal(anchorWsId(`http://www.google.com/#dw=${ID}`), null);
  });

  it("URL として読めない文字列は目印ではない", () => {
    assert.equal(anchorWsId(""), null);
    assert.equal(anchorWsId("#dw=x"), null);
  });
});
