# DBスキーマ

支給物A3。テーブル一覧と主要カラム（クラス図準拠）。
モデル実装: `backend/app/db/models.py`／マイグレーション: `0001_initial`
（`backend/app/db/migrations/versions/0001_initial.py`）＋
`0002_album_collage`（albums に `collage_storage_key` を追加）＋
`0003_device_display_name`（devices に `display_name` を追加）＋
`0004_user_display_name`（users に `display_name` を追加）。

全テーブル共通: `id` = UUID v4 主キー、`created_at` = timestamptz（server_default `now()`）。

## テーブル一覧

| テーブル | 概要 |
| --- | --- |
| `families` | 家族グループ |
| `users` | 利用者（家族側） |
| `devices` | 高齢者側デバイス（待受端末） |
| `calls` | 通話記録 |
| `memories` | 通話中に検知された候補メディア |
| `albums` | 完成したハイライトアルバム |

## 主要カラム（クラス図準拠）

| テーブル | 主要カラム |
| --- | --- |
| `families` | id, name, created_at |
| `users` | id, family_id（FK→families）, role（`owner` / `viewer`）, auth_id（Entra ID・nullable・unique）, display_name（家族メンバー自身が設定する表示名・30字上限は API 側で担保・nullable）, created_at |
| `devices` | id, family_id（FK→families）, fixed_contact_user_id（FK→users・固定通話相手）, status（`pending` / `active` / `revoked`・default `pending`）, display_name（家族が付ける表示名・通話画面のZoom風ラベル用・nullable）, registration_token_hash（初回登録リンクのトークンハッシュ・nullable）, registration_expires_at（nullable）, registered_at（nullable）, device_token_hash（待受認証用 X-Device-Token のハッシュ・nullable）, created_at |
| `calls` | id, family_id（FK→families）, device_id（FK→devices）, caller_user_id（FK→users・nullable）, channel_name（通話ごとにローテーション）, status（`calling` / `active` / `ended`・default `calling`）, started_at（nullable）, ended_at（nullable）, created_at |
| `memories` | id, call_id（FK→calls）, type（`photo` / `audio`）, storage_key（Blob参照）, score（float・nullable）, status（`candidate` / `selected`・default `candidate`）, captured_at, metadata（JSONB・default `{}`）, created_at |
| `albums` | id, call_id（FK→calls・**unique**・1通話に0..1）, status（`awaiting_selection` / `generating` / `ready`・default `awaiting_selection`）, selected_memory_ids（JSONB・確定5枚の memory id 配列・順序保持・確定前はnull可）, title（nullable）, caption（nullable）, bgm_track（nullable）, video_storage_key（nullable）, collage_storage_key（コラージュ画像のBlob参照・nullable・第2段で生成）, version（int・default 0・再生成で+1）, presented_at（候補提示時刻・5分自動確定の基準・nullable）, confirmed_at（nullable）, auto_confirmed（bool・default false）, created_at |

## ENUM（PostgreSQLネイティブ）

| 型名 | 値 |
| --- | --- |
| `user_role` | `owner` / `viewer` |
| `device_status` | `pending` / `active` / `revoked` |
| `call_status` | `calling` / `active` / `ended` |
| `memory_type` | `photo` / `audio` |
| `memory_status` | `candidate` / `selected` |
| `album_status` | `awaiting_selection` / `generating` / `ready` |

## インデックス

- `users(family_id)`
- `devices(family_id)`
- `calls(family_id, started_at)`
- `memories(call_id)`
- `memories(call_id, score)`
- `albums(status)`

> 正式なDDL/Alembicマイグレーションは `backend/app/db/` に実装済み。
> スキーマ変更時は md → モデル（models.py）→ マイグレーションの順で同期する。
