// 認証プロバイダの有効／無効フラグ（コード側スイッチ）。
//
// 環境変数（NEXT_PUBLIC_ENTRA_CLIENT_ID 等）とは独立した、コード側の確実な遮断スイッチ。
// env は環境ごとに異なり、本番ビルドにクライアントID が焼き込まれているかを
// 実装側から保証できないため、「壊れている導線を確実に塞ぐ」目的にはこちらを使う。
//
// ── ENTRA_AUTH_ENABLED = false の理由（2026-07-28・統括指示） ─────────────
// Microsoft Entra ID でのログインが現在できない状態のため、Entra 認証を
// **表示層だけでなく認証解決層ごと**無効化する。
//
// ボタンを隠すだけでは不十分だった（リリース前 悲観QA B-1）。MSAL のキャッシュは
// localStorage に恒久的に残るため、過去に一度でも Microsoft サインインを完了した
// 利用者は、再訪時に次の経路で壊れた Microsoft サインインへ飛ばされ続ける:
//   - FamilyAuthGate: isSignedIn() が true → サインイン画面を出さずに通してしまう
//   - api-client の resolveFamilyToken(): isEntraEnabled() が true
//       → getApiAccessToken() → acquireTokenRedirect()
//       → login.microsoftonline.com へ画面遷移（Google 導線に到達できない）
//
// このフラグを false にすると auth.ts の isEntraEnabled() が常に false を返し、
// initAuth / getAccount / login / logout / getApiAccessToken / isSignedIn の
// すべてが早期 return する。結果として:
//   - handleRedirectPromise（initAuth 内）は呼ばれない＝無効化後も例外を出さない
//   - ゲートは Entra アカウントの有無を見ずに「未サインイン」と判定し Google 画面を出す
//   - トークン解決は Google → dev トークンの順にフォールバックする
//
// MSAL キャッシュ（localStorage の msal.* エントリ）は残置されるが、
// 参照する経路がすべて塞がれるため無害。Entra 再開時にそのまま再利用でき、
// 利用者に再サインインを強いない利点もある。明示的に消す必要はない。
//
// ── 再開手順 ────────────────────────────────────────────────
// Entra ログインが復旧したら、このフラグを true に戻すだけでよい。
// 認証ロジック（lib/auth.ts・MSAL・backend の検証）は一切削除していない。
// FamilyAuthGate の Microsoft ボタン表示もこのフラグを参照しているため、
// 1 箇所の変更で表示・認証の両方が同時に復活する。
export const ENTRA_AUTH_ENABLED = false;
