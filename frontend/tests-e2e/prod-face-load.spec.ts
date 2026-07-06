// 本番ビルド（out/ 静的配信）での表情検知ロード回帰テスト。
//
// 【背景・根因】本番（Azure Static Web Apps Free）は大容量静的アセット（9.4MB WASM・
// 3.7MB モデル）の配信を ~40〜70KB/s に強く throttle するため、当初のローカル配信
// （/mediapipe/）では起動タイムアウト（10s）内にダウンロードできず face health が
// failed（読み込みタイムアウト）で固まった＝実機で「⚠️ 表情検知が停止中」。
// dev はディスク即時配信のため成功し、本番ビルドでのみ再現した。
// 【修正】facePipeline.ts を CDN 優先（jsDelivr WASM＋Google Storage モデル）＋
// ローカル fallback に変更。CDN は同一 9.4MB WASM を約1秒で完走する。
//
// 本テストは **out/（本番ビルド）を :4173 で静的配信**した状態で、フェイクカメラ通話の
// face health が loading/failed で固まらず no_face/ok へ到達すること（＝アセットがロード
// できること）を assert する。dev サーバ（:3000）ではなく本番ビルドを対象にするのが要点。
//
// 前提（docs/dev-setup.md §12-2 参照）:
// - docker compose・uvicorn（CORS に http://localhost:4173 を許可）稼働中、
//   backend/.env に Agora 実クレデンシャル。
// - `next build`（out/ 生成）→ `npx serve out -l 4173` で静的配信中。

import { execSync } from "node:child_process";
import path from "node:path";
import { Page, expect, test } from "@playwright/test";

const PROD_BASE = "http://localhost:4173";
const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:8000";
const FAMILY_TOKEN = "dev-fixed-token";
const DEVICE_TOKEN = "dev-device-token";
const BACKEND_DIR = path.resolve(__dirname, "../../backend");

function seedAndGetDeviceId(): string {
  const out = execSync(".venv/bin/python scripts/seed.py", {
    cwd: BACKEND_DIR,
    encoding: "utf-8",
  });
  const m = /device_id\s*:\s*([0-9a-f-]{36})/.exec(out);
  if (!m) throw new Error("seed.py の出力から device_id を取得できませんでした");
  return m[1];
}

async function waitForIncomingPoll(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForResponse(
    (r) => r.url().includes("/calls/incoming") && r.status() === 200,
    { timeout: timeoutMs }
  );
}

async function familyApi(method: string, urlPath: string, body?: unknown): Promise<Response> {
  return fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${FAMILY_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("本番ビルド: face health が loading/failed で固まらず no_face/ok へ到達する", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const deviceId = seedAndGetDeviceId();

  const ctxElder = await browser.newContext();
  const pageElder = await ctxElder.newPage();
  await pageElder.addInitScript(
    (token) => localStorage.setItem("device_token", token),
    DEVICE_TOKEN
  );
  await pageElder.goto(`${PROD_BASE}/elder/standby/`);
  try {
    await waitForIncomingPoll(pageElder, 20_000);
  } catch {
    await pageElder.reload();
    await waitForIncomingPoll(pageElder, 20_000);
  }

  const createRes = await familyApi("POST", "/calls", { device_id: deviceId });
  expect(createRes.status).toBe(201);
  const call = (await createRes.json()) as { id: string };
  const callId = call.id;

  const ctxFamily = await browser.newContext();
  const pageFamily = await ctxFamily.newPage();
  await pageFamily.goto(`${PROD_BASE}/call/?call_id=${callId}`);

  const answerButton = pageElder.getByRole("button", { name: "でる" });
  await expect(answerButton).toBeVisible({ timeout: 20_000 });
  await answerButton.click();

  await pageFamily.waitForFunction(
    () => (window as any).__callState?.remoteVideo === true,
    undefined,
    { timeout: 60_000 }
  );
  await pageFamily.waitForFunction(
    () => typeof (window as any).__detection?.forceTrigger === "function",
    undefined,
    { timeout: 30_000 }
  );
  await pageFamily.waitForFunction(
    () => (window as any).__detection?.state?.videoReady === true,
    undefined,
    { timeout: 30_000 }
  );

  // 本番ビルドでも起動タイムアウト（10s）内にアセットをロードして loading を抜けること。
  await pageFamily.waitForFunction(
    () => (window as any).__detection?.state?.faceHealth !== "loading",
    undefined,
    { timeout: 15_000 }
  );

  const face = await pageFamily.evaluate(() => (window as any).__detection?.state?.face);
  const faceHealth = await pageFamily.evaluate(
    () => (window as any).__detection?.state?.faceHealth
  );
  console.log(
    `本番ビルド face: loaded=${face?.loaded} failed=${face?.failed} loadMs=${face?.loadMs} source=${face?.source} health=${faceHealth}`
  );

  // フェイクカメラ（顔なし）では no_face か ok。failed（ロード失敗/タイムアウト）や
  // loading（固まり）であってはならない。
  expect(["no_face", "ok"]).toContain(faceHealth);
  expect(face?.loaded).toBe(true);
  expect(face?.failed).toBe(false);
  // アセットは CDN（本番の SWA throttle 回避の本命）から来ているのが期待挙動。
  // CDN 到達不可の環境では local fallback で loaded=true になっていれば合格とする。
  expect(["cdn", "local"]).toContain(face?.source);

  await ctxFamily.close();
  await ctxElder.close();
});
