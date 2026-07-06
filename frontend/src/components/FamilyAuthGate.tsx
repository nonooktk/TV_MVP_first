"use client";

// 家族側ページの認証ゲート（内製C5・マルチプロバイダ選択式サインイン）
//
// - どのプロバイダも無効（NEXT_PUBLIC_ENTRA_CLIENT_ID / NEXT_PUBLIC_GOOGLE_CLIENT_ID とも空）:
//   何もせず children をそのまま描画する＝現行の dev トークン動作。認証SDKも初期化しない。
// - いずれか有効: 初期化してサインイン状態を確認し、
//     未サインイン → 選択式サインイン画面（有効なプロバイダのボタンのみ表示）
//                    ・Google=GIS 公式ボタン ・Microsoft=既存 MSAL ボタン
//     サインイン済み → children を描画する。
//
// サインイン判定は「Google の ID トークン保持」または「Entra のアカウント有無」のいずれか。
// api-client（resolveFamilyToken）は Google 優先で Bearer を解決する。
//
// 高齢者側（/elder/*）はこのゲートを使わない（認証SDKを読み込まない）。

import { useEffect, useRef, useState } from "react";
import { initAuth, isEntraEnabled, isSignedIn, login } from "../lib/auth";
import {
  isGoogleEnabled,
  isGoogleSignedIn,
  renderGoogleButton,
} from "../lib/googleAuth";

type GateState = "checking" | "signed_out" | "signed_in";

export default function FamilyAuthGate({ children }: { children: React.ReactNode }) {
  const googleEnabled = isGoogleEnabled();
  const entraEnabled = isEntraEnabled();
  // どちらのプロバイダも無効なら認証ゲート自体を無効化（従来どおり dev トークン動作）。
  const authEnabled = googleEnabled || entraEnabled;

  const [state, setState] = useState<GateState>(
    authEnabled ? "checking" : "signed_in"
  );
  const [signingIn, setSigningIn] = useState(false);
  // GIS 公式ボタンの描画先。
  const googleBtnRef = useRef<HTMLDivElement | null>(null);

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
      } catch {
        // 初期化失敗時はサインイン画面を出す（ユーザーが再試行できる）。
        if (!cancelled) setState("signed_out");
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
    }).catch(() => {
      // GIS ロード失敗時はボタンが出ないだけ（Microsoft があればそちらで続行可能）。
    });
    return () => {
      cancelled = true;
    };
  }, [state, googleEnabled]);

  async function handleMicrosoftSignIn() {
    setSigningIn(true);
    try {
      await login(); // リダイレクトが始まる（以降のコードは通常走らない）
    } catch {
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
        <p style={{ color: "var(--color-text-muted)" }}>読み込み中…</p>
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
        <div style={{ fontSize: 40, marginBottom: 8 }}>📞</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
          元気にしてる？
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

          {/* Google と Microsoft の両方が有効なときは区切りを入れる。 */}
          {googleEnabled && entraEnabled && (
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

          {/* Microsoft: 既存 MSAL（リダイレクト方式）。 */}
          {entraEnabled && (
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

        <p
          style={{
            fontSize: 12,
            color: "var(--color-text-muted)",
            marginTop: 20,
            marginBottom: 0,
          }}
        >
          {googleEnabled && entraEnabled
            ? "Google アカウント、または Microsoft アカウント（Outlook / Hotmail など）でご利用いただけます。"
            : googleEnabled
            ? "お持ちの Google アカウントでご利用いただけます。"
            : "お持ちの Microsoft アカウント（Outlook / Hotmail など）でご利用いただけます。"}
        </p>
      </div>
    </div>
  );
}
