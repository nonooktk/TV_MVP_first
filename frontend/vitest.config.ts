// vitest 設定（検知ロジックの単体テスト用・M2）
//
// tests-unit/ 配下の *.test.ts を対象にする。純粋ロジック（rmsTrigger 等）のみを
// 対象とし、DOM/WebAudio を要する部分は Playwright E2E 側で検証する。

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests-unit/**/*.test.ts"],
    environment: "node",
  },
});
