# E2Eデモ台本（支給物A9）

> **ステータス注記（2026-07-05 更新・STT 完了）**: 本書は RFP 12章（検収条件）の判定手順書である。
> **M1（通話=Agora実接続）・M2（検知コア②＝感情検知・自動キャプチャ＋通話後同期）・
> STT（Azure Speech 感情ワード検知＝削減ラダー②解除）とも実装済み**。
> 通話（ステップ2〜3）・自動キャプチャ（ステップ3）・終了と同期（ステップ4）はいずれも
> 正式手順で判定できる。検知の発火は実発話（役者が声量を上げる／感情ワードを言う）で起こせるほか、
> テスト用フック `window.__detection.forceTrigger()`（実発火と同経路）でも起こせる。
> フルチェーンは Playwright E2E（`frontend/tests-e2e/detection-chain.spec.ts`）で自動判定済み
> （`docs/dev-setup.md` §12）。**STT（発話キーワード）は 2026-07-05 に実装済み**
> （実発話で「かわいいね」等の感情ワードを言うと `trigger_reason="stt"` で発火し得る。
> Playwright は STT 無効=Fake トークン経路で走る）。音声 look-back はチャンク結合方式（後述）。
> 疑似E2E版の通し実施は 2026-07-03、M1/M2 の自動E2Eは 2026-07-04、STT は 2026-07-05 に完了。

## RFP 12章（検収条件）との対応

RFP（コア技術外部委託バージョン）12章の動作基準と本書ステップの対応:

| RFP 12章の基準 | 判定ステップ | 現時点の判定可否 |
| --- | --- | --- |
| コア①: 両側Chromeで1対1通話が成立する | 2〜3 | ✓ 判定可（M1済み。Playwright 自動通話テストで両側の相手ストリーム受信を確認） |
| コア①: 待受ページが発信を検知して「でる」を表示し、タップで入室できる | 2 | ✓ 判定可（「でる」→ 実チャンネル入室・双方向映像まで） |
| コア①: 初回登録リンクは期限切れ・使用済みでは登録できない | 1 | ✓ 判定可 |
| コア①: トークンがサーバ経由で発行され、秘密キーがコード・リポジトリに含まれない | 2 | ✓ 判定可（Real プロバイダで実トークン発行。`grep -rn AGORA_APP_CERTIFICATE`（node_modules 等除く）で参照が settings 経由のみ・非空代入なし・`.env` は .gitignore 対象であることを確認済み〈2026-07-04〉） |
| コア②: 初期値パラメータで発火 → 連写10枚＋音声スニペットがIndexedDBに保存される | 3 | ✓ 判定可（M2済み。フルチェーンE2Eで連写10枚＋音声スニペット1件を IndexedDB に確認。音声 look-back はチャンク結合方式=先頭ヘッダ＋発火前2秒〜後3秒を素朴結合。**STT は 2026-07-05 に実装済み**＝感情ワードヒットで `trigger_reason="stt"` 発火・RMS と共有クールダウン4秒） |
| コア②: look-back により発火前のコマが含まれる | 3 | ✓ 判定可（M2済み。映像 look-back＝発火前バッファ由来コマが metadata.lookback=true 付きで連写に前置される。E2E で look-back コマを確認） |
| コア③: 通話終了後、候補ランキングが提示される | 4〜5 | ✓ 判定可（候補はダミー画像） |
| コア③: 5分無選択で上位5枚に自動確定する | 5 | ✓ 判定可 |
| コア③: タイトル・キャプション付きBGM入り動画（MP4）がBlobに生成されDB登録される | 6 | △ MP4生成・DB登録は判定可。タイトルは定型・キャプション/BGM実音源は未接続 |
| コア③: 家族の閲覧UIと高齢者側待受ページの双方で再生できる | 7 | ✓ 判定可 |
| 共通: E2Eデモが通しで成功する | 1〜7 | ✓ 判定可（M1/M2 済み。通話→検知発火→キャプチャ→同期→候補→選択→動画ready をフルチェーンE2Eで自動判定。BGM/vision キャプションは A12/Azure OpenAI 取得後） |

検知の精度・発火頻度の適切さは検収対象外（RFP 7章）。

## 前提

- ローカル環境が `docs/dev-setup.md` §1〜6 の手順で稼働していること
  （docker compose = postgres@5433＋Azurite、マイグレーション適用、seed 投入、
  uvicorn @8000、`frontend/` で `npm run dev` @3000）。
- （2026-07-05 更新）発信の device_id はサーバ自動解決になったため、
  `NEXT_PUBLIC_DEFAULT_DEVICE_ID` の設定は不要（設定されていても参照されない）。
- 以下のコマンド例で使う変数:

```bash
BASE=http://localhost:8000
FAMILY="Authorization: Bearer dev-fixed-token"   # 家族側（auth-stub の固定トークン）
DEVICE="X-Device-Token: dev-device-token"        # 高齢者側（seed が既知値にリセット）
```

- 注意: ステップ1のデバイス登録を実施するとデバイストークンがローテーションされ、
  `dev-device-token` での API 直叩きは 401 になる。復旧は `python scripts/seed.py` の再実行
  （ただしブラウザ localStorage 側のトークンが逆に無効になるため、UI 確認中は再実行しない）。

---

## 1. 初回登録

**操作手順**
1. 家族（owner）: http://localhost:3000/ を開き、画面下部の「相手の設定」をクリック。
2. モーダルに登録リンク `http://localhost:3000/elder/register?token=...` が表示される
   （API: `POST /links/register`）。「URLをコピー」で控える。
3. 高齢者側（役者）: 別ブラウザ/別プロファイルの Chrome でそのURLを開く。
   `/elder/register` が `POST /devices/register` に registration_token を渡し、
   受け取った device_token を localStorage に保存して `/elder/standby` へ自動遷移する。
4. 否定系の確認（コピペ可。<TOKEN> は手順2のリンクの token 値）:

```bash
# 使用済みリンクの再利用 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/devices/register \
  -H 'Content-Type: application/json' -d '{"registration_token":"<TOKEN>"}'
# でたらめなトークン → 401
curl -s -w "\n%{http_code}\n" -X POST $BASE/devices/register \
  -H 'Content-Type: application/json' -d '{"registration_token":"invalid-token-xxxx"}'
```

**期待結果（検収観測点）**
- リンク発行が 201 で `url` / `expires_at` / `one_time: true` を返す。
- 登録成功時、「とうろく できました」表示ののち待受画面へ遷移し、
  localStorage `device_token` にトークンが保存される。
- 待受画面に大きな時計・日付・「● つながっています」が表示される。
- **使用済み・不正・期限切れの登録トークンでは登録できない（401、
  `{"detail":{"code":"invalid_token", ...}}`）**。［RFP12 コア①］
- 未登録ブラウザで `/elder/standby` を直接開くと「まだ とうろく されていません」を表示する。

**現時点の代替**: なし（本ステップは実装済みの正式経路そのもの）。

---

## 2. 発信・着信「でる」

**操作手順**
1. 家族: ホームの「📞 母に電話」をクリック（API: `POST /calls`。
   device_id は送らず、サーバが active なデバイスへ自動解決する。2026-07-05 更新）。
   `/call?call_id=...` へ遷移する。
   ※ API 直接でも可:

```bash
curl -s -X POST $BASE/calls -H "$FAMILY" -H 'Content-Type: application/json' -d '{}'
```

2. 家族側: `/call` 遷移直後にカメラ/マイクの許可を求められるので許可する
   （`POST /tokens/call` → Agora チャンネルへ join・自映像を publish。uid=1）。
   拒否した場合は「カメラとマイクの利用を許可してください」画面（WF-02例外）に
   なることも確認する（ブラウザ設定で許可に変更 →「許可して再開」で復帰）。
3. 高齢者側: `/elder/standby` が 3秒ごとの `GET /calls/incoming` ポーリングで着信を検知し、
   全画面の着信表示に切り替わる。
4. 「でる」をタップ（API: `POST /calls/{call_id}/answer`、X-Device-Token 認証。
   応答の `app_id` / `token` / `channel_name` / `uid`(=2) で Agora チャンネルへ入室し、
   自分の映像/音声も publish する）。

**期待結果（検収観測点）**
- `POST /calls` が 201。`status: calling`、`channel_name` はサーバが通話ごとに
  ローテーション生成した値（クライアント指定不可）。
- 待受が5秒以内（ポーリング間隔3秒）に「テスト家族 から でんわが きています」＋
  巨大な緑「でる」ボタンに切り替わる。**「ことわる」ボタンは存在しない**（仕様）。
- 「でる」タップで `answer` が 200 を返し、入室用の短命トークン
  （`token` / `channel_name` / `uid` / `expires_at` / `app_id`）を返す。
  **トークンはサーバ経由で発行され、秘密キーはコード・リポジトリに含まれない**。［RFP12 コア①］
- **両側Chromeで1対1通話が成立する**: 家族側は相手映像が大きく＋自映像の小窓、
  高齢者側は相手映像が全画面＋「きる」控えめ配置（WF-01③）で、双方向に
  実映像・実音声が流れる。［RFP12 コア①］
- 着信は「作成から120秒以内の calling」のみ返る（失効仕様）。放置した発信が
  121秒後に待受へ表示され続けないことも確認できる。
- DB: `calls.status = active`、`started_at` 記録。以降 `GET /calls/incoming` は
  `{"incoming": false}` に戻る（着信解消）。
- uid ルール: 家族=1・高齢者=2（M2 の検知は uid=2 の高齢者ストリームに接続する布石）。

**現時点の代替**: なし（M1 実装済みの正式経路そのもの）。
※ 自動化版: `frontend/tests-e2e/call.spec.ts`（`docs/dev-setup.md` §12）が
本ステップ〜通話終了までを Playwright で自動判定する（両側で相手ストリーム受信を assert）。

---

## 3. 通話・自動キャプチャ（M2 正式手順）

家族側ブラウザで検知（RMS音圧=主トリガー＋MediaPipe 表情＋**Azure Speech STT=安全網・感情ワード**）が
稼働する。検知は `modules/call/agoraCall.ts` の `onRemoteMediaStreamTrack`（uid=2 の高齢者
ストリーム）から video/audio を受け取り、`modules/detection/attachDetection` で配線される。
発火時に連写10枚＋look-backコマ＋音声スニペットを IndexedDB へ保存する。

**操作手順（実発話で発火）**
1. ステップ2で成立した実通話を継続する（相互の実映像・実音声）。
2. 家族側 `/call` の上部バッジが「● AI記録中」（検知稼働）になっていることを確認する。
3. 高齢者側の役者が声量を上げる（`docs/detection-params.md` の初期値パラメータで発火する）。
   発火するとバッジが緑「● 記録中！」に短くフラッシュし、「思い出を記録しました（N）」の
   カウントが増える。
4. Chrome DevTools → Application → IndexedDB → `tvmvp-detection` → `photos` / `audio` で
   保存内容を確認する（`photos` に連写10枚＋look-backコマ、`audio` に音声スニペット1件）。

**操作手順（STT=感情ワードで発火）**: 高齢者側の役者が感情ワード（「かわいいね」「大きくなったね」
「すごいね」「おめでとう」「ありがとう」等・辞書は `docs/detection-params.md`）を発話する。
Azure Speech（`ja-JP` 連続認識）がヒットを検出すると `trigger_reason="stt"` で発火し、
写真 `metadata` に `stt_text`（直近約10秒の認識テキスト）と `stt_labels`（ヒット語）が付く。
STT発火は RMS発火と**共有クールダウン（4秒）**を持つ（直後の連打はしない）。
※ Speech キー未設定（Fake トークン）や SDK ロード失敗では STT は無効のまま（best-effort・
通話と RMS検知は継続）。`window.__detection.state.stt.enabled` で有効/無効を確認できる。

**操作手順（テスト用フックで発火）**: 実発話の代わりに、家族側 `/call` の DevTools
Console で `await window.__detection.forceTrigger()` を実行する（実発火と同じ経路を通り、
連写＋音声スニペット構成＋IndexedDB 保存まで同一）。自動E2Eはこの経路を使う。

**期待結果（検収観測点）**
- **発火 → 連写10枚＋音声スニペットが IndexedDB に保存される**。［RFP12 コア②］
  写真は `metadata`（`rms_db` / `rms_rise` / `face_score` / `trigger_reason` / `lookback`）＋
  `captured_at` 付き。音声スニペットは webm（Chrome=opus）。
- **look-back（発火前リングバッファ）により発火前のコマが含まれる**（`metadata.lookback=true`）。［RFP12 コア②］
- 通話中はクラウドへの候補送信が発生しない（同期は通話終了後。DevTools Network で確認）。
- 通話画面に AI 処理インジケーター（「● AI記録中」バッジ・発火時フラッシュ・記録カウント）が表示される。

**注記**
- STT（発話キーワード）は **2026-07-05 に実装済み**（削減ラダー②解除）。感情ワードヒットで
  `trigger_reason="stt"` 発火・`stt_text`/`stt_labels` を付与。`azureSttProvider.ts`＋辞書は
  `sttConfig.ts`（`EMOTION_WORDS`）。best-effort のため Speech 未設定時は STT 無効で `rms` のみ。
- MediaPipe FaceLandmarker のロードに失敗しても検知は止まらず face_score=0 で継続する
  （best-effort）。WASM/モデルは `frontend/public/mediapipe/` からローカル配信する
  （CDN依存なし。手順は `frontend/src/modules/detection/README.md`）。

---

## 4. 終了・同期（M2 正式手順）

通話終了時、家族側 `/call` が自動で `modules/sync/syncCallMedia(callId)` を実行する
（IndexedDB → Blob アップロード → `POST /media/register` → 受領確認後にローカル削除）。

**前提（ローカル=Azurite のみ）**: ブラウザから SAS URL へ直接 Blob を PUT するため、
ストレージ側の CORS 設定が必要（本番=Azure では A1 の担当）。ローカルは1回だけ設定する:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
.venv/bin/python scripts/set_blob_cors.py   # 許可オリジン http://localhost:3000（冪等）
```

**操作手順**
1. 高齢者側「きる」／家族側「通話を終了する」で通話を終了する
   （leave ＋ `POST /calls/{call_id}/end`。家族 Bearer・デバイス X-Device-Token の
   どちらの認証でも呼べる・冪等。`calls.status = ended`・`ended_at` 記録）。
2. 家族側は「思い出を準備中…」表示のまま自動で同期する。同期完了後、候補の準備を待って
   `/select?call_id=...` へ自動遷移する（候補未生成=`GET candidates` が 404/409 の間は
   「候補を準備中…」で3秒ポーリング）。**発火が1件も無かった通話では候補が生成されないため
   ホーム（`/`）へ戻る**。
3. 高齢者側は通話終了で待受へ自動復帰する（WF-01④）。
4. 同期し切れなかった残置分（IndexedDB に残った通話）は、家族ホーム（`/`）を開いた際に
   `modules/sync/syncPendingCalls()` が自動再同期する（「前回の思い出を同期しています…」を
   控えめに表示）。

**API 直接で確認したい場合（任意）**: `POST /media/upload-sas` → SAS URL へ PUT →
`POST /media/register` を手で叩いても同じ経路を確認できる:

```bash
CALL_ID=<手順1で発信した call_id>
curl -s -X POST $BASE/media/upload-sas -H "$FAMILY" -H 'Content-Type: application/json' \
  -d "{\"call_id\":\"$CALL_ID\",\"filenames\":[\"candidates/a.jpg\"]}"
# → items[].upload_url へ x-ms-blob-type: BlockBlob を付けて PUT した後、登録:
curl -s -X POST $BASE/media/register -H "$FAMILY" -H 'Content-Type: application/json' \
  -d "{\"call_id\":\"$CALL_ID\",\"items\":[{\"type\":\"photo\",\"storage_key\":\"<items[].storage_key>\",\"captured_at\":\"2026-07-03T00:00:00Z\",\"metadata\":{\"rms_rise\":4.0,\"face_score\":0.5}}]}"
```

**期待結果（検収観測点）**
- `upload-sas` が 200。SAS は当該通話のプレフィックス
  `families/{family_id}/calls/{call_id}/` 限定・有効期限1時間（`docs/data-contract.md` §2）。
- 各 Blob が SAS URL へ PUT される（photo=candidates/{uuid}.jpg・audio=snippets/{uuid}.webm）。
- `media/register` が 201 で `memory_ids`（items と同順）を採番する。同期成功後、
  該当通話の IndexedDB レコードが削除される。
- `calls.status = ended` を保証して `score` ジョブが `pipeline-jobs` キューへ投函される。
- 失敗はステップ単位で最大3回リトライ。最終失敗時はデータを残し、次回ホーム表示で再同期される。

**注記（割り切り）**
- 音声スニペットは MediaRecorder のチャンク結合方式（先頭ヘッダチャンク＋発火前2秒〜後3秒の
  区間チャンクを素朴に Blob 結合）。厳密なタイムスライス境界一致はしないが、用途
  （ラベリング・写真単体閲覧時の再生）には十分（`audioPipeline.ts` 冒頭コメント参照）。

---

## 5. 候補提示・5枚選択（5分自動確定含む）

**操作手順（手動選択経路）**
1. worker を1回実行して score を処理する:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
.venv/bin/python ../worker/main.py --once
```

2. 家族: `http://localhost:3000/select?call_id=<CALL_ID>` を開く
   （API: `GET /calls/{call_id}/candidates`）。
3. 候補サムネイルを5枚タップして選択し、「これで確定」を押す
   （API: `POST /calls/{call_id}/selection`）。

**操作手順（自動確定経路）**: 選択せず、遅延短縮で auto_confirm を処理する:

```bash
# score 処理時に auto_confirm の可視化遅延を5秒へ短縮（既定300秒=5分）
AUTO_CONFIRM_DELAY_SECONDS=5 .venv/bin/python ../worker/main.py --once
sleep 6   # 可視化を待つ
.venv/bin/python ../worker/main.py --once   # auto_confirm → render を処理
```

**期待結果（検収観測点）**
- **通話終了（同期）後、候補ランキングが提示される**。［RFP12 コア③］
  `GET candidates` が 200 で `album_id` / `auto_confirm_at`（提示から5分後）/
  rank 昇順・score 降順の候補一覧（閲覧用 `sas_url` 付き）を返す。
- 無表情ゲート: `face_score` が閾値未満の候補は score=0.0 で最下位に落ちる。
- 選択UI: 「自動確定まで 残り M分SS秒」のカウントダウン表示。5枚選ぶまで
  「これで確定」は無効。**6枚目のタップは無視される（5枚上限）**。
- 確定成功で 200。`albums.status = generating`、`confirmed_at` 記録、
  `auto_confirmed = false`、`render` ジョブ投函。
- **提示から5分間無選択の場合、上位5枚（スコア順）で自動確定し
  `auto_confirmed = true` になる**（可視化遅延300秒の auto_confirm メッセージによる。
  `docs/data-contract.md` §4）。家族が先に確定済みなら auto_confirm は何もしない（冪等）。［RFP12 コア③］
- 生成中（generating）の再確定は 409。ready 後の再確定は差し替え（動画再生成・version+1）。

**現時点の代替**
- 候補の中身はダミー画像（正式にはコア②の連写キャプチャ）。選択・自動確定の
  ロジック自体は本実装であり、判定に代替はない。
- デモでは5分待ちを `AUTO_CONFIRM_DELAY_SECONDS` で短縮してよい
  （検収では既定300秒のまま実時間で確認する）。

---

## 6. 動画生成

**操作手順**
1. worker を1回実行して render を処理する:

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP/backend
.venv/bin/python ../worker/main.py --once
```

2. 生成物を検証する:

```bash
# アルバム状態の確認（家族の一覧APIから該当 call_id の video_sas_url を取得）
curl -s "$BASE/albums?limit=100" -H "$FAMILY"
# ダウンロードして ffprobe 検証
curl -s "<video_sas_url>" -o /tmp/e2e_v1.mp4
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name -of json /tmp/e2e_v1.mp4
```

**期待結果（検収観測点）**
- `albums.status = ready`、`version` が +1（初回は 1）、タイトル付与。
- **約30秒・h264（映像）/aac（音声）の MP4 が Blob に生成され、DB に登録される**。
  `video_storage_key = families/{family_id}/calls/{call_id}/albums/v{version}.mp4`。［RFP12 コア③］
- 再生成時は既存ファイルを上書きせず新しい `v{version}.mp4` を作る（`docs/data-contract.md` §2）。
- 未選択候補の Blob に `delete_after` タグ（確定から7日後）が付与される。
  選択された5枚と動画は削除対象にしない。

**現時点の代替**
- タイトルは定型（「YYYY年M月D日の思い出」）。**Azure OpenAI（vision）による
  タイトル・キャプション生成は未接続**（アカウント取得後に差し替え）。
- **BGM は実音源未支給（A12）のため無音トラック**（`worker/assets/bgm/` に配置すれば
  ループ付与される実装は済み）。
- FFmpeg はクロスフェード版・失敗時 concat 簡易版フォールバック（`docs/ffmpeg-commands.md`）。

---

## 7. 家族閲覧・高齢者待受再生

**操作手順**
1. 家族: `http://localhost:3000/album` を開く。動画を再生し、5枚スタックの写真を
   タップして拡大表示する。「動画｜コラージュ」タブを切り替え、コラージュを
   タップして拡大表示する。
2. 家族: 生成中のアルバムがある場合、「思い出のムービーを作成中…」カード（スピナー付き）が
   表示され、5秒間隔の自動更新で完成後に ready カード（動画・コラージュ）へ切り替わる
   ことを確認する。
3. 家族: 任意の ready アルバムの「このアルバムを削除」→ 確認ダイアログ
   （「このアルバムを削除しますか？動画・コラージュ・選ばれた5枚の写真も完全に削除され、
   元に戻せません」）→「削除する」で一覧から消えることを確認する
   （API: `DELETE /albums/{album_id}`・owner のみ・204・不可逆）。
4. 家族: ホーム（`/`）に戻り、新着バナーとハイライト一覧（カードから
   `/album?highlight=<album_id>` で該当アルバムへ遷移）を確認する。
5. 高齢者側: `/elder/standby` の「さいきんの おもいで を みる」をタップ
   （API: `GET /albums/latest`、X-Device-Token 認証）。

**期待結果（検収観測点）**
- 家族閲覧UI: 日付見出しごとにアルバムが並び、状態別カードで表示される。
  - `awaiting_selection`: 「ベストショットの選択待ち」＋選択ページへのボタン
  - `generating`: 「思い出のムービーを作成中…（目安30秒〜1分）」＋スピナー。
    5秒間隔ポーリングで ready になると自動でカードが切り替わる
  - `ready`: 「動画｜コラージュ」タブ切替（コラージュ未生成時はタブ非表示＝動画のみ）＋
    選択5枚のサムネスタック（thumb 未生成時は原寸に自動フォールバック）＋削除ボタン
- 写真タップで拡大モーダル（原寸表示）。コラージュタップで拡大。
- アルバム削除: 確認ダイアログ→204→一覧から即時除去（動画・コラージュ・確定5枚の
  Blob と memories 行も削除。音声スニペット・call 行は残る）。
- ホームに「あたらしい思い出がとどきました」バナー（最新アルバムの確定が24時間以内のとき）。
  generating のアルバムがあれば「思い出を作成中…」バナー。
- 高齢者待受: 当該デバイスに紐づく**最新の ready アルバム**の動画が全画面で自動再生され、
  「とじる」で待受に復帰する。まだ無い場合は「まだ おもいでは ありません」。
- **家族の閲覧UIと高齢者側待受ページの双方で再生できる**。［RFP12 コア③］

**現時点の代替**: なし（実装済みの正式経路そのもの）。
※ 実装注記（2026-07-05 更新）: 閲覧UIの写真スタックは `GET /albums` の `photos`
（確定5枚・thumb_sas_url/sas_url）を直接使う（v0.5.0・API呼び出しは一覧1回。
旧 `GET /calls/{call_id}/candidates` 突合＝N+1 は撤去済み）。

---

## 付録: 疑似E2E一巡の実施記録（2026-07-03）

ローカル環境（docker compose＋uvicorn@8000＋next dev@3000・seed済み）で
本書の全ステップを一巡し、すべて成功した。

| ステップ | 結果 | 主な観測値 |
| --- | --- | --- |
| 1. 初回登録 | 成功 | リンク発行→登録→待受遷移。使用済み/不正トークンとも 401 |
| 2. 発信・着信 | 成功 | 着信表示≦5秒・「でる」で 200・status=active・incoming 解消 |
| 3. 通話（ダミー） | 成功 | 家族側=ダミー通話画面・高齢者側=「つうわちゅう」＋経過時間、「きる」で待受復帰 |
| 4. 終了・同期（代替） | 成功 | demo_pipeline＋個別手順の両方で upload-sas→PUT→register→score 投函 |
| 5. 候補提示・選択 | 成功 | 8候補提示・無表情ゲート score=0・UI 5枚選択確定（6枚目無視）・自動確定経路 auto_confirmed=true |
| 6. 動画生成 | 成功 | ready・v1.mp4・duration=30.0s・h264/aac・1920x1080・delete_after 3件付与 |
| 7. 双方閲覧 | 成功 | 閲覧UIで動画再生・5枚スタック・拡大表示。待受から最新 v1.mp4 を自動再生 |

`scripts/demo_pipeline.py` の統合検証（手動選択・自動確定の両経路＋ffprobe 検証）も同日パス。
