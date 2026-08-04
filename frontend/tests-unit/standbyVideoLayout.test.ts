// 待受アルバム動画（[data-testid="standby-album-video"]）のレイアウト契約テスト
//
// 背景（2026-08-04・T3-B1）:
//   video は置換要素のため、絶対配置で width/height:auto を指定すると used value が
//   固有サイズ（worker 生成動画は 1920x1080 固定）になり、4 辺 inset のうち right/bottom が
//   over-constrained として無視される（CSS 2.1 §10.3.8 / §10.6.5）。その結果、
//   Pixel 8 Pro 横向き（892x412）のような小さい画面では動画の右下が画面外へはみ出し、
//   写真が見切れていた（Playwright 実測: 右 1074px・下 714px はみ出し）。
//
// このテストは実際のレイアウト計算を再現するものではなく（node 環境では不可能）、
// 上記の再発につながる CSS の書き方を機械的に禁止するためのガードである。
// 実寸の検証は Playwright（892x412 / 1920x1080 / 1366x768）で別途実施している。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS_PATH = join(__dirname, "../src/app/globals.css");

/** globals.css から待受アルバム動画のルールブロック（宣言部）を取り出す。 */
function readStandbyVideoRule(): string {
  const css = readFileSync(CSS_PATH, "utf8");
  const match = css.match(/\[data-testid="standby-album-video"\]\s*\{([^}]*)\}/);
  if (!match) {
    throw new Error("globals.css に [data-testid=\"standby-album-video\"] のルールが見つかりません");
  }
  return match[1];
}

describe("待受アルバム動画のレイアウト契約（globals.css）", () => {
  it("width/height に auto を使わない（固有サイズ 1920x1080 に固定され小画面で見切れるため）", () => {
    const rule = readStandbyVideoRule();
    expect(rule).not.toMatch(/width:\s*auto/);
    expect(rule).not.toMatch(/height:\s*auto/);
  });

  it("width/height はテレビ枠の内寸（100% - 5.2vw ＝ inset 2.6vw の 2 辺分）に一致する", () => {
    const rule = readStandbyVideoRule();
    // inset:2.6vw で上下左右を空けるので、箱の寸法は「包含ブロック - 2.6vw x 2」になる。
    expect(rule).toMatch(/width:\s*calc\(100%\s*-\s*5\.2vw\)\s*!important/);
    expect(rule).toMatch(/height:\s*calc\(100%\s*-\s*5\.2vw\)\s*!important/);
  });

  it("object-fit は contain（cover だと扁平な枠で上下が削られ写真の顔が切れる）", () => {
    const rule = readStandbyVideoRule();
    expect(rule).toMatch(/object-fit:\s*contain\s*!important/);
    expect(rule).not.toMatch(/object-fit:\s*cover/);
  });

  it("テレビ枠の内側に置く位置（inset: 2.6vw）と角丸（2.2vw）は S2/S3 仕様のまま維持する", () => {
    const rule = readStandbyVideoRule();
    // .elder-shell::before（ブラウン管の画面面）と同じ値であることが意匠上の前提。
    expect(rule).toMatch(/inset:\s*2\.6vw\s*!important/);
    expect(rule).toMatch(/border-radius:\s*2\.2vw\s*!important/);
  });
});
