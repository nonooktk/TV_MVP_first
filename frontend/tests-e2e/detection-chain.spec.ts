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

const API_BASE = "http://localhost:8000";
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
  execSync(".venv/bin/python scripts/set_blob_cors.py", {
    cwd: BACKEND_DIR,
    encoding: "utf-8",
  });
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

  // --- forceTrigger（実発火と同経路）を1回 -----------------------------------
  // buildSnippet が postRoll(3s)+timeslice(1s) 待つため、await 完了まで待つ。
  await pageFamily.evaluate(async () => {
    await (window as any).__detection.forceTrigger();
  });

  // --- IndexedDB に「連写10枚＋look-backコマ」の photo と audio 1件 ----------
  // 連写(lookback=false)がちょうど10枚、look-back(lookback=true)が1コマ以上含まれることを
  // 確認する（RFP12 コア②: 連写10枚＋発火前のコマが含まれる）。
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
  expect(counts.burst).toBe(10); // 連写ちょうど10枚
  expect(counts.lookback).toBeGreaterThanOrEqual(1); // look-back（発火前コマ）を含む
  expect(counts.audio).toBe(1); // 音声スニペット1件
  const totalPhotos = counts.total;

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
  expect(registered).toBe(totalPhotos + 1); // 全 photo + audio1

  // --- API で memories 作成を確認（candidates 前は album 未作成なので media 側で確認） ---
  // score 実行前に candidates は 404。まず worker score を回す。
  runWorkerOnce();

  // --- candidates が 200・photo 10件 -----------------------------------------
  const candRes = await familyApi("GET", `/calls/${callId}/candidates`);
  expect(candRes.status).toBe(200);
  const candList = (await candRes.json()) as {
    album_id: string;
    candidates: Array<{ id: string; type: string; rank: number }>;
  };
  console.log(`candidates=${candList.candidates.length}`);
  // photo のみが候補（audio は候補外）。連写＋look-back の総数と一致する。
  expect(candList.candidates.length).toBe(totalPhotos);

  // --- 5枚選択（rank 上位5枚） -----------------------------------------------
  const selectedIds = candList.candidates.slice(0, 5).map((c) => c.id);
  const selRes = await familyApi("POST", `/calls/${callId}/selection`, {
    memory_ids: selectedIds,
  });
  expect(selRes.status).toBe(200);
  const album = (await selRes.json()) as { id: string; status: string };
  expect(album.status).toBe("generating");

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
