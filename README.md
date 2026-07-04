# TV電話サービス「元気にしてる？」MVP

離れて暮らす高齢の親と家族をつなぐTV電話サービスのMVP開発リポジトリ。
Agoraによる通話中に表情・声・キーワードを検知して自動でハイライト候補を作成し、
家族が5枚を選ぶとAzure OpenAIとFFmpegでハイライト動画を生成、
家族の閲覧UIと高齢者側の待受画面に配信する。

## モノレポ構成

```
TV_MVP/
├── frontend/   # Next.js（家族側スマホWeb＋高齢者側待受ページ、Chrome限定）
├── backend/    # FastAPI（トークン発行・メディア登録・候補・選択確定・アルバム取得）
├── worker/     # 常駐ワーカー（第1段：候補スコアリング／第2段：ハイライト動画生成）
├── infra/      # Azure東日本インフラの作業メモ
├── docs/       # 支給物ドキュメント（アーキテクチャ・API仕様・データ契約・DBスキーマ等）
└── tests/      # E2Eデモ台本
```

## 各ディレクトリの役割

| ディレクトリ | 役割 |
| --- | --- |
| `frontend/` | 家族側スマホWebアプリと高齢者側待受ページ（Next.js、Chrome限定） |
| `backend/` | FastAPIによるAPIサーバー（トークン発行・通話管理・候補管理・選択確定・アルバム配信） |
| `worker/` | Azure Storage Queueをポーリングする常駐ワーカー（2段階パイプライン） |
| `docs/` | アーキテクチャ図・OpenAPI仕様・データ契約・検知パラメータ・DBスキーマ等の支給物ドキュメント |
| `infra/` | Azure東日本のリソース一覧・構築メモ |
| `tests/` | E2Eデモ台本 |

## 委託と内製の区分

- **委託コア①（通話基盤）**: Agora Web SDKによる通話接続まわり（`frontend/src/modules/call/`）
- **委託コア②（検知キャプチャ）**: 通話中のRMS/MediaPipe/STT検知とローカルキャプチャ（`frontend/src/modules/detection/`）
- **委託コア③（通話後パイプライン）**: Blob同期、ワーカー第1段・第2段の処理（`frontend/src/modules/sync/`、`backend/`一部、`worker/`）
- **内製**: 選択UI（`select/`）、閲覧UI（`album/`）、認証（`lib/auth-stub.ts`）、DBスキーマ（`backend/app/db/`）

## セットアップ

各ディレクトリのREADME参照。
