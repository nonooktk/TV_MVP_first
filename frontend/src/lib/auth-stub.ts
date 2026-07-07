// 支給物A7: 認証スタブ（内製）
// ローカル開発専用の家族固定トークンを返す仮実装（本番の代替は Google/Entra 本実装）。
//
// 【退行対策・item 2】固定値をコードへ直書きしない:
//   トークンは NEXT_PUBLIC_DEV_TOKEN（環境変数）から取得する。
//   - ローカル開発: frontend/.env.local に NEXT_PUBLIC_DEV_TOKEN=dev-fixed-token を置く
//     （＝従来どおりの利便を維持）。
//   - 本番ビルド: frontend/.env.production には NEXT_PUBLIC_DEV_TOKEN を書かない。
//     Google/Entra が有効なので resolveFamilyToken は dev トークンへ到達せず、
//     未設定なら空文字（＝バンドルに固定トークンが焼き込まれない）。
//     万一 dev トークンが使われても空文字は backend で 401 になる（無効な裏口が残らない）。

export function getAuthToken(): string {
  return process.env.NEXT_PUBLIC_DEV_TOKEN ?? "";
}
