// 拡張機能IDを固定するための公開鍵を生成し、extension-key.json に保存する。
// manifest の "key" に入れた公開鍵から拡張IDが決まるため、
// Chrome / Edge / Brave などどのChromium系ブラウザでも同じIDになる。
// 未パッケージ読み込みでは秘密鍵は不要なので保存しない。
import { generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const OUT = new URL("../extension-key.json", import.meta.url);

if (existsSync(OUT) && !process.argv.includes("--force")) {
  console.error("extension-key.json は既にあります。作り直すとIDが変わり、OAuthのリダイレクトURIも登録し直しになります。");
  console.error("本当に作り直す場合は: npm run keygen -- --force");
  process.exit(1);
}

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const key = der.toString("base64");

// 拡張ID = 公開鍵(DER)のSHA-256の先頭128bitを16進にし、0-f を a-p に置換したもの
const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");

writeFileSync(OUT, JSON.stringify({ key, extensionId: id }, null, 2) + "\n");
console.log("拡張ID:        ", id);
console.log("リダイレクトURI:", `https://${id}.chromiumapp.org/`);
console.log("→ このURIを Google Cloud の OAuth クライアント（ウェブアプリケーション）の「承認済みのリダイレクトURI」に登録してください。");
