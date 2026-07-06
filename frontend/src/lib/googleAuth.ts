// 家族側ログイン（Google アカウント・マルチプロバイダ化）
//
// Google Identity Services（GIS・`https://accounts.google.com/gsi/client`）で ID トークンを
// 取得する。Entra（MSAL・lib/auth.ts）と対称の「有効化は環境変数で」二段構え:
// - NEXT_PUBLIC_GOOGLE_CLIENT_ID が空なら Google は「無効」（ボタンを出さない・スクリプト非ロード）。
// - 非空なら「有効」。サインイン画面で GIS 公式ボタンを描画し、ID トークンを sessionStorage 保持。
//   api-client の resolveFamilyToken がこの ID トークンを Bearer に載せる。
//
// 素朴運用（brief 指定）:
// - ID トークンの期限は約1時間。期限管理は行わず、401 を受けたら再サインイン画面へ戻す。
// - ログアウト＝sessionStorage のトークン破棄（＋GIS の自動選択を無効化）。
//
// 静的エクスポート（output:'export'）互換のため、GIS スクリプトは「有効かつクライアント側」で
// 初回利用時にのみ動的ロードする（トップレベルの副作用・window 参照を避ける）。

// OAuth クライアントID（公開値）。ビルド時に注入する。空なら Google 無効。
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

// sessionStorage のキー（ID トークン＝JWT を保持）。
const TOKEN_KEY = "google_id_token";

// GIS スクリプトの URL（有効時のみ動的ロードする）。
const GIS_SRC = "https://accounts.google.com/gsi/client";

/** Google が有効か（クライアントID が設定されているか）。 */
export function isGoogleEnabled(): boolean {
  return CLIENT_ID.trim().length > 0;
}

/** 保持中の Google ID トークン（未サインインなら null）。 */
export function getGoogleIdToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

/** ID トークンを保持する。 */
function setGoogleIdToken(token: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

/** サインアウト（セッション破棄＋GIS 自動選択の無効化）。 */
export function googleLogout(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(TOKEN_KEY);
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch {
    /* GIS 未ロードなら無視 */
  }
}

/** サインイン済みか（Google 有効かつトークン保持）。 */
export function isGoogleSignedIn(): boolean {
  return isGoogleEnabled() && getGoogleIdToken() !== null;
}

// GIS スクリプトの多重ロードを防ぐ Promise。
let gisLoadPromise: Promise<void> | null = null;

/** GIS スクリプトを動的ロードする（有効かつクライアント側のみ・1回だけ）。 */
function loadGis(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("GIS はブラウザ環境でのみ利用できます"));
  }
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;

  gisLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SRC}"]`
    );
    if (existing) {
      // 既にタグはあるが未初期化のことがある → load を待つ。
      if (window.google?.accounts?.id) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("GIS スクリプトのロードに失敗しました"))
      );
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("GIS スクリプトのロードに失敗しました"));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

// GIS の callback から受け取る credential の型（ID トークンを含む）。
interface GisCredentialResponse {
  credential?: string;
}

/**
 * GIS を初期化し、指定要素に公式サインインボタンを描画する。
 *
 * ボタン押下 → Google のサインイン → callback で ID トークン（credential）を受け取り、
 * sessionStorage に保持して onSignedIn を呼ぶ（呼び出し側は state を signed_in に更新する）。
 *
 * @param buttonEl ボタンを描画する要素
 * @param onSignedIn ID トークン取得後に呼ばれる
 */
export async function renderGoogleButton(
  buttonEl: HTMLElement,
  onSignedIn: () => void
): Promise<void> {
  if (!isGoogleEnabled()) return;
  await loadGis();
  const id = window.google!.accounts!.id!;
  id.initialize({
    client_id: CLIENT_ID,
    callback: (resp: GisCredentialResponse) => {
      if (resp.credential) {
        setGoogleIdToken(resp.credential);
        onSignedIn();
      }
    },
    auto_select: false,
  });
  id.renderButton(buttonEl, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "signin_with",
    shape: "pill",
    logo_alignment: "left",
    // 日本語表示（家族側 UI に合わせる）。
    locale: "ja",
  });
}

// GIS のグローバル型（動的ロードのため最小限だけ宣言する）。
declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string;
            callback: (resp: GisCredentialResponse) => void;
            auto_select?: boolean;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: Record<string, unknown>
          ) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}
