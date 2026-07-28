"use client";

// 「← ホームへ」戻りヘッダー（内製・v0.5.0 フィードバック改善 第2段）
// album / select などホーム以外の家族側ページの先頭に置く共通導線。
// 2026-07-28: リブランドに伴い、右端にサービス名ロゴ（.brand-mark）を1行追加した
// （枠線・字間・朱のヘアラインは globals.css の .page-header / .brand-mark が担当する）。

export default function BackHeader() {
  return (
    <div className="page-header">
      <a
        className="link-plain"
        href="/"
        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        ← ホームへ
      </a>
      <span className="brand-mark">おもひでてれび</span>
    </div>
  );
}
