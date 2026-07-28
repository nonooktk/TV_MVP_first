// ルートレイアウト（内製）
// 2026-07-28 S4: 書体を明朝（Zen Old Mincho）へ全面統一した。本文・説明文＝400、
// ボタン・強調・高齢者側の大きな文字＝700。ウェイトは 400/700 の2種のみ。
// UIフレームワークは使わず、グローバルCSS1枚のみ読み込む。

import { Zen_Old_Mincho } from "next/font/google";
import "./globals.css";

// 日本語フォントは unicode-range で細かく分割配信される（Zen Old Mincho は 244 スライス）。
// preload: false にして「見出しに実際に使われた字だけ」を遅延取得させる
// （全スライスを preload すると初期ロードが数MB規模になるため必須）。
// subsets は指定しない: Google Fonts は Zen Old Mincho に "japanese" という名前付き
// サブセットを持たず（利用可能なのは cyrillic/greek/latin/latin-ext のみ）、日本語字形は
// サブセット名とは無関係に unicode-range スライスとして配信される。next/font 側でも
// subsets は preload:true のときのプリロード対象選択にしか使われないため、
// preload:false の本設定では指定不要（指定すると型エラー＋ビルドエラーになる）。
// next/font はビルド時に /_next/static/media へセルフホストされるため、
// 外部 CDN 参照は発生せず現行 CSP（font-src 'self'）のままで通る。
// ウェイトは 400（本文・説明文・ワードマーク・日付見出し）と 700（ボタン・強調・
// 高齢者側の大きな文字）の 2 種のみ。S4 で一度 500 を追加したが、フォント CSS が
// 描画ブロッキングのまま gzip +30KB（+50%）増えて初回表示を損なうため取りやめた
// （SWA Free は静的アセットを 40〜70KB/s に throttle する既知事象）。600/900 も追加しない。
const zenOldMincho = Zen_Old_Mincho({
  weight: ["400", "700"],
  display: "swap",
  preload: false,
  variable: "--font-zen-old-mincho",
});

export const metadata = {
  title: "おもひでてれび",
  description: "おもひでてれび — 離れて暮らす家族をつなぐビデオ通話と、思い出のアルバム",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={zenOldMincho.variable}>
      <body>{children}</body>
    </html>
  );
}
