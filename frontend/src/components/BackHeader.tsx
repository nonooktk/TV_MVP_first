"use client";

// 「← ホームへ」戻りヘッダー（内製・v0.5.0 フィードバック改善 第2段）
// album / select などホーム以外の家族側ページの先頭に置く共通導線。

export default function BackHeader() {
  return (
    <div style={{ marginBottom: 12 }}>
      <a
        className="link-plain"
        href="/"
        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        ← ホームへ
      </a>
    </div>
  );
}
