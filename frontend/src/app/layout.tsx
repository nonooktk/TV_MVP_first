// ルートレイアウト（内製）
// 日本語フォントはシステムフォント（Hiragino / Yu Gothic 等）を globals.css で指定する。
// UIフレームワークは使わず、グローバルCSS1枚のみ読み込む。

import "./globals.css";

export const metadata = {
  title: "元気にしてる？",
  description: "TV電話「元気にしてる？」— 離れて暮らす家族をつなぐビデオ通話サービス",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
