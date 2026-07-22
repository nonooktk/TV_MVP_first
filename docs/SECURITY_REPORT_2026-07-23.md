# セキュリティチェック レポート（TV_MVP・2026-07-23・差分監査）

対象: TV電話「元気にしてる？」MVP（frontend=静的エクスポート／backend=FastAPI／Azure）
実施: SCA・SAST・CSPM・DAST・手動 IDOR の5種（差分中心）。ツールは無料枠のみ。本番へは受動スキャンのみ。
起点: 2026-07-23 本番デプロイ済みの2タスク（① CSP `media-src` に Blob ドメイン追加 ② 名前表示機能＝`devices.display_name`・`GET /devices`・`PATCH /devices/{id}`・`/tokens/call` の `remote_display_name`）。認可に関わる API 追加のため、リリース規定に沿い統括承認のうえ実施。
基準レポート: [SECURITY_REPORT_2026-07-19.md](./SECURITY_REPORT_2026-07-19.md)（全体監査。本レポートはその差分）。

---

## ■ エグゼクティブサマリー

本日デプロイの2タスク（CSP 変更・名前表示機能）に対し、5種を差分中心で通した。

- **今回追加分に新規の脆弱性はゼロ**。新設 API（`GET`/`PATCH /devices`）の認可は堅牢 → owner のみ更新可（viewer は 403）、他家族の `device_id` は存在秘匿の 404、一覧は `family_id` 絞り込みで越境しない。
- **保存 XSS の芽も無い**。`display_name` はサーバ側で 30 字上限・トリム、フロントは JSX テキスト位置で表示 → React 自動エスケープで無害化。`dangerouslySetInnerHTML`／`innerHTML`／`eval` の混入なし。
- **CSP 変更は最小・妥当**。`media-src` に `https://*.blob.core.windows.net` を1つ追加しただけ → 他ディレクティブ・他ヘッダは無変更。本番受動確認でヘッダ回帰なし。
- 依存関係は**据え置き**。今回のデルタは依存ファイル（`requirements.txt`／`package.json`）を変更していない → SCA は 2026-07-19/21 のベースラインが有効。`.snyk` の受容1件（`SNYK-JS-NEXT-15105315`）は期限内（2027-01-21）。

**総合判定: 合格（本番前必須の指摘なし）**。新規の Blocker/High/Medium はゼロ。多層防御として任意対応の Low 1件（F-11・`media-src` ワイルドカードの範囲）のみ。

| 深刻度 | 件数 | 内訳 |
| --- | --- | --- |
| Blocker（本番前必須） | 0 | — |
| High（対応推奨） | 0 | — |
| Medium | 0 | — |
| Low（任意） | 1 | F-11（`media-src` の `*.blob.core.windows.net` は全ストレージアカウント許容。既存 `img-src` と同方針＝受容可） |
| クリア（確認の結果 問題なし） | 4 | 新設 `PATCH`/`GET /devices` の認可（IDOR）／`display_name` の保存 XSS／`/tokens/call` の名前越境／CSP 変更の副作用 |

---

## ■ 背景

本アプリは高齢者と家族をつなぐ TV 電話で、PII として**顔画像・音声・家族の表示名**を扱う。認可の越境（IDOR）は最重要の攻撃面。今回のデルタは「家族（owner）が高齢者側デバイスに表示名を付け、通話画面に Zoom 風ラベルで出す」機能を新設し、**書き込み系 API（`PATCH /devices/{id}`）と一覧取得（`GET /devices`）を追加**した。→ 認可・入力検証・保存後の描画（XSS）が点検対象。あわせてアルバム動画表示のため CSP の `media-src` を1行変更した。

## ■ 目的

今回追加・変更した範囲に限定して、次を確かめる。①依存に新規の既知脆弱性が増えていないか ②新設 API の自作コードに脆弱パターンが無いか ③クラウド設定を今回のデルタが悪化させていないか ④本番の配信ヘッダが回帰していないか ⑤新設 API で他家族のデバイスを取得・改変できないか（IDOR）。

## ■ 手段

| チェック | 対象 | ツール／方式 |
| --- | --- | --- |
| ① SCA | 依存（差分） | `git diff` で依存ファイル変更の有無を確認 → 変更なしを実証 |
| ② SAST | 変更ファイル10本 | Semgrep（`p/security-audit`・`p/secrets`・`p/python`・`p/typescript`・`p/javascript`）＋手動レビュー |
| ③ CSPM | Azure（差分） | 今回のデルタでの Azure リソース設定変更の有無を確認（アクションカード方式は変更なしのため不要） |
| ④ DAST | 本番 SWA | `curl -I`（受動・非侵襲）でセキュリティヘッダを確認 |
| ⑤ 手動 IDOR | 新設 API | pytest ハーネス（`test_devices_patch.py`＝14件・`test_idor_manual.py`＋`test_calls.py`）を実行 |

## ■ 結果

### ① SCA（依存の既知脆弱性）

今回のデルタは依存ファイルを変更していない（`git diff 3beacc8~1 ee98b6a -- requirements* package*.json` で 0 件）。→ SCA は 2026-07-19（backend `pip-audit` クリーン）／2026-07-21（frontend `npm audit` 0 vulnerabilities・next 15.5/React 19/vitest 4 更新）のベースラインが有効。`.snyk` の受容は `SNYK-JS-NEXT-15105315` 1件のみで、`expires: 2027-01-21`＝本日時点で期限内・据え置き妥当（静的 export 構成で悪用前提の PPR/minimal mode 非該当）。→ **新規指摘なし**。

### ② SAST（自作コードの静的解析）

変更ファイル10本（backend 6・frontend 4）に Semgrep を実行 → **検出 0 件**。手動レビューでも真陽性なし。

- `PATCH /devices/{device_id}`（`backend/app/api/devices.py:99-156`）: `device_id` は `UUID` 型で受けるため型不正は 422。SQL は SQLAlchemy の識別子解決で、生 SQL 連結なし → SQLi なし。
- `display_name` の入力検証（`backend/app/schemas.py:85-91`）: `Field(max_length=30)`＋サーバ側 `strip()`・空/空白は `None` 化。→ 長さ・空白の境界は `test_devices_patch.py` で実証済み。
- フロント描画（`frontend/src/app/call/page.tsx`・`page.tsx`・`elder/standby/page.tsx`）: `{remoteDisplayName}`／`{selfDisplayName}`／`{familyName}` はいずれも JSX テキスト位置 → React 自動エスケープ。`dangerouslySetInnerHTML`・`innerHTML`・`eval`・`new Function` の混入なし（grep 0 件）。→ **保存 XSS の芽なし**。

### ③ CSPM（クラウド設定の不備）

今回のデルタは Azure リソースの設定（Storage のネットワーク／Blob 匿名アクセス／DB のファイアウォール／Container Apps の env・ingress）を**変更していない**。適用したのは ①DB マイグレーション 0003（`devices.display_name` 列追加＝nullable・データ設定に影響なし） ②api イメージ更新（`tvmvp-api:v13`／rev 0000017） ③SWA 再配信 のみ。→ CSPM は本デルタでは**非該当**（前回 2026-07-19 の CSPM 結果＝Storage 匿名公開なし・DB 全開放なしが有効。F-8/F-9 は MVP 据え置きのまま）。新規のクラウド設定変更が無いため、ポータル確認のアクションカードは今回不要。

### ④ DAST（本番への受動スキャン）

本番 SWA（`https://gray-dune-0117e4d00.7.azurestaticapps.net`）に `curl -I` で受動確認（能動スキャンは撃たない）。→ 今回の CSP 変更が反映され、他ヘッダに回帰なし。

- `content-security-policy`: `media-src 'self' blob: data: https://*.blob.core.windows.net` を確認（変更が本番に反映済み）。
- `x-frame-options: DENY`／`x-content-type-options: nosniff`／`strict-transport-security`／`referrer-policy`／`permissions-policy` は F-6 のまま継続配信。
- 認証必須 API は受動範囲外（`GET /devices` は未認証 401＝CLAUDE.md のデプロイ記録で確認済み）。→ API 全面のペネテストではない点は前回同様に注記。

### ⑤ 手動 IDOR（認可の越境）

新設 API の越境を pytest ハーネスで実証 → **41 passed**（`test_devices_patch.py` 14＋`test_idor_manual.py`＋`test_calls.py`）。実 API と同じ認可ロジックを叩く（`require_family` を差し替えて viewer・他家族を再現）。

| 越境操作 | 期待 | 実測 | 判定 |
| --- | --- | --- | --- |
| `PATCH /devices/{他家族の device_id}`（owner） | 404（存在秘匿） | 404 | クリア |
| `PATCH /devices/{自家族}`（viewer ロール） | 403 | 403 | クリア |
| `GET /devices`（他家族のデバイスが混ざるか） | 自家族のみ | 自家族のみ（他家族 device_id は含まれない） | クリア |
| `GET /devices`（Bearer なし） | 401 | 401 | クリア |
| `PATCH` 30字超／`..`・空白 | 422／null 化 | 422／null 化 | クリア |

コードでの裏取り: `update_device` は `if user.role != "owner": 403` → `device = db.get(...)` → `device is None or device.family_id != user.family_id: 404`（`backend/app/api/devices.py:111-134`）。`list_devices` は `where(Device.family_id == user.family_id)`（同 `:79-108`）。`/tokens/call` の `remote_display_name` は、先に `call.family_id != user.family_id` を 404 で弾いたうえで `call.device_id` の名前を引くため、他家族の名前は返らない（`backend/app/api/tokens.py:35-45`）。→ **越境は成立しない**。

あわせて「クライアント供給の識別子をサーバ側で検証しているか」の観点も充足 → `device_id` は自家族帰属を必ず照合（無検証で使っていない）。

## ■ 考察

- **良い点**: 新設 API が既存の家族スコープ機構（`require_family`＋`family_id` 絞り込み・owner 判定）にそのまま乗っており、F-1 系の「クライアント供給値をサーバで検証する」教訓が踏襲されている。他家族は存在秘匿の 404 で応答し、リソースの有無すら漏らさない。
- **CSP の効き**: 今回の `media-src` 追加は攻撃面をほぼ広げない → media（video/audio）は script を実行しない要素で、かつアプリに HTML 注入シンクが無いため、許容ホストが増えても XSS 実行経路にはつながらない。
- **気になる点（軽微）**: `media-src`／`img-src` の `*.blob.core.windows.net` は**全 Azure ストレージアカウント**を許容するワイルドカード → 自アカウントのホストに限定すれば多層防御になる（F-11）。ただし既存 `img-src` で同方針が受容済みで、実害は低い。
- **未確認**: 実 Agora 2者通話でのラベル実機目視（CLAUDE.md でも「次回通話デモで確認」と明記）。これはセキュリティではなく機能確認の範囲。

## ■ ネクストアクション

- **本番前必須**: なし（今回のデルタで新規の Blocker/High/Medium はゼロ）。
- **推奨**: なし。
- **任意（多層防御）**: F-11 → `media-src`／`img-src` の `*.blob.core.windows.net` を、実際に使う自ストレージアカウントのホスト（`<account>.blob.core.windows.net`）へ限定。CSP 全体の棚卸し時にまとめて実施でよい。既存 `img-src` と同方針のため、単独で急ぐ必要はない。
- **QA**: 本レポートは QA 主担当（シナモロール）レビュー推奨。前回 F-1/F-10 は QA レビューで一対の見落としが発見された実績あり。

## ■ まとめ

本日デプロイの2タスクは、認可・入力検証・描画・CSP のいずれの観点でも本番前必須の穴を残していない。→ **合格**。新設 API は家族スコープと owner 判定で越境を正しく塞ぎ、`display_name` は上限・トリム・エスケープの三重で無害化されている。残るのは多層防御の任意項目1件（F-11）のみで、これは既存方針の踏襲であり緊急性はない。

### 付記（実施範囲・未実施の明示）

- 実施済み（5種すべて・差分中心）: ① SCA（依存変更なしを実証・ベースライン有効） ② SAST（Semgrep 変更10ファイル・検出0＋手動レビュー） ③ CSPM（Azure 設定変更なし＝本デルタ非該当・前回結果有効） ④ DAST（本番受動ヘッダ確認・回帰なし） ⑤ 手動 IDOR（pytest 41 passed）。
- 未実施（正直に明示）: 認証済み DAST（本番へ能動スキャンは撃たない方針）／実 Agora 通話でのラベル実機目視（機能確認・次回デモ）。
- CSPM のポータル実確認は今回のデルタでは不要（クラウド設定の変更が無いため）。次に Azure リソース設定を変更する際はアクションカードで再実施する。
- 検査バージョン記録: backend=`tvmvp-api:v13`（rev 0000017）／DB=alembic `0003`／frontend=SWA production（`gray-dune-0117e4d00`）。依存ロックは 2026-07-19/21 レポートの `requirements.lock.txt`／`package-lock.json` を継承。
- 秘匿値（`.env`／`cloud.env`）は一切出力・コミットしていない。git commit/push は未実施。
