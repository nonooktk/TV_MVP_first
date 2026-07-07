# データ契約

支給物A5。委託コア③（通話後パイプライン）と内製の境界を固定する、
Blobパス規約およびキューメッセージ形式の確定仕様。

## 1. 目的と適用範囲

本書は、委託コア①〜③と内製の境界のうち、Blob（Azure Blob Storage）とキュー
（Azure Storage Queue）のデータ形式を固定するデータ契約である。

- Blob のパス構造・命名規則・SAS発行方針・ライフサイクル運用は本書が正とする。
- キューメッセージの形式・投函ルール・冪等性・可視性タイムアウト・毒メッセージ処理は本書が正とする。
- 本書の変更には発注側の承認が必要（詳細は「6. 変更管理」）。
- DBスキーマは `docs/db-schema.md` が正。API契約は `docs/api/openapi.yaml` が正。
  本書はその橋渡しとして、DB列（`memories.storage_key` / `albums.video_storage_key`）に
  格納する値の形式と、パイプラインを駆動するキューメッセージの形式を定義する。

## 2. Blobパス規約

### コンテナ

- コンテナ名: `media`
- 非公開コンテナ。パブリックアクセスは禁止し、アクセスは SAS（Shared Access Signature）のみに限定する。

### パス構造

```
families/{family_id}/calls/{call_id}/
├── candidates/{memory_id}.jpg          # 連写候補（JPEG）
├── thumbs/{memory_id}.jpg              # 候補サムネイル（JPEG・幅320px・品質70。第1段で生成）
├── snippets/{memory_id}.webm           # 音声スニペット（WebM/Opus。MediaRecorder標準）
├── albums/v{version}.mp4               # ハイライト動画（MP4: H.264+AAC）
└── albums/collage_v{version}.jpg       # コラージュ画像（JPEG・横1600px・第2段で生成）
```

- **サムネイル（`thumbs/`）**: 第1段（stage1_scoring）が各写真候補の原画像から幅320px・
  JPEG品質70のサムネを生成する（軽量化の本命）。ファイル名は `candidates/` と同じ
  `{memory_id}.jpg`。生成失敗は警告ログでスキップし、候補処理は止めない
  （閲覧側は未生成時に原画像 SAS へフォールバックする）。
- **コラージュ（`albums/collage_v{version}.jpg`）**: 第2段（render）が確定5枚から1枚の
  コラージュ JPEG（横1600px・2行グリッド〈上段2枚・下段3枚〉・白余白）を生成する。
  動画と同じく `version` をパスに含め、再生成時は上書きしない。生成失敗は警告ログのみで
  `albums.collage_storage_key` を null のままにする（動画は成立させる）。

### 命名規則

- パス・ファイル名はすべて小文字。
- ID（`family_id` / `call_id` / `memory_id`）はUUID（ハイフン付き小文字表記。例: `3fa85f64-5717-4562-b3fc-2c963f66afa6`）。
- パスに氏名等のPII（個人を特定しうる文字列）を含めない。

### DB接続

- `memories.storage_key` および `albums.video_storage_key` には、**コンテナ名 `media` を除くフルパス**
  （`families/...` から始まるパス）を格納する。コンテナ名は環境設定（接続文字列・エンドポイント）側で解決する。
- 例:
  - `memories.storage_key` = `families/{family_id}/calls/{call_id}/candidates/{memory_id}.jpg`
  - `albums.video_storage_key` = `families/{family_id}/calls/{call_id}/albums/v{version}.mp4`
  - `albums.collage_storage_key` = `families/{family_id}/calls/{call_id}/albums/collage_v{version}.jpg`
- サムネイル（`thumbs/`）は DB 列を持たない。パス規約（`thumbs/{memory_id}.jpg`）から
  導出して SAS を発行する（存在チェックはしない）。

### バージョニング（動画）

- ハイライト動画は `version` をパスに含める（`v1.mp4`, `v2.mp4`, …）。`version` は `albums.version`
  （int・初期値0・再生成のたびに+1）と一致させる。
- 動画の再生成時は既存ファイルを**上書きしない**。新しい `v{version}.mp4` を新規に作成することで、
  SAS発行済みURLのキャッシュ取り違え（古い動画が表示され続ける事故）を防ぐ。

### SAS（Shared Access Signature）

- SAS の発行は **FastAPI（backend）のみ**が行う。ワーカー・フロントエンドは自ら発行しない。
- 用途別のポリシー:
  | 用途 | 権限 | 有効期限 | スコープ |
  | --- | --- | --- | --- |
  | 閲覧用 | read | **15分** | 対象Blob単位（候補画像・スニペット・完成動画の個別参照） |
  | アップロード用 | create + write | **1時間** | 当該通話のプレフィックス `families/{family_id}/calls/{call_id}/` 限定 |

### ライフサイクル（未選択候補の削除）

- 選択確定時（**自動確定を含む**）に、**未選択**の `candidates/` および対応する `snippets/` の Blob へ、
  ワーカーがインデックスタグ `delete_after`（確定日時から7日後の日付）を付与する。
- 自動削除の実構成（Blobライフサイクル管理ポリシーの設定）はA1（Azure構築）側の担当とする。
  MVP期間中は、ワーカーによる `delete_after` タグ付与までを必須要件とし、実際の削除は手動運用でもよい
  （被験者はチーム内の役者であり、実運用ユーザーのPIIが残留するリスクがないため）。
- **選択された5枚（`memories.status = selected`）と生成済みの動画（`albums` の各バージョン）は削除しない。**

### ライフサイクル（アルバムの完全削除）

`DELETE /albums/{album_id}`（owner のみ・API契約は openapi.yaml v0.5.0）による削除は、
アプリ機能としてのデータ削除であり Azure リソースの削除ではない。削除セマンティクスは次のとおり。

- 削除対象:
  1. `album` 行。
  2. 動画 Blob の**全バージョン**（`albums/v*.mp4`）。
  3. コラージュ Blob（`albums/collage_v*.jpg`）。
  4. **確定5枚**の `memories` 行とその Blob（`candidates/{memory_id}.jpg` と `thumbs/{memory_id}.jpg`）。
- **残すもの**: 音声スニペット（`snippets/`）と `call` 行（および未選択候補の行・Blob。
  これらは `delete_after` タグ運用に委ねる）。
- Blob 削除は**存在しないものをスキップ**する（冪等）。応答は 204。

## 3. キューメッセージ形式

### キュー

- キュー名: `pipeline-jobs`（1本。MVPの処理量では分割不要と判断）。

### エンコード

- Base64エンコード（デコード後の中身は UTF-8 JSON）。Azure SDK（`azure-storage-queue`）の既定挙動に合わせる。

### 共通フィールド

すべてのメッセージに以下を含める。

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `schema_version` | integer | 固定値 `1`。本書の変更管理と対応（「6. 変更管理」参照） |
| `job_type` | string | `score` / `auto_confirm` / `render` のいずれか |
| `requested_at` | string | ISO 8601 UTC（投函時刻） |

### メッセージ3種

```json
{"schema_version": 1, "job_type": "score",        "call_id": "<uuid>",  "requested_at": "<ISO8601>"}
```

```json
{"schema_version": 1, "job_type": "auto_confirm", "album_id": "<uuid>", "requested_at": "<ISO8601>"}
```

```json
{"schema_version": 1, "job_type": "render",       "album_id": "<uuid>", "requested_at": "<ISO8601>"}
```

### 投函ルール

| job_type | 投函者 | タイミング |
| --- | --- | --- |
| `score` | FastAPI | メディア登録（`POST /media/register`）完了時 |
| `auto_confirm` | ワーカー（第1段） | 候補提示（`albums.presented_at` 記録）と同時に、**可視化遅延300秒**（visibility timeoutの初期遅延）で投函 |
| `render` | FastAPI | 家族の選択確定（`POST /calls/{call_id}/selection`）時。自動確定時はワーカー（`auto_confirm`処理内）が投函 |

### 冪等性

キューは再配達され得る前提とし、ワーカーは**処理前に必ずDB状態を確認**してから処理する。

| job_type | skip条件 |
| --- | --- |
| `score` | 対象 `call` に `album` が既に存在し `presented_at` 記録済みなら skip |
| `auto_confirm` | `albums.status` が `awaiting_selection` 以外なら skip（家族が選択済み） |
| `render` | `albums.status` が `generating` の**ときのみ処理**する（`ready`／`awaiting_selection` は skip）。`generating` への遷移は選択確定API（`POST /calls/{call_id}/selection`）または `auto_confirm` 処理が行う |

### 可視性タイムアウト

- キューからのメッセージ取り出し時の可視性タイムアウト: **5分**（処理中の再配達防止）。

### 毒メッセージ（poison message）

- `dequeue_count` が **5** を超えたメッセージは処理せず、以下を行う。
  1. `system/poison/{message_id}.json` として `media` コンテナへ退避する。
  2. キューから削除する。
  3. 発注側へ日次報告する。

## 4. 5分自動確定の実現方式

専用タイマー（cron・スケジューラ等）は作らず、Azure Storage Queueの**可視化遅延**
（visibility delay / initial visibility timeout）を利用して実現する。

1. ワーカー第1段が候補提示を行い、`albums.presented_at` を記録する。
2. 同時に、`auto_confirm` メッセージを**可視化遅延300秒**で `pipeline-jobs` キューへ投函する
   （投函直後はキューから見えず、300秒後に取り出し可能になる）。
3. 5分後、ワーカーがこのメッセージを取り出す。
4. その時点で `albums.status` が `awaiting_selection` のままであれば、上位5枚（スコア順）で確定する
   （`selected_memory_ids` を設定、`auto_confirmed = true`、`confirmed_at` を記録）。
   **このとき `albums.status` を `generating` へ更新する**（家族の選択確定APIと同じ遷移。
   §3「冪等性」の `render` skip 判定はこの状態を前提とする）。
5. 確定後、`render` メッセージを投函する。
6. 家族が5分以内に選択を確定済みの場合、`albums.status` は既に `awaiting_selection` ではないため、
   ワーカーは何もせず終了する（冪等）。

## 5. 付録: metadata 推奨キー

`memories.metadata`（JSONB）に格納する推奨キー。必須ではなく、検知精度向上のための拡張用途を想定した参考情報。

| キー | 説明 |
| --- | --- |
| `rms_db` | 発火時の音圧（RMS、dB） |
| `rms_rise` | baseline比の上昇量 |
| `face_score` | 表情スコア |
| `blendshapes_top` | 上位blendshape名 |
| `stt_text` | 発火前後の認識テキスト |
| `stt_labels` | 感情ワードヒット |
| `spectral_centroid` | 発火時のスペクトル重心（Hz・改良2）。声色（明るさ／高さ）の指標。全写真に付与 |
| `centroid_rise_ratio` | 発火時の重心の基準比（現在値 / 発話中央値・例 1.25＝+25%）。全写真に付与 |
| `trigger_reason` | 発火要因（`rms` / `stt` / `face` / `centroid`） |
| `lookback` | look-back（発火前バッファ由来）か否か（bool） |

> `trigger_reason` の `centroid`（スペクトル重心トリガー・改良2）: 音圧が変わらなくても
> 声色（笑い声・高い声・興奮）で重心が基準比 +20% を 200ms 持続したときの発火。
> `rms`/`stt` と**共有のクールダウン（4秒）**が適用される。worker は reason で分岐しない
> （stage1 のスコアリングは per-photo の rms_rise / face_score を使う。ラベリング文脈では
> `声色の変化` として集計される）。`spectral_centroid` / `centroid_rise_ratio` は発火要因に
> かかわらず全写真へ付与する（発火時点の重心サンプル）。

## 6. 変更管理

- 本契約の変更は、発注側の承認と `schema_version` の増加を伴う。
- `docs/api/openapi.yaml`・`docs/db-schema.md` との整合は発注側がレビューする。
