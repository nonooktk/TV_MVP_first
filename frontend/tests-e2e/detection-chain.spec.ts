// M2 フルチェーンE2E: 実通話 → 検知発火（forceTrigger）→ IndexedDB キャプチャ →
// 通話終了で同期 → memories 作成 → worker score → candidates → 5枚選択 →
// worker render → album ready、までを1本で自動判定する。
//
// M1 の call.spec.ts の接続部（seed・待受ポーリング・両側 remoteVideo）を再利用する。
//
// 前提（docs/dev-setup.md §12 と同じ）:
// - docker compose・uvicorn@8000・next dev@3000 稼働中、backend/.env に Agora 実クレデンシャル。
// - backend/.venv に依存導入済み（worker を child_process で --once 実行するため）。

import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { Page, expect, test } from "@playwright/test";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:8000";
const FAMILY_TOKEN = "dev-fixed-token"; // lib/auth-stub.ts の固定トークン
const DEVICE_TOKEN = "dev-device-token"; // seed.py が毎回この既知値へリセットする

const BACKEND_DIR = path.resolve(__dirname, "../../backend");
const WORKER_MAIN = path.resolve(__dirname, "../../worker/main.py");
const VENV_PY = path.resolve(BACKEND_DIR, ".venv/bin/python");

/** seed.py を実行して device_id を取得する（トークンも既知値へリセットされる）。 */
function seedAndGetDeviceId(): string {
  const out = execSync(".venv/bin/python scripts/seed.py", {
    cwd: BACKEND_DIR,
    encoding: "utf-8",
  });
  const m = /device_id\s*:\s*([0-9a-f-]{36})/.exec(out);
  if (!m) throw new Error("seed.py の出力から device_id を取得できませんでした");
  return m[1];
}

/**
 * Azurite の Blob サービスに CORS を設定する（冪等）。
 * modules/sync はブラウザから SAS URL へ直接 PUT するため、ストレージ側 CORS が必須。
 * 本番（Azure）では A1 の担当。ローカル（Azurite）はこのスクリプトで設定する。
 */
function setBlobCors(): void {
  // E2E_BASE_URL で frontend を別ポートに逃がした場合もそのオリジンを許可する。
  const origins = Array.from(
    new Set(["http://localhost:3000", process.env.E2E_BASE_URL ?? ""])
  ).filter(Boolean);
  execSync(
    `.venv/bin/python scripts/set_blob_cors.py --origins ${origins.join(" ")}`,
    {
      cwd: BACKEND_DIR,
      encoding: "utf-8",
    }
  );
}

/** worker を --once で1回実行する（キューが空になるまで処理して終了）。 */
function runWorkerOnce(): void {
  execFileSync(VENV_PY, [WORKER_MAIN, "--once"], {
    cwd: BACKEND_DIR,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

/** 待受ページのポーリング（GET /calls/incoming 200）が届くまで待つ。 */
async function waitForIncomingPoll(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForResponse(
    (r) => r.url().includes("/calls/incoming") && r.status() === 200,
    { timeout: timeoutMs }
  );
}

/** family Bearer で API を叩く小ヘルパ。 */
async function familyApi(
  method: string,
  urlPath: string,
  body?: unknown
): Promise<Response> {
  return fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${FAMILY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("M2 フルチェーン: 発火→IndexedDB→同期→候補→選択→動画readyまで", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  // --- 準備: seed ＋ Blob CORS 設定 -----------------------------------------
  const deviceId = seedAndGetDeviceId();
  setBlobCors(); // ブラウザ直PUT のための CORS（Azurite。本番は A1）

  // --- 高齢者側 standby を先に開き疎通確認 -----------------------------------
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
    await pageElder.reload();
    await waitForIncomingPoll(pageElder, 20_000);
  }

  // --- 発信（API 直接） ------------------------------------------------------
  const createRes = await familyApi("POST", "/calls", { device_id: deviceId });
  expect(createRes.status).toBe(201);
  const call = (await createRes.json()) as { id: string };
  const callId = call.id;

  // --- 家族側 /call へ ------------------------------------------------------
  const ctxFamily = await browser.newContext();
  const pageFamily = await ctxFamily.newPage();
  const logs: string[] = [];
  pageFamily.on("console", (m) => logs.push(m.text()));
  await pageFamily.goto(`/call?call_id=${callId}`);

  // --- 高齢者: 着信 → 「でる」 ----------------------------------------------
  const answerButton = pageElder.getByRole("button", { name: "でる" });
  await expect(answerButton).toBeVisible({ timeout: 20_000 });
  await answerButton.click();

  // --- 両側 remoteVideo=true（相互受信） -------------------------------------
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

  // --- 検知が接続されるのを待つ（家族側 window.__detection.forceTrigger） -----
  await pageFamily.waitForFunction(
    () => typeof (window as any).__detection?.forceTrigger === "function",
    undefined,
    { timeout: 30_000 }
  );
  // 音声リングにチャンクが溜まり、かつ相手映像が連写可能（videoReady）になるまで待つ。
  await pageFamily.waitForFunction(
    () => ((window as any).__detection?.state?.audio?.ringChunks ?? 0) >= 1,
    undefined,
    { timeout: 15_000 }
  );
  await pageFamily.waitForFunction(
    () => (window as any).__detection?.state?.videoReady === true,
    undefined,
    { timeout: 30_000 }
  );

  // MediaPipe FaceLandmarker のロード状況（観測用ログ）。
  const face = await pageFamily.evaluate(
    () => (window as any).__detection?.state?.face
  );
  console.log(
    `MediaPipe face: loaded=${face?.loaded} failed=${face?.failed} loadMs=${face?.loadMs}`
  );

  // --- 修正1 再現/回帰: 表情検知の health が「loading」で固まらない ------------
  // フェイクカメラでも映像フレームはあるため、正常なら loading→（no_face|ok）へ遷移する。
  // 起動タイムアウト（START_TIMEOUT_MS=10s）＋余裕で 15s 以内に loading 以外へ抜ける
  // ことを assert する。以前は video 再生開始やロードのハングで loading のまま固まった。
  await pageFamily.waitForFunction(
    () => (window as any).__detection?.state?.faceHealth !== "loading",
    undefined,
    { timeout: 15_000 }
  );
  const faceHealth = await pageFamily.evaluate(
    () => (window as any).__detection?.state?.faceHealth
  );
  console.log(`表情検知 health（loading 以外へ遷移）= ${faceHealth}`);
  // フェイクカメラ（顔なし）では no_face か ok。少なくとも loading/failed ではない
  // （failed=映像未到達 or ロード失敗＝この環境では起きてはいけない）。
  expect(["no_face", "ok"]).toContain(faceHealth);

  // --- 修正1 回帰: 2回連続 forceTrigger（4秒空けて）→ 2バースト分が保存される ---
  // 「1回発火後に busy が永久化して2回目が動かない」症状の回帰テスト。
  // 1回目の forceTrigger 完了後に busy が false へ戻り、triggerCount が 1、続く2回目
  // （4秒後）でも正常発火して triggerCount が 2 になり、IndexedDB に 2 バースト分が入ることを
  // assert する（onEvent が 2回呼ばれる＝triggerCount で観測）。
  // forceTrigger は実発火と同経路（handleTrigger）を await 完了まで待つ
  // （buildSnippet の postRoll(3s)+timeslice(1s) を含む）。

  // 発火前に busy が false へ落ち着くのを待つヘルパ（改良2で重心/RMS の自動発火が
  // フェイク音声上で起き得るため、競合キャプチャ中に forceTrigger が no-op になるのを避ける）。
  const waitBusyFalse = async (): Promise<void> => {
    await pageFamily.waitForFunction(
      () => (window as any).__detection?.state?.busy === false,
      undefined,
      { timeout: 15_000 }
    );
  };

  // 1回目の発火（自動発火のキャプチャが走っていれば落ち着くまで待ってから）。
  await waitBusyFalse();
  const countBefore1 = await pageFamily.evaluate(
    () => (window as any).__detection?.state?.triggerCount ?? 0
  );
  await pageFamily.evaluate(async () => {
    await (window as any).__detection.forceTrigger();
  });
  await waitBusyFalse();
  // 1回目完了後: busy が解除され triggerCount が 1 増える（＝永久 busy 化していない）。
  const afterFirst = await pageFamily.evaluate(() => ({
    busy: (window as any).__detection?.state?.busy,
    triggerCount: (window as any).__detection?.state?.triggerCount,
  }));
  console.log(
    `1回目発火後: busy=${afterFirst.busy} triggerCount=${afterFirst.triggerCount}（before=${countBefore1}）`
  );
  expect(afterFirst.busy).toBe(false); // busy 解除（永久化していない）
  expect(afterFirst.triggerCount).toBeGreaterThan(countBefore1); // forceTrigger で増える

  // 4秒空ける（クールダウン明けを模す。forceTrigger 自体は共有クールダウン非適用だが、
  // 実運用の連続発火に近づける）。
  await pageFamily.waitForTimeout(4000);

  // 2回目の発火（同様に busy 落ち着き待ち）。
  await waitBusyFalse();
  const countBefore2 = await pageFamily.evaluate(
    () => (window as any).__detection?.state?.triggerCount ?? 0
  );
  await pageFamily.evaluate(async () => {
    await (window as any).__detection.forceTrigger();
  });
  await waitBusyFalse();
  const afterSecond = await pageFamily.evaluate(() => ({
    busy: (window as any).__detection?.state?.busy,
    triggerCount: (window as any).__detection?.state?.triggerCount,
  }));
  console.log(
    `2回目発火後: busy=${afterSecond.busy} triggerCount=${afterSecond.triggerCount}`
  );
  expect(afterSecond.busy).toBe(false);
  // 2回の forceTrigger でそれぞれ triggerCount が増える（＝連続発火が生きている）。
  // ※ 改良2でフェイク音声上の重心/RMS 自動発火も混じり得るため、厳密な 2 ではなく
  //   「1回目の後 → 2回目の後で増える」ことを確認する。
  expect(afterSecond.triggerCount).toBeGreaterThan(afterFirst.triggerCount);

  // --- IndexedDB に「複数バースト分の連写＋look-backコマ」の photo と audio が入る ----
  // 連写(lookback=false)は 10枚×発火回数（自動発火が混じると 20 以上）、
  // look-back(lookback=true)を各発火で含み、音声スニペットも発火ぶん入ることを確認する
  //（RFP12 コア②: 連写10枚＋発火前のコマ）。厳密数は自動発火で揺れるため下限で検証する。
  const counts = await pageFamily.evaluate(async (cid) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open("tvmvp-detection", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    function getByCall<T>(store: string): Promise<T[]> {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const idx = tx.objectStore(store).index("byCall");
        const r = idx.getAll(IDBKeyRange.only(cid));
        r.onsuccess = () => resolve(r.result as T[]);
        r.onerror = () => reject(r.error);
      });
    }
    const photos = await getByCall<{ metadata: { lookback?: boolean } }>("photos");
    const audio = await getByCall<unknown>("audio");
    db.close();
    const burst = photos.filter((p) => p.metadata?.lookback !== true).length;
    const lookback = photos.filter((p) => p.metadata?.lookback === true).length;
    return { total: photos.length, burst, lookback, audio: audio.length };
  }, callId);
  console.log(
    `IndexedDB: photos=${counts.total}（連写${counts.burst}＋look-back${counts.lookback}） audio=${counts.audio}`
  );
  expect(counts.burst).toBeGreaterThanOrEqual(20); // 連写10枚 × 2発火以上（自動発火で増える）
  expect(counts.burst % 10).toBe(0); // 連写は必ず10枚単位で積まれる
  expect(counts.lookback).toBeGreaterThanOrEqual(2); // look-back（発火前コマ）を各発火で含む
  expect(counts.audio).toBeGreaterThanOrEqual(2); // 音声スニペット 2件以上（発火ぶん）
  const totalPhotos = counts.total;
  const totalAudio = counts.audio;

  // --- 家族「通話を終了する」→ 同期完了（__sync.state.done） ------------------
  await pageFamily.getByRole("button", { name: "通話を終了する" }).click();
  await pageFamily.waitForFunction(
    () => (window as any).__sync?.state?.status === "done",
    undefined,
    { timeout: 60_000 }
  );
  const registered = await pageFamily.evaluate(
    () => (window as any).__sync.state.registeredMemories as number
  );
  console.log(`同期 registeredMemories=${registered}`);
  expect(registered).toBe(totalPhotos + totalAudio); // 全 photo + 全 audio（発火ぶん）

  // --- API で memories 作成を確認（candidates 前は album 未作成なので media 側で確認） ---
  // score 実行前に candidates は 404。まず worker score を回す。
  runWorkerOnce();

  // --- candidates が 200・photo 全数（2発火ぶんの連写＋look-back）--------------
  const candRes = await familyApi("GET", `/calls/${callId}/candidates`);
  expect(candRes.status).toBe(200);
  const candList = (await candRes.json()) as {
    album_id: string;
    candidates: Array<{ id: string; type: string; rank: number }>;
  };
  console.log(`candidates=${candList.candidates.length}`);
  // photo のみが候補（audio は候補外）。連写＋look-back の総数と一致する。
  expect(candList.candidates.length).toBe(totalPhotos);

  // --- 5枚選択（選択UI経由: おすすめ一括＋従来タップの入替→確定） --------------
  // 通話終了後の家族ページは候補ポーリング→ /select へ自動遷移している。
  // （next.config の output:'export' により trailing slash 付き /select/?call_id= になる）
  await pageFamily.waitForURL(/\/select\/?\?call_id=/, { timeout: 45_000 });

  // おすすめバッジ（rank 1〜5）が5枚に表示される。
  await expect(
    pageFamily.getByTestId("recommended-badge")
  ).toHaveCount(5, { timeout: 15_000 });

  // 「おすすめの5枚を選ぶ」で rank 1〜5 を一括選択 → 5/5 になる。
  await pageFamily.getByTestId("select-recommended").click();
  await expect(pageFamily.getByText("選択 5 / 5 枚")).toBeVisible();

  // 従来どおりタップで入替できる: rank1 を外し（4/5）→ rank6 を追加（5/5）。
  await pageFamily.locator('img[alt="候補 rank 1"]').click();
  await expect(pageFamily.getByText("選択 4 / 5 枚")).toBeVisible();
  await pageFamily.locator('img[alt="候補 rank 6"]').click();
  await expect(pageFamily.getByText("選択 5 / 5 枚")).toBeVisible();

  // 既存の「これで確定」で確定（POST /calls/{id}/selection は UI が呼ぶ）。
  await pageFamily.getByRole("button", { name: "これで確定" }).click();
  await expect(pageFamily.getByText("選択を確定しました")).toBeVisible({
    timeout: 15_000,
  });

  // album が generating で作成されている。
  const genRes = await familyApi("GET", "/albums?limit=100");
  expect(genRes.status).toBe(200);
  const genAlbums = (await genRes.json()) as {
    items: Array<{ id: string; call_id: string; status: string }>;
  };
  const generating = genAlbums.items.find((a) => a.call_id === callId);
  expect(generating).toBeDefined();
  expect(generating!.status).toBe("generating");

  // --- worker render → album ready -------------------------------------------
  runWorkerOnce();

  const albumsRes = await familyApi("GET", "/albums?limit=100");
  expect(albumsRes.status).toBe(200);
  const albums = (await albumsRes.json()) as {
    items: Array<{ id: string; call_id: string; status: string; version: number }>;
  };
  const target = albums.items.find((a) => a.call_id === callId);
  console.log(`album status=${target?.status} version=${target?.version}`);
  expect(target).toBeDefined();
  expect(target!.status).toBe("ready");
  expect(target!.version).toBeGreaterThanOrEqual(1);

  await ctxFamily.close();
  await ctxElder.close();
});
