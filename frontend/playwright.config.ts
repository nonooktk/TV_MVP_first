// Playwright 設定（M1 自動通話テスト用）
//
// Chromium を偽カメラ/マイク（fake device）で起動し、許可ダイアログを自動許可する。
// 前提: backend(uvicorn@8000)・frontend(next dev@3000)・docker compose が稼働中であること
// （起動手順は docs/dev-setup.md）。テストは Agora の実ネットワークに接続する。

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-e2e",
  // Agora 実接続（join〜相互受信）を含むため長めに取る
  timeout: 120_000,
  // 家族/高齢者の2コンテキストを1テスト内で扱うため並列不要
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    launchOptions: {
      args: [
        // 偽のカメラ/マイクデバイスを使う（緑ボールのテストパターン映像＋ビープ音声）
        "--use-fake-device-for-media-stream",
        // getUserMedia の許可ダイアログを自動許可する
        "--use-fake-ui-for-media-stream",
        // 自動再生制限で音声再生がブロックされないようにする
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
