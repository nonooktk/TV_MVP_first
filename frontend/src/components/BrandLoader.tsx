"use client";

// 読み込み中のブランド表示（S3）。既存の「読み込み中…」テキストを置き換える。
// 正本: 02_プロジェクト/TV_MVP/デザイン仕様_S3_おもひでてれび_墨モノクロ.md §3
//
// このコンポーネントは完全に表示専用（state も effect もタイマーも持たない）。
// 表示・消滅は呼び出し側の既存の読み込み状態（state === "checking" / loading）に完全に従う。
// したがって既存のタイムアウト・API 呼び出し・通話/同期フローには一切干渉しない
// （＝読み込みが終われば必ず消え、ローダー起因で操作不能になる経路が存在しない）。
//
// 家族側のみに適用する。高齢者側（/elder/*）には適用しない
// ＝待受は「テレビがついている」即応性が最優先で、ロゴの演出を挟まない（仕様 §7-12）。
//
// variant="page"   … 画面全体の読み込み（ロゴ＋墨バー＋文言）
// variant="inline" … セクション内の部分読み込み（墨バー＋文言のみ）
export default function BrandLoader({
  label = "読み込み中…",
  variant = "page",
}: {
  label?: string;
  variant?: "page" | "inline";
}) {
  return (
    <div
      className={`brand-loader brand-loader--${variant}`}
      role="status"
      aria-live="polite"
      data-testid="brand-loader"
    >
      {variant === "page" && (
        // 装飾扱い（同じ意味を label が読み上げるため alt は空）。
        // width/height（実ファイルの実寸 480×453）を指定して CLS を防ぐ。
        // ※ 読み込みに失敗した場合、alt="" でも CSS でサイズが確定しているため
        //   Chrome は破損画像アイコン付きの枠を描画する（悲観QA M-2 で実測）。
        //   進行中の意味自体は label が担うので情報は欠落しない。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="brand-loader__logo"
          src="/brand/logo.png"
          alt=""
          aria-hidden="true"
          width={480}
          height={453}
        />
      )}
      <div className="brand-loader__bar" aria-hidden="true" />
      <span className="brand-loader__label">{label}</span>
    </div>
  );
}
