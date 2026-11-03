// tsc でコンパイルし、HTML/CSS/manifest を dist にコピーする。
// extension-key.json があれば manifest に "key" を差し込む（拡張IDを固定）。
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

execSync("npx tsc", { cwd: root, stdio: "inherit" });

for (const f of readdirSync(src)) {
  if (f.endsWith(".html") || f.endsWith(".css")) cpSync(join(src, f), join(dist, f));
}

const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
const keyFile = join(root, "extension-key.json");
if (existsSync(keyFile)) {
  const { key, extensionId } = JSON.parse(readFileSync(keyFile, "utf8"));
  manifest.key = key;
  console.log(`manifest に key を設定しました（拡張ID: ${extensionId}）`);
} else {
  console.warn("警告: extension-key.json がありません。拡張IDが固定されずOAuthが動きません。先に npm run keygen を実行してください。");
}
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("ビルド完了: dist/ を「パッケージ化されていない拡張機能を読み込む」で指定してください。");
