"use client";

// 家族側ページの認証ゲート（内製C5・マルチプロバイダ選択式サインイン）
//
// - どのプロバイダも無効（NEXT_PUBLIC_ENTRA_CLIENT_ID / NEXT_PUBLIC_GOOGLE_CLIENT_ID とも空）:
//   何もせず children をそのまま描画する＝現行の dev トークン動作。認証SDKも初期化しない。
// - いずれか有効: 初期化してサインイン状態を確認し、
//     未サインイン → 選択式サインイン画面（有効なプロバイダのボタンのみ表示）
//                    ・Google=GIS 公式ボタン ・Microsoft=既存 MSAL ボタン
//                      （※ Microsoft ボタンは 2026-07-28 より非表示。SHOW_ENTRA_SIGNIN 参照）
//     サインイン済み → children を描画する。
//
// サインイン判定は「Google の ID トークン保持」または「Entra のアカウント有無」のいずれか。
// api-client（resolveFamilyToken）は Google 優先で Bearer を解決する。
//
// 高齢者側（/elder/*）はこのゲートを使わない（認証SDKを読み込まない）。

import { useEffect, useRef, useState } from "react";
import BrandLoader from "./BrandLoader";
import {
  clearMsalInteractionState,
  formatAuthError,
  initAuth,
  isEntraEnabled,
  isInteractionInProgressError,
  isSignedIn,
  login,
} from "../lib/auth";
import {
  isGoogleEnabled,
  isGoogleSignedIn,
  renderGoogleButton,
} from "../lib/googleAuth";
import { ENTRA_AUTH_ENABLED } from "../lib/auth-flags";

type GateState = "checking" | "signed_out" | "signed_in";

// Microsoft（Entra ID）サインインボタンの表示フラグ。
//
// 認証の可否そのものは共有フラグ lib/auth-flags.ts の ENTRA_AUTH_ENABLED が持つ
// （リリース前 悲観QA B-1 の是正。表示層だけ隠しても認証解決層が生きていると
//  MSAL キャッシュを持つ既存利用者が壊れた Microsoft サインインへ飛ばされ続けるため）。
//
// ※ ここで共有フラグを直接参照せず false リテラルを置いているのは意図的。
//    import 経由の定数はモジュールを跨ぐため minifier が畳み込めず、Microsoft ボタンの
//    JSX が配信バンドルに残る（「Microsoft でサインイン」「microsoft-signin-button」が
//    チャンクに出力されることを実測で確認）。同一モジュール内の false リテラルなら
//    ビルド時に枝ごと除去される。
//    実行時の値は下の型アサーションで共有フラグと一致することが保証される。
// ※ 条件式では必ずこの定数を先頭に置くこと（`SHOW_ENTRA_SIGNIN && ...`）。
const SHOW_ENTRA_SIGNIN = false;

// 表示フラグと共有フラグの食い違いを型レベルで防ぐ。
// auth-flags.ts の ENTRA_AUTH_ENABLED を true に戻すと、この行が
// 「Type 'false' is not assignable to type 'true'」で tsc エラーになる。
// ＝コンパイラが「表示側の SHOW_ENTRA_SIGNIN も true にせよ」と必ず教えるため、
//   認証だけ復活してボタンが出ない（またはその逆）状態のまま出荷されることはない。
const entraFlagsInSync: typeof ENTRA_AUTH_ENABLED = SHOW_ENTRA_SIGNIN;
void entraFlagsInSync;

export default function FamilyAuthGate({ children }: { children: React.ReactNode }) {
  const googleEnabled = isGoogleEnabled();
  const entraEnabled = isEntraEnabled();
  // どちらのプロバイダも無効なら認証ゲート自体を無効化（従来どおり dev トークン動作）。
  const authEnabled = googleEnabled || entraEnabled;

  const [state, setState] = useState<GateState>(
    authEnabled ? "checking" : "signed_in"
  );
  const [signingIn, setSigningIn] = useState(false);
  // 認証エラー全文（AADSTS コード等）。サインイン不具合の原因特定用に画面へ表示する。
  const [authError, setAuthError] = useState<string | null>(null);
  // GIS 公式ボタンの描画先。
  const googleBtnRef = useRef<HTMLDivElement | null>(null);
  // GIS スクリプトに到達できずボタンを描画できなかった（悲観QA M-1）。
  const [googleLoadFailed, setGoogleLoadFailed] = useState(false);

  // 初期化＋サインイン状態の判定（Entra 有効時のみ MSAL を初期化する）。
  useEffect(() => {
    if (!authEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        // Google のサインイン判定は sessionStorage のトークン有無で即時に分かる。
        if (isGoogleSignedIn()) {
          if (!cancelled) setState("signed_in");
          return;
        }
        // Entra 有効時のみ MSAL を初期化（リダイレクト応答処理を兼ねる）。
        if (entraEnabled) {
          await initAuth();
          const ok = await isSignedIn();
          if (!cancelled) {
            setState(ok ? "signed_in" : "signed_out");
            return;
          }
        }
        if (!cancelled) setState("signed_out");
      } catch (e) {
        // 初期化（handleRedirectPromise）の失敗。従来は握りつぶしていたが、
        // AADSTS コード等の原因が分かるよう保持・表示し、console にも全文を出す。
        console.error(
          "[FamilyAuthGate] 認証初期化(handleRedirectPromise)でエラー:",
          e
        );
        // interaction_in_progress の残留は次回サインインを弾くため、ここでクリアしておく。
        if (isInteractionInProgressError(e)) {
          clearMsalInteractionState();
        }
        if (!cancelled) {
          setAuthError(formatAuthError(e));
          setState("signed_out");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authEnabled, entraEnabled]);

  // 未サインイン画面になったら GIS 公式ボタンを描画する（Google 有効時のみ）。
  useEffect(() => {
    if (state !== "signed_out" || !googleEnabled || !googleBtnRef.current) return;
    let cancelled = false;
    void renderGoogleButton(googleBtnRef.current, () => {
      // ID トークン取得後にサインイン完了。
      if (!cancelled) setState("signed_in");
    }).catch((e) => {
      // GIS（accounts.google.com）に到達できないとボタンが描画されない。
      // Microsoft ボタンを出さなくなった今、握りつぶすと「押せる要素ゼロ・エラーゼロ」の
      // 行き止まり画面になる（リリース前 悲観QA M-1）。原因が分かる文言を必ず出す。
      // 到達条件: 広告ブロッカー・企業プロキシ・GIS 障害・オフライン。
      console.error("[FamilyAuthGate] Google サインインボタンの初期化に失敗:", e);
      if (!cancelled) {
        setGoogleLoadFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state, googleEnabled]);

  async function handleMicrosoftSignIn() {
    setSigningIn(true);
    setAuthError(null);
    try {
      await login(); // リダイレクトが始まる（以降のコードは通常走らない）
    } catch (e) {
      console.error("[FamilyAuthGate] サインイン開始でエラー:", e);
      // interaction_in_progress（一時状態の残留）ならクリアして 1 回だけ自動リトライする。
      if (isInteractionInProgressError(e)) {
        clearMsalInteractionState();
        try {
          await login(); // 復旧後の再試行。成功すればリダイレクトが始まる。
          return;
        } catch (retryError) {
          console.error(
            "[FamilyAuthGate] 一時状態クリア後の再試行でもエラー:",
            retryError
          );
          setAuthError(
            `${formatAuthError(retryError)}（もう一度お試しください）`
          );
          setSigningIn(false);
          return;
        }
      }
      setAuthError(formatAuthError(e));
      setSigningIn(false);
    }
  }

  if (state === "signed_in") {
    return <>{children}</>;
  }

  if (state === "checking") {
    return (
      <div
        className="family-shell"
        style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        {/* 起動時の表示はここが担う（FamilyAuthGate が家族側 4 ページをすべてラップするため、
            起動直後は必ずここを通る）。状態変数 state は変更していない＝消滅条件は従来どおり
            state !== "checking" になったとき。 */}
        <BrandLoader />
      </div>
    );
  }

  // 未サインイン: 選択式サインイン画面（有効なプロバイダのボタンのみ表示）。
  return (
    <div
      className="family-shell"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 8,
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 360, padding: 28 }}>
        {/* S3: 直前にあった 📞 の div は削除した（カラー絵文字はモノクロ方針と相反し、
            その役割はロゴが担うため。テスト用の識別属性は付いていなかった）。 */}
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="brand-logo"
            src="/brand/logo.png"
            alt="おもひでてれび"
            width={480}
            height={453}
          />
        </h1>
        <p
          style={{
            color: "var(--color-text-muted)",
            fontSize: 14,
            marginTop: 0,
            marginBottom: 24,
          }}
        >
          離れて暮らす家族と、顔を見て話せるビデオ通話。
          <br />
          サインインしてはじめましょう。
        </p>

        {/* サインイン方法（有効なプロバイダのみ）。 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
          }}
        >
          {/* Google: GIS 公式ボタン（renderGoogleButton がこの要素に描画する）。 */}
          {googleEnabled && (
            <div
              ref={googleBtnRef}
              data-testid="google-signin-button"
              style={{ display: "flex", justifyContent: "center", minHeight: 40 }}
            />
          )}

          {/* GIS に到達できずボタンを描画できなかったときの診断と復帰手段（悲観QA M-1）。
              これが無いと「押せる要素ゼロ・エラーゼロ」の行き止まり画面になる。 */}
          {googleEnabled && googleLoadFailed && (
            <div
              data-testid="google-load-error"
              style={{
                width: "100%",
                fontSize: 13,
                lineHeight: 1.6,
                color: "var(--color-danger)",
                background: "var(--color-tint-primary)",
                border: "1px solid var(--color-danger)",
                borderRadius: 8,
                padding: "10px 12px",
                textAlign: "left",
              }}
            >
              サインインの準備に失敗しました。
              <br />
              通信環境（オフライン・広告ブロッカー・社内プロキシ）をご確認のうえ、
              もういちどお試しください。
              <button
                className="btn-secondary"
                style={{ marginTop: 10 }}
                onClick={() => window.location.reload()}
              >
                再読み込み
              </button>
            </div>
          )}

          {/* Google と Microsoft の両方が有効なときは区切りを入れる。
              SHOW_ENTRA_SIGNIN=false の間はこの枝ごとビルドから除去される。 */}
          {SHOW_ENTRA_SIGNIN && googleEnabled && entraEnabled && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                gap: 10,
                color: "var(--color-text-muted)",
                fontSize: 12,
              }}
            >
              <span style={{ flex: 1, height: 1, background: "var(--color-border, #ddd)" }} />
              または
              <span style={{ flex: 1, height: 1, background: "var(--color-border, #ddd)" }} />
            </div>
          )}

          {/* Microsoft: 既存 MSAL（リダイレクト方式）。
              SHOW_ENTRA_SIGNIN=false の間は非表示（ロジックは温存・上記の定数コメント参照）。 */}
          {SHOW_ENTRA_SIGNIN && entraEnabled && (
            <button
              className="btn-primary"
              data-testid="microsoft-signin-button"
              style={{ width: "100%", fontSize: 16 }}
              onClick={handleMicrosoftSignIn}
              disabled={signingIn}
            >
              {signingIn ? "サインインしています…" : "Microsoft でサインイン"}
            </button>
          )}
        </div>

        {/* 認証エラー全文（AADSTS コード等）。原因特定用に赤字の小さめテキストで表示する。 */}
        {authError && (
          <p
            data-testid="auth-error"
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              // S3: 面はモノクロの淡墨のにじみにし、朱は文字と枠線だけに使う
              // （--color-danger-bg は未定義でハードコードの淡桃 #fdecea が描画されていた）。
              // 朱文字は淡墨のにじみ面に対し 8.15:1。
              color: "var(--color-danger)",
              background: "var(--color-tint-primary)",
              border: "1px solid var(--color-danger)",
              borderRadius: 8,
              padding: "10px 12px",
              marginTop: 20,
              marginBottom: 0,
              textAlign: "left",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            サインインでエラーが発生しました:
            {"\n"}
            {authError}
          </p>
        )}

        <p
          style={{
            fontSize: 12,
            color: "var(--color-text-muted)",
            marginTop: 20,
            marginBottom: 0,
          }}
        >
          {/* SHOW_ENTRA_SIGNIN=false の間は Google のみの文言に固定する。
              三項の外側にフラグを置くことで、Microsoft を含む文言はビルドから除去される。 */}
          {SHOW_ENTRA_SIGNIN
            ? googleEnabled && entraEnabled
              ? "Google アカウント、または Microsoft アカウント（Outlook / Hotmail など）でご利用いただけます。"
              : googleEnabled
              ? "お持ちの Google アカウントでご利用いただけます。"
              : "お持ちの Microsoft アカウント（Outlook / Hotmail など）でご利用いただけます。"
            : "お持ちの Google アカウントでご利用いただけます。"}
        </p>
      </div>
    </div>
  );
}
