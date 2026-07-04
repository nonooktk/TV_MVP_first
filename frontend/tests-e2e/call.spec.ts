// M1 自動通話テスト: 家族⇔高齢者の Agora 実通話で相互に映像を受信できることを検証する。
//
// コンテキストA = 家族（Bearer は auth-stub の固定トークン）: /call?call_id=... へ直接遷移
// コンテキストB = 高齢者: localStorage に seed 既知値の device_token を注入して
//                 /elder/standby → 着信表示 → 「でる」をクリック
//
// 判定: 両コンテキストで window.__callState.remoteVideo === true（相手ストリーム受信）。
// さらに家族側の「通話を終了する」で高齢者側が自動で待受へ復帰することも確認する。
//
// 前提（docs/dev-setup.md §12）:
// - docker compose・uvicorn@8000・next dev@3000 が稼働中
// - backend/.env に Agora 実クレデンシャル設定済み（Real プロバイダ）
// - テスト内で backend/scripts/seed.py を実行し、device_token を既知値
//   （dev-device-token）へリセットして device_id を取得する
//
// 実装メモ: next dev の初回コンパイル中はページアセットの取得が中断（ERR_ABORTED）
// されることがあるため、先に高齢者側を開いて「ポーリングが実際に届いている」ことを
// 確認してから発信する（届かない場合は1回だけリロードして再確認する）。

import { execSync } from "node:child_process";
import path from "node:path";
import { Page, expect, test } from "@playwright/test";

const API_BASE = "http://localhost:8000";
const FAMILY_TOKEN = "dev-fixed-token"; // lib/auth-stub.ts の固定トークン
const DEVICE_TOKEN = "dev-device-token"; // seed.py が毎回この既知値へリセットする

/** seed.py を実行して device_id を取得する（トークンも既知値へリセットされる）。 */
function seedAndGetDeviceId(): string {
  const backendDir = path.resolve(__dirname, "../../backend");
  const out = execSync(".venv/bin/python scripts/seed.py", {
    cwd: backendDir,
    encoding: "utf-8",
  });
  const m = /device_id\s*:\s*([0-9a-f-]{36})/.exec(out);
  if (!m) throw new Error("seed.py の出力から device_id を取得できませんでした");
  return m[1];
}

/** 待受ページのポーリング（GET /calls/incoming 200）が届くまで待つ。 */
async function waitForIncomingPoll(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForResponse(
    (r) => r.url().includes("/calls/incoming") && r.status() === 200,
    { timeout: timeoutMs }
  );
}

test("家族と高齢者が実通話でつながり相互に映像を受信する", async ({ browser }) => {
  // --- 準備: seed（デバイストークンを既知値へリセット） ----------------------
  const deviceId = seedAndGetDeviceId();

  // --- コンテキストB: 高齢者側 /elder/standby を先に開き、疎通を確認 ----------
  const ctxElder = await browser.newContext();
  const pageElder = await ctxElder.newPage();
  await pageElder.addInitScript(
    (token) => localStorage.setItem("device_token", token),
    DEVICE_TOKEN
  );
  await pageElder.goto("/elder/standby");
  try {
    await waitForIncomingPoll(pageElder, 20_000);
  } catch {
    // 初回コンパイルでアセット読込が中断された場合に備えて1回だけリロード
    await pageElder.reload();
    await waitForIncomingPoll(pageElder, 20_000);
  }

  // --- 発信（API 直接） ------------------------------------------------------
  const res = await fetch(`${API_BASE}/calls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FAMILY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device_id: deviceId }),
  });
  expect(res.status).toBe(201);
  const call = (await res.json()) as { id: string };

  const joinStartedAt = Date.now();

  // --- コンテキストA: 家族側 /call（POST /tokens/call → Agora join・publish）--
  const ctxFamily = await browser.newContext();
  const pageFamily = await ctxFamily.newPage();
  await pageFamily.goto(`/call?call_id=${call.id}`);

  // --- 高齢者: 着信表示（ポーリング3秒） → 「でる」 ---------------------------
  const answerButton = pageElder.getByRole("button", { name: "でる" });
  await expect(answerButton).toBeVisible({ timeout: 20_000 });
  await answerButton.click();

  // --- 判定: 両側で相手ストリームを受信（remoteVideo === true） --------------
  await pageFamily.waitForFunction(
    () => (window as any).__callState?.remoteVideo === true,
    undefined,
    { timeout: 60_000 }
  );
  await pageElder.waitForFunction(
    () => (window as any).__callState?.remoteVideo === true,
    undefined,
    { timeout: 60_000 }
  );
  const bothConnectedMs = Date.now() - joinStartedAt;
  console.log(`両側 remoteVideo=true まで: ${bothConnectedMs}ms（Agora 実接続）`);

  // --- 終了系: 家族が「通話を終了する」→ 高齢者は自動で待受へ復帰（WF-01④） ---
  // M2 以降、家族側は終了後に検知産物を同期する。fake 音声は定常トーンで発火しない
  // ため同期対象は0件となり、候補を待たずホーム（/）へ戻る（検知の発火～/select は
  // detection-chain.spec.ts で forceTrigger により検証する）。
  await pageFamily.getByRole("button", { name: "通話を終了する" }).click();
  await pageFamily.waitForURL("/", { timeout: 30_000 });
  await expect(pageElder.getByText("つながっています")).toBeVisible({
    timeout: 20_000,
  });

  // 高齢者側の通話状態も解放されている（joined=false）
  await pageElder.waitForFunction(
    () => (window as any).__callState?.joined === false,
    undefined,
    { timeout: 10_000 }
  );

  await ctxFamily.close();
  await ctxElder.close();
});
