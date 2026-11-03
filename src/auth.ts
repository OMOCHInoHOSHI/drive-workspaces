import { getLocal, removeLocal, setLocal } from "./store.js";

/**
 * Google OAuth（認可コードフロー + PKCE）。
 *
 * Chrome 以外の Chromium 系ブラウザ（Edge など）は chrome.identity.getAuthToken に
 * 対応していないため、全ブラウザ共通で launchWebAuthFlow を使う。
 * launchWebAuthFlow 単体ではアクセストークン（約1時間）しか得られないので、
 * access_type=offline でリフレッシュトークンを取得し chrome.storage.local に保持する。
 *
 * 注意: Google の「ウェブアプリケーション」型クライアントは PKCE を使っても
 * トークン交換に client_secret を要求する。自分専用の前提で拡張内に保持している。
 * 配布する場合はこの方式は使わないこと。
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const SCOPE = "https://www.googleapis.com/auth/drive.appdata";

export class AuthRequiredError extends Error {
  constructor(msg = "Google へのサインインが必要です（設定画面からサインインしてください）") {
    super(msg);
    this.name = "AuthRequiredError";
  }
}

export function redirectUri(): string {
  // https://<拡張ID>.chromiumapp.org/
  return chrome.identity.getRedirectURL();
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len = 64): string {
  return base64url(crypto.getRandomValues(new Uint8Array(len))).slice(0, len);
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

async function getClient(): Promise<{ clientId: string; clientSecret: string }> {
  const s = await getLocal("settings");
  if (!s?.clientId || !s?.clientSecret) {
    throw new AuthRequiredError("設定画面で OAuth クライアントID とシークレットを入力してください");
  }
  return { clientId: s.clientId, clientSecret: s.clientSecret };
}

/** 対話的サインイン。設定画面（拡張ページ）から呼ぶ。ポップアップから呼ぶと認証窓が開いた時点でポップアップが閉じて失敗する。 */
export async function signIn(): Promise<void> {
  const { clientId, clientSecret } = await getClient();
  const verifier = randomString(64);
  const challenge = base64url(await sha256(verifier));
  const state = randomString(32);

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  // リフレッシュトークンは初回同意時にしか返らないため、毎回同意画面を出して確実に受け取る
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  if (!responseUrl) throw new Error("認証がキャンセルされました");

  const params = new URL(responseUrl).searchParams;
  const err = params.get("error");
  if (err) throw new Error(`認証エラー: ${err}`);
  if (params.get("state") !== state) throw new Error("state が一致しません（認証をやり直してください）");
  const code = params.get("code");
  if (!code) throw new Error("認可コードが返されませんでした");

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, { method: "POST", body });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`トークン取得失敗: ${json.error ?? res.status} ${json.error_description ?? ""}`);
  }
  if (!json.refresh_token) {
    throw new Error("リフレッシュトークンが返されませんでした。Googleアカウントの「サードパーティのアクセス」からこのアプリを削除して再度サインインしてください");
  }
  await setLocal("auth", {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
}

export async function signOut(): Promise<void> {
  const auth = await getLocal("auth");
  await removeLocal("auth");
  if (auth?.refreshToken) {
    // 失敗しても致命的ではない
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(auth.refreshToken)}`, {
      method: "POST",
    }).catch(() => undefined);
  }
}

export async function isSignedIn(): Promise<boolean> {
  return !!(await getLocal("auth"))?.refreshToken;
}

let refreshing: Promise<string> | null = null;

/** 有効なアクセストークンを返す。期限切れが近ければリフレッシュする。 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const auth = await getLocal("auth");
  if (!auth?.refreshToken) throw new AuthRequiredError();
  if (!forceRefresh && auth.accessToken && auth.expiresAt - Date.now() > 60_000) return auth.accessToken;

  // 同時に複数回リフレッシュしないようにする
  refreshing ??= (async () => {
    try {
      const { clientId, clientSecret } = await getClient();
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: auth.refreshToken,
        grant_type: "refresh_token",
      });
      const res = await fetch(TOKEN_ENDPOINT, { method: "POST", body });
      const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
      if (!res.ok || !json.access_token) {
        if (json.error === "invalid_grant") {
          // 取り消し・失効（OAuth同意画面が「テスト」のままだと7日で失効する）
          await removeLocal("auth");
          throw new AuthRequiredError("Google の認証が失効しました。設定画面から再度サインインしてください");
        }
        throw new Error(`トークン更新失敗: ${json.error ?? res.status}`);
      }
      await setLocal("auth", {
        ...auth,
        accessToken: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      });
      return json.access_token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
