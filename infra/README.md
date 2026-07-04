# infra — Azure 実環境（A1 構築済み）

TV電話MVP のクラウド環境（Azure 東日本）。2026-07-04 に A1 として構築した。
リソースグループは **rg-001-gen12**、サブスクリプションは「Microsoft Azure スポンサー プラン」。
全リソースに `app=tvmvp owner=mitsuru` タグを付与。命名の衝突回避サフィックスは **73bb**。

> 接続情報・秘密（DBパスワード・接続文字列・OpenAIキー）は **`backend/cloud.env`** に集約している
> （`.gitignore` 済み・コミット禁止）。このファイルは A1 で自動生成した。

## 構築済みリソース一覧

| リソース | 名前 | SKU / 構成 | リージョン | 月額目安(USD) |
| --- | --- | --- | --- | --- |
| PostgreSQL Flexible Server | `psql-tvmvp-73bb` | Burstable **B1ms**・32GB・PostgreSQL 16 | japaneast | 約 13〜15 |
| Storage アカウント | `sttvmvp73bb` | Standard **LRS**・Blob(media)＋Queue(pipeline-jobs) | japaneast | 約 1〜3 |
| Container Registry | `acrtvmvp73bb` | **Basic** | japaneast | 約 5 |
| Container Apps 環境 | `cae-tvmvp` | Consumption（Log Analytics 自動作成） | japaneast | 環境自体は無料（従量） |
| Container App: API | `ca-tvmvp-api` | 外部Ingress:8000・0.5CPU/1GiB・min1/max1 | japaneast | 約 15〜20（常時1） |
| Container App: Worker | `ca-tvmvp-worker` | Ingressなし・**1.0CPU/2GiB**・**min0/max1**（KEDA azure-queue） | japaneast | 約 0〜5（起動時のみ課金） |
| Azure OpenAI | `oai-tvmvp-73bb` | **S0**・`gpt-4o`(2024-11-20) **Standard(Regional)** TPM 10K | japaneast | 従量（画像1回数円〜） |
| Static Web Apps | `swa-tvmvp-73bb` | **Free** | eastasia(※) | **0** |
| Log Analytics | `workspace-rg001gen12…` | 環境作成時に自動生成 | japaneast | 従量（少量） |

概算合計: **月 40〜55 USD 程度**（API 常時1レプリカが主。worker は待受0でほぼ無料、
OpenAI とストレージは利用量次第）。停止したい場合は API の min-replicas を 0 にできる
（初回アクセスにコールドスタート数秒が発生する）。

※ SWA Free は japaneast を選べないため、プラットフォーム地域は eastasia。配信は CDN エッジで、
アプリのデータ実体（PII=顔・声）は japaneast の Container Apps / PostgreSQL / Storage に閉じる。

## 主要 URL / エンドポイント

| 用途 | URL |
| --- | --- |
| API（家族/高齢者用バックエンド） | `https://ca-tvmvp-api.whiteglacier-fe08d1c0.japaneast.azurecontainerapps.io` |
| フロントエンド（SWA） | `https://gray-dune-0117e4d00.7.azurestaticapps.net` |
| ACR ログインサーバ | `acrtvmvp73bb.azurecr.io` |
| Azure OpenAI エンドポイント | `https://oai-tvmvp-73bb.openai.azure.com/` |

いずれも接続文字列・キーは `backend/cloud.env` を参照（PostgreSQL 接続、Storage 接続文字列、
seed 出力の family_id/device_id、OpenAI エンドポイント等）。**OpenAI の API キーは
cloud.env には書かず、`ca-tvmvp-worker` のシークレット `openai-key` に格納**している。

## 相互参照（CORS・URL 連携）

- `ca-tvmvp-api` の環境変数
  - `CORS_ALLOW_ORIGINS = http://localhost:3000,https://gray-dune-0117e4d00.7.azurestaticapps.net`
  - `FRONTEND_BASE_URL = https://gray-dune-0117e4d00.7.azurestaticapps.net`（登録リンク生成用）
- Storage Blob の CORS 許可オリジン: `http://localhost:3000` ＋ SWA URL
  （ブラウザ直 Blob PUT のため。GET/PUT/OPTIONS/HEAD）
- `ca-tvmvp-worker` の Azure OpenAI 環境変数
  - `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT=gpt-4o` /
    `AZURE_OPENAI_API_VERSION=2024-08-01-preview` ＋ シークレット `openai-key`

## 秘密の設定（ユーザー実施: Agora）

Agora の App ID / Certificate は A1 では扱っていない。お手元の `backend/.env` の値で
API コンテナに設定する手順は `docs/dev-setup.md §13` を参照。

## デプロイ更新手順

`docs/dev-setup.md §13「クラウド環境」`に集約（イメージ再ビルド→コンテナ更新、SWA 再デプロイ、
cloud.env の説明）。
