// 支給物A7: 認証スタブ（内製）
// 固定トークンを返すだけの仮実装。
// Entra External ID 本実装（内製C5）で差し替える。

export function getAuthToken(): string {
  return "dev-fixed-token";
}
