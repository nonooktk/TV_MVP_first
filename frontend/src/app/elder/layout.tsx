// 高齢者側（/elder/*）のレイアウト（Android アプリ化 T1・PWA 化）。
// 正本: 02_プロジェクト/TV_MVP-android/ARCHITECTURE.md §2-5
//
// 目的は manifest と theme-color をこの配下だけ差し替えることの1点に尽きる。
// children をそのまま返すサーバーコンポーネントで、html / body は持たない
// （ルートレイアウトのみが持つ）。DOM 構造は変わらないため、既存のスタイル・
// data-testid・待受のロジックには一切影響しない。
//
// "use client" にはしない。metadata / viewport のエクスポートはサーバーコンポーネント
// でのみ有効で、配下の各ページが "use client" であることとは独立に成立する。

// elder.webmanifest は scope "/elder/"・start_url "/elder/standby/"・landscape。
// より具体的な scope を持つため、/elder/* ではこちらが優先される。
// Bubblewrap は scope の pathname を AndroidManifest.xml の android:pathPrefix へ
// 出力するため、TWA が横取りする外部リンクも /elder/* に限定される（T2 で確認）。
export const metadata = {
  manifest: "/elder.webmanifest",
};

// 墨色キャビネット --elder-cabinet（S3 デザイン仕様の実値）。
// 落款朱 #7b2118 は使わない（朱は削除・エラー・終了の5カテゴリ限定のため、
// テーマカラーに使うと「赤＝取り返しのつかない操作」の規則が壊れる）。
export const viewport = {
  themeColor: "#33302b",
};

export default function ElderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
