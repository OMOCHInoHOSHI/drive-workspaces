import { isSignedIn, redirectUri, signIn, signOut } from "./auth.js";
import { send } from "./messaging.js";
import { getLocal, setLocal } from "./store.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

async function refreshAuthState() {
  const signedIn = await isSignedIn();
  $("authState").textContent = signedIn ? "サインイン済みです。" : "サインインしていません。";
  $("signout").toggleAttribute("disabled", !signedIn);
}

async function init() {
  $("redirect").textContent = redirectUri();
  $("extId").textContent = chrome.runtime.id;
  const s = await getLocal("settings");
  input("clientId").value = s?.clientId ?? "";
  input("clientSecret").value = s?.clientSecret ?? "";
  input("deviceName").value = s?.deviceName ?? "";
  await refreshAuthState();
}

async function saveSettings() {
  await setLocal("settings", {
    clientId: input("clientId").value.trim(),
    clientSecret: input("clientSecret").value.trim(),
    deviceName: input("deviceName").value.trim(),
  });
}

$("save").onclick = async () => {
  await saveSettings();
  $("saved").textContent = "保存しました";
  setTimeout(() => ($("saved").textContent = ""), 2000);
};

// launchWebAuthFlow は拡張ページ（このタブ）から呼ぶ。ポップアップから呼ぶと認証窓が開いた時点で閉じて失敗する
$("signin").onclick = async () => {
  $("authError").textContent = "";
  try {
    await saveSettings();
    await signIn();
    await refreshAuthState();
    await send({ type: "syncNow" });
    $("authState").textContent = "サインインして同期しました。";
  } catch (e) {
    $("authError").textContent = e instanceof Error ? e.message : String(e);
    await refreshAuthState();
  }
};

$("signout").onclick = async () => {
  await signOut();
  await refreshAuthState();
};

void init();
