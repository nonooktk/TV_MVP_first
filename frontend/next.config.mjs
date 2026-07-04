/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Azure Static Web Apps へ静的配信するため静的エクスポートを有効化する（A1）。
  // 全ページが "use client" のためサーバ機能に依存せず成立する。
  // `next build` で out/ に HTML/JS/CSS を書き出す（next start は不要）。
  output: "export",
  // 静的ホスティングではデフォルト画像最適化サーバが無いため無効化する
  // （本アプリは next/image を使っていないが将来の追加時の保険）。
  images: { unoptimized: true },
  // 静的ホストで /path を /path/index.html に対応させる（相対リンクの安定化）。
  trailingSlash: true,
};

export default nextConfig;
