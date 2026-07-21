// 家族側ログイン（Entra ID 本実装・内製C5）
//
// 二段構え:
// - NEXT_PUBLIC_ENTRA_CLIENT_ID が空（アプリ登録未作成）なら Entra は「無効」。
//   ログイン UI は出さず、api-client は従来どおり dev 固定トークン（auth-stub.ts）で動く。
// - 非空なら Entra「有効」。MSAL でサインインし、api-client の Bearer を
//   Entra のアクセストークンへ差し替える。
//
// 対象は個人 Microsoft アカウント（authority=common）。SPA/PKCE。
// スコープは api://{clientId}/access_as_user。
//
// 静的エクスポート（output:'export'）互換のため、MSAL の生成は遅延（初回利用時）で行い、
// トップレベルの副作用や window 参照を避ける（SSR/ビルド時に評価されない）。

import type {
  AccountInfo,
  AuthenticationResult,
  IPublicClientApplication,
} from "@azure/msal-browser";

// アプリ登録の「アプリケーション（クライアント）ID」。ビルド時に注入する。
// 空文字なら Entra 無効（＝二段構えの dev トークン動作）。
const CLIENT_ID = process.env.NEXT_PUBLIC_ENTRA_CLIENT_ID ?? "";

// サインイン先テナント（authority）。環境変数を優先し、未設定時は common
// （マルチテナント＋個人 MSA。サインイン対象 = AzureADandPersonalMicrosoftAccount）にフォールバックする。
// 検証期間はシングルテナント運用のため、テナント固定URL
// （https://login.microsoftonline.com/{tenantId} または {tenantDomain}）を
// NEXT_PUBLIC_ENTRA_AUTHORITY に設定できる。
const AUTHORITY =
  process.env.NEXT_PUBLIC_ENTRA_AUTHORITY || "https://login.microsoftonline.com/common";

/** Entra が有効か（クライアントID が設定されているか）。 */
export function isEntraEnabled(): boolean {
  return CLIENT_ID.trim().length > 0;
}

/** API アクセス用スコープ（api://{clientId}/access_as_user）。 */
function apiScopes(): string[] {
  return [`api://${CLIENT_ID}/access_as_user`];
}

// MSAL インスタンス（遅延生成・シングルトン）。初期化 Promise も保持して多重初期化を防ぐ。
let msalInstance: IPublicClientApplication | null = null;
let initPromise: Promise<IPublicClientApplication> | null = null;

/** MSAL の PublicClientApplication を初期化して返す（クライアント側専用）。 */
async function getMsal(): Promise<IPublicClientApplication> {
  if (typeof window === "undefined") {
    throw new Error("MSAL はブラウザ環境でのみ利用できます");
  }
  if (msalInstance) return msalInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // 動的 import で、Entra 無効時やビルド時に MSAL 本体を評価しない。
    const { PublicClientApplication } = await import("@azure/msal-browser");
    const instance = new PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        // SPA。リダイレクトは現在のオリジンへ戻す（アプリ登録の SPA リダイレクトURIに
        // 各環境のオリジン＝localhost:3000 / SWA URL を登録しておく）。
        redirectUri:
          typeof window !== "undefined" ? window.location.origin : undefined,
      },
      cache: {
        // SPA 標準。リロードでセッションを保つため localStorage を使う。
        cacheLocation: "localStorage",
      },
    });
    await instance.initialize();
    // リダイレクト後の応答を処理し、アクティブアカウントを確定する。
    // ここで失敗（AADSTS エラー等）した場合は例外がそのまま呼び出し側へ伝わる。
    // FamilyAuthGate がその例外を保持・表示し、原因コードを可視化する。
    const result = await instance.handleRedirectPromise();
    if (result?.account) {
      instance.setActiveAccount(result.account);
    } else {
      const accounts = instance.getAllAccounts();
      if (accounts.length > 0) instance.setActiveAccount(accounts[0]);
    }
    msalInstance = instance;
    return instance;
  })();

  // 初期化に失敗したら initPromise を破棄し、次回の getMsal で再初期化できるようにする
  // （失敗した Promise を握り続けると、interaction_in_progress クリア後の再試行も同じ例外で失敗するため）。
  initPromise.catch(() => {
    initPromise = null;
  });

  return initPromise;
}

/** MSAL の初期化を明示的に実行する（ページ初期化時に呼ぶ。リダイレクト応答処理を兼ねる）。 */
export async function initAuth(): Promise<void> {
  if (!isEntraEnabled()) return;
  await getMsal();
}

/** 現在サインイン中のアカウント（未サインインなら null）。 */
export async function getAccount(): Promise<AccountInfo | null> {
  if (!isEntraEnabled()) return null;
  const instance = await getMsal();
  return instance.getActiveAccount() ?? instance.getAllAccounts()[0] ?? null;
}

/** 表示名（あれば name、無ければ username）。未サインインなら null。 */
export async function getDisplayName(): Promise<string | null> {
  const account = await getAccount();
  if (!account) return null;
  return account.name ?? account.username ?? null;
}

/** Microsoft サインイン（リダイレクト方式）を開始する。 */
export async function login(): Promise<void> {
  if (!isEntraEnabled()) return;
  const instance = await getMsal();
  await instance.loginRedirect({ scopes: apiScopes() });
}

/** サインアウト（リダイレクト方式）。オリジンへ戻す。 */
export async function logout(): Promise<void> {
  if (!isEntraEnabled()) return;
  const instance = await getMsal();
  await instance.logoutRedirect({
    postLogoutRedirectUri:
      typeof window !== "undefined" ? window.location.origin : undefined,
  });
}

/**
 * API 用のアクセストークンを取得する。
 * まず acquireTokenSilent、失敗（同意切れ・未サインイン等）時は acquireTokenRedirect で
 * 対話取得へフォールバックする（このケースではページ遷移が発生し、以降のコードは走らない）。
 * Entra 無効時は null を返す（api-client が dev トークンにフォールバック）。
 */
export async function getApiAccessToken(): Promise<string | null> {
  if (!isEntraEnabled()) return null;
  const instance = await getMsal();
  const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
  if (!account) {
    // 未サインイン → 対話サインインへ（呼び出し側は通常この前に isSignedIn を確認する）。
    await instance.acquireTokenRedirect({ scopes: apiScopes() });
    return null;
  }
  try {
    const result: AuthenticationResult = await instance.acquireTokenSilent({
      account,
      scopes: apiScopes(),
    });
    return result.accessToken;
  } catch {
    // サイレント取得失敗 → リダイレクトで対話取得（この後ページ遷移）。
    await instance.acquireTokenRedirect({ scopes: apiScopes() });
    return null;
  }
}

/** サインイン済みか（Entra 有効かつアカウントあり）。 */
export async function isSignedIn(): Promise<boolean> {
  if (!isEntraEnabled()) return false;
  const account = await getAccount();
  return account !== null;
}

// --- 認証エラーの可視化・復旧ヘルパー（サインイン不具合の原因特定用） ---
//
// これまで初期化・サインイン開始の失敗は catch で握りつぶしており、原因コード
// （AADSTS xxxx 等）が外から見えなかった。以下のヘルパーで、
//   1. エラー全文を人が読める文字列へ整形（画面表示・console.error 用）、
//   2. interaction_in_progress（MSAL 一時状態の残留）の検出、
//   3. 残留した MSAL 一時状態のクリア（ボタン無反応の二次障害からの自動復旧）
// を提供する。純粋関数（DOM 依存は clearMsalInteractionState のみ・window ガード付き）。

/**
 * 認証エラーを画面表示・ログ用の1行文字列へ整形する。
 * MSAL のエラーは name / errorCode / errorMessage を持ち、errorMessage に AADSTS コードが入る。
 * 標準 Error は name / message。いずれも取りこぼさず、AADSTS コードを含む全文を残す。
 */
export function formatAuthError(e: unknown): string {
  if (e == null) return "不明なエラー";
  if (typeof e === "string") return e;
  const err = e as {
    name?: string;
    errorCode?: string;
    errorMessage?: string;
    message?: string;
  };
  const parts: string[] = [];
  if (err.name) parts.push(err.name);
  if (err.errorCode) parts.push(`code=${err.errorCode}`);
  // MSAL は詳細（AADSTS コード等）を errorMessage に入れる。標準 Error は message。
  const detail = err.errorMessage ?? err.message;
  if (detail) parts.push(detail);
  return parts.length > 0 ? parts.join(" / ") : String(e);
}

/**
 * MSAL の interaction_in_progress（別のサインイン処理が進行中扱いになったまま残留）か判定する。
 * これが出るとボタンを押しても loginRedirect が例外で弾かれ、無反応になる。
 */
export function isInteractionInProgressError(e: unknown): boolean {
  return (e as { errorCode?: string })?.errorCode === "interaction_in_progress";
}

/**
 * 残留した MSAL の一時状態（interaction status 関連）をクリアする。
 * MSAL は進行中フラグを sessionStorage に置く（cacheLocation とは別）。
 * 失敗後にこれが残ると以降のサインインが interaction_in_progress で弾かれ続けるため、
 * `msal.` で始まり interaction を含むキーだけを sessionStorage / localStorage から消す。
 */
export function clearMsalInteractionState(): void {
  if (typeof window === "undefined") return;
  try {
    const storages = [window.sessionStorage, window.localStorage];
    for (const storage of storages) {
      if (!storage) continue;
      // 走査中に removeItem すると index がずれるため、対象キーを先に集めてから消す。
      const targets: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith("msal.") && key.includes("interaction")) {
          targets.push(key);
        }
      }
      for (const key of targets) storage.removeItem(key);
    }
  } catch {
    // ストレージ参照不可（プライベートモード等）なら何もしない。
  }
}
