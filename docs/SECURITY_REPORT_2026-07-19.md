# セキュリティチェック レポート（TV_MVP・2026-07-19）

対象: TV電話「元気にしてる？」MVP（frontend=静的エクスポート／backend=FastAPI／Azure）
実施: SCA・SAST・CSPM・DAST・手動 IDOR の5種（メンター提示の4種＋手動 IDOR）。ツールは無料枠のみ。
手順書: [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md)

---

## ■ エグゼクティブサマリー

エンプラ最低ラインの5種（SCA / SAST / CSPM / DAST / 手動 IDOR）を実施。

- **API 層の認可は堅牢**。他家族の `call_id` / `album_id` を直叩きしても 401/403/404 で防御。ツール（SCA/SAST）の指摘に真の脆弱性はゼロ。
- **ただし Storage 層に1件、実害のある穴（F-1）**。アップロード用 SAS が**コンテナ全体スコープ**で発行され、他家族領域へ書き込める。→ ツールでは出ず、コード＋設計理解でのみ検出。
- 依存関係は backend クリーン、frontend の Critical は**静的エクスポートのため本番実行時の影響が限定的**。実務対応は next のパッチ更新1つ。

**総合判定: 条件付き合格**。F-1 の修正を本番前の必須とする。API 認可は現状維持で可。

| 深刻度 | 件数 | 内訳 |
| --- | --- | --- |
| Blocker（本番前必須） | 1 | F-1（SAS 越境書き込み） |
| High（対応推奨） | 1 | F-3（dev トークン裏口の本番失効） |
| Medium | 3 | next パッチ更新／F-6（セキュリティヘッダ未設定）／F-10（register の storage_key 無検証＝read 越境の芽） |
| Low・偽陽性 | 多数 | SAST 13件は全偽陽性／DAST の残ヘッダ（F-7）／Storage の全ネットワーク公開（F-8）／DB の Azure サービス許可（F-9）／SCA の dev 依存 |

**F-2（Blob 匿名アクセス）は CSPM 確認で問題なしと確定**（③参照）。CSPM で致命傷（Storage 匿名公開・DB 全開放）はいずれも無し。

### 対応・デプロイ記録（2026-07-20）

修正実施はポリゴン、レビューはシナモロール。

| ID | 対応 | 状態 |
| --- | --- | --- |
| F-1 | `upload_sas_url` を `generate_blob_sas`（単一 Blob スコープ）へ＋prefix 外キーは `ValueError` | **対応済み・本番デプロイ済み**（`tvmvp-api:v9` / rev 0000012・`/healthz` 200） |
| F-6 | `frontend/public/staticwebapp.config.json` 新設（X-Frame-Options DENY・CSP・HSTS・Permissions-Policy・nosniff） | **対応済み・SWA 配信済み**（`curl -I` で新ヘッダ確認） |
| F-10 | `register_media` で `storage_key` が `call_prefix` 配下かを検証（空・`..`・外部は 400） | **対応済み・本番デプロイ済み**（`tvmvp-api:v10` / rev 0000013） |
| F-3 | dev トークン本番失効（コードで非空ガード＋`config.py` デフォルト `""`＋cloud の env 除去） | **対応済み・本番デプロイ済み**（backend v12 / rev 0000016・env に `DEV_FAMILY_TOKEN` 無し・旧 `dev-fixed-token`/空 Bearer とも 401） |
| next | 14.2.0 → 14.2.35 パッチ更新 | **対応済み・SWA 配信済み**（vitest 144・build 9/9・F-6 ヘッダ継続配信を再確認） |
| F-7 | API 全レスポンスに `X-Content-Type-Options: nosniff` | **対応済み・本番デプロイ済み**（v12・`/healthz`・`/openapi.json` で確認） |
| F-4 | 依存バージョン固定（`requirements.txt` を `==` ピン留め） | **対応済み・本番デプロイ済み**（v12・ACR ビルドで解決検証） |
| F-8 / F-9 | Storage/DB のネットワーク強化 | **据え置き（MVP）**。F-8=選択ネットワーク化はブラウザ直 SAS アップロードを壊す／F-9=OFF は Container App の DB 疎通を壊す。本番強化は private endpoint・VNet 統合が前提のため次フェーズ |

- 検証: backend `pytest 197 passed`（F-1 で単一 Blob スコープ〈`sr=b`〉・prefix 外拒否／F-10 で越境・`..` 拒否と自家族 201 のテスト追加）。frontend `next build 9/9`・CSP 下で Google/Microsoft サインインボタン描画を実機確認。
- 残確認: 本番で実通話1回を行い CSP 違反が出ないこと（Agora/MediaPipe の実接続）。

---

## ■ 背景

Tech0 メンターから「MVP をエンプラ水準へ近づける最低限のチェック」の指定。観点は OSI L7（認証・認可・入力値検証）。

このアプリは家族ごとの顔写真・声＝PII を扱う。→ 認可（他人のデータを見せない/触らせない）が最重要。認証（Google / Entra）は導入済みのため、今回は**認可と依存・コードの健全性**に絞った。

---

## ■ 目的

3点を確かめる。

- ① 依存ライブラリに既知脆弱性がないか（SCA）
- ② 自作コードに脆弱パターンがないか（SAST）
- ③ 他家族のリソースへ越境アクセスできないか（手動 IDOR）

設計レビューだけでは人の想像の範囲しか見えない。→ ツール＋手動で観点を足す。

---

## ■ 手段

| 種別 | ツール | 対象 | 送信 |
| --- | --- | --- | --- |
| SCA | npm audit / pip-audit | frontend `package.json`・backend `requirements.txt` | ローカル（オフライン寄り） |
| SAST | Snyk Code | 自作コード全体 | クラウド解析（`.snyk` で秘匿除外） |
| 手動 IDOR | pytest ハーネス（`tests/test_idor_manual.py`）＋既存分離テスト | 家族A/B 越境アクセス | ローカル |

手動 IDOR は「家族Bとして家族Aのリソースを叩く」を pytest の認証差し替えで再現。→ curl の2アカウント実ログインより再現性が高く、CI へも載せられる。

---

## ■ 結果

### ① SCA（依存の既知脆弱性）

**frontend（npm audit）: 9件（Critical 2・High 1・Moderate 6）**

| パッケージ | severity | 本番影響 | 対応 |
| --- | --- | --- | --- |
| next 14.2.0 | Critical | ほぼ無し → 指摘の大半がサーバ機能の脆弱性。本アプリは `output:"export"` の静的配信で該当機能が動かない | **14.2.35 へパッチ更新（推奨・低リスク）** |
| esbuild / vite / vitest / vite-node | Moderate | 無し → devDependencies・配信物に非同梱 | 開発時のみ。保留可 |
| postcss | Moderate | 無し → ビルド時ツール | next 更新で同時解消 |
| uuid（speech-sdk 経由） | Moderate | 低 → 悪用条件が「buf 指定時」に限定 | 監視のみ |

**backend（pip-audit）: No known vulnerabilities＝クリーン**

- 気になる点 → `requirements.txt` がバージョン未固定（F-4）。今日クリーンでも再現性なし。検査した実バージョンは `requirements.lock.txt` に記録。

### ② SAST（自作コードの静的解析）

**13件（HIGH 1・MEDIUM 3・LOW 9）→ 全件 偽陽性**。指摘箇所の実コードを読んで判定。

| severity | 箇所 | 実体 | 判定 |
| --- | --- | --- | --- |
| HIGH | `googleAuth.ts:20` | `TOKEN_KEY="google_id_token"` = sessionStorage のキー名。トークン本体ではない | 偽陽性 |
| MEDIUM | `album/page.tsx:203,220` | `<img src={SAS URL}>`。値はサーバ発行の Azure SAS。img の src は `javascript:` を実行しない | 偽陽性 |
| MEDIUM | `page.tsx:114` | Blob DL の `<a>` 生成。`callId` は `a.download`（ファイル名）のみ。HTML 注入 sink なし | 偽陽性 |
| LOW ×9 | `backend/tests/*` | `dummy-speech-key-not-a-real-secret`・偽JWT・`sk-test` = テストのダミー値 | 偽陽性 |

堅牢化の余地（任意・前提が崩れた時の保険）。

- img の src → https スキーム＋想定 Blob ホストの allow リストを1枚噛ませる。F-1 と地続き。
- テストのダミー値 → `.snyk` に `backend/tests/**` を足してノイズ除去。

### ⑤ 手動 IDOR（認可の越境）

**pytest ハーネス 11件＋既存分離テスト 31件、すべて PASS**。

| # | シナリオ | 期待 | 実測 | 判定 |
| --- | --- | --- | --- | --- |
| ① | B→A candidates 直叩き | 404 | 404 | ✅ |
| ② | B(owner)→A アルバム削除 | 404 | 404 | ✅ |
| ②' | B(viewer)→A アルバム削除 | 403/404 | 403/404 | ✅ |
| ③ | B→A 選択確定 | 404 | 404 | ✅ |
| ④ | B→A upload-sas 発行 | 404 | 404 | ✅ |
| A | 無/空/不正 Bearer ×4 | 401 | 401 | ✅ |
| F-3 | dev トークン（ローカル） | 200 | 200 | ⚠️ 記録（本番では 401 であるべき） |

良い点 → 帰属しないリソースを 404 で秘匿する実装（`_owned_call`）が一貫。ルーターは常に認証ユーザーの `family_id` でスコープ。

coverage 注意 → 明示のクロス家族テストが無い経路が残る（`media/register`・`calls/{id}/end`・`tokens/call`・`answer`）。コードは `_owned_call` 等で防御されるが、テストは未網羅。→ F-10 は `register` の未検証部分から派生。次段でクロステストを追加する。

### 🔴 F-1（確定した脆弱性・Blocker 候補）

アップロード用 SAS が**コンテナ全体スコープ**で発行される。

- 事象 → `blob.py::upload_sas_url` が `generate_container_sas`（コンテナ全体の create+write）を発行。プレフィックス限定は「サーバが返す URL」でしか効かない。SAS トークン自体は**コンテナ内の全 Blob に有効**。
- 攻撃 → 家族が自分の通話で upload-sas を取得 → `?sas` を別家族パス（`families/{他家族}/calls/xxx/evil.jpg`）へ付け替えて PUT → **書き込み成功**。他家族の写真・動画の上書き/なりすまし投入が可能。
- 影響 → write/create のみ（read 権限なし＝他家族の閲覧は不可）。ただし上書き＝データ破壊は重大。
- 契約違反 → `data-contract.md §2`「当該通話プレフィックス限定」の約束と実装が乖離。
- 対照 → `view_sas_url` は `generate_blob_sas`（単一 Blob・read）で正しくスコープ。upload だけが container SAS。
- 確度 → HIGH。Azure のコンテナ SAS はコンテナ内全 Blob に効く仕様のため、コードで確定。実 Azure での live PUT 確認は最終ダメ押し。

修正案（低リスク）→ upload-sas は各 filename の `storage_key` が確定済み。→ `generate_blob_sas` で「その1ファイルだけ」の create+write SAS を発行する（read 側と同じ手法）。越境 PUT が原理的に不可能になる。

補足（悪用容易性）→ 攻撃には被害者の `family_id` / `call_id`（UUIDv4）を知る必要があり、UUID の非予測性で実務上は緩和される。→ ただし保証は UUID 秘匿性でなく構造で担保すべきで、修正も安価なため Blocker 判定は維持。

### 🟠 F-10（関連・要是正・read 方向の芽）

F-1（write 越境）と一対で、**read 方向の越境の芽**が `media/register` に残る。QA レビュー（シナモロール）がコードで検出。

- 事象 → `backend/app/api/media.py::register_media` が `item.storage_key` を**無検証でそのまま保存**（`storage_key` が当該 `call_prefix` 配下かを確認していない）。→ 一方 `GET /calls/{id}/candidates` は同 `storage_key` の **read SAS を発行**する。
- 攻撃 → 家族Bが自分の call に `storage_key=families/{家族A}/…/xxx.jpg` の memory を register → 自分の candidates を取得 → **他家族 Blob の read SAS を取得**。
- 深刻度 → Medium（要是正）。write の F-1 と違い read 方向。悪用には全 UUID パスの知得が必要で即時 exfil ではないが、認可はデータ実体の層まで通すべき、という本レポートの教訓がそのまま当てはまる。
- 修正案 → `register_media` で `storage_key.startswith(call_prefix)` をサーバ側検証（不一致は 4xx）。F-1 修正と同じ変更で同時に塞ぐ。要確認のため越境 read 再現の pytest を1本追加。

### ④ DAST（動いているアプリへの外側スキャン・OWASP ZAP）

2種を実施。攻撃を撃たない受動（baseline）を本番へ、能動をローカル API へ。

**④-1 baseline（本番 SWA・受動）: 0 FAIL / 10 WARN / 57 PASS**

実脆弱性ゼロ。WARN は全件セキュリティヘッダ不足（多層防御）。実ページ上の実質は4つ。

| ヘッダ | 状態 | 影響 |
| --- | --- | --- |
| Content-Security-Policy | 未設定 | XSS 緩和層の欠如。SAST の img-src 堅牢化と地続き |
| X-Frame-Options / frame-ancestors | 未設定 | クリックジャッキング → サインイン画面を持つので効く |
| Strict-Transport-Security | 未設定 | HTTPS 強制の欠如 |
| Permissions-Policy | 未設定 | 機能制限ヘッダの欠如 |

→ **F-6（Medium）**。Cross-Domain JS（GIS/MSAL の認証SDK）は仕様どおりで問題なし。SRI/COEP/Cache は Low。

**④-2 API 能動スキャン（ローカル backend）: 0 FAIL / 2 WARN / 116 PASS**

SQLi・XSS・RCE・パストラバーサル・SSTI・Log4Shell 等の能動ルールが全 PASS。

- WARN 2件 → `/healthz`・`/openapi.json` の `X-Content-Type-Options: nosniff` 欠落＝**F-7（Low）**。
- coverage 注意 → 認証必須エンドポイントは 401 で未到達。「116 PASS」は**到達できた公開面＋受動ルール**の結果であり、API 全面のペネテストではない。認証済み能動スキャン（Bearer 注入）は次段。

修正案 → SWA の `staticwebapp.config.json` に `globalHeaders` でヘッダ群を追加（CSP・X-Frame-Options・HSTS・Permissions-Policy・nosniff）。現状このファイルが無い。→ 新設1枚で解消。

### ③ CSPM（クラウド設定の不備・Defender for Cloud）

Foundational CSPM（無料）で確認。有料 Defender プランは有効化しない。

- **推奨事項: 0件**（クリティカル/高/中/低すべて0）→ 集約ビューでの指摘なし。
- **Storage（`sttvmvp73bb`）直接確認**:

| 設定 | 値 | 判定 |
| --- | --- | --- |
| BLOB パブリックアクセスを許可する | **無効** | ✅ 匿名アクセス封鎖 → **F-2 は問題なし**。SAS 無し直読みは失敗 |
| Public network access | Enabled from all networks | F-8（Low・任意）。匿名ではなく到達範囲の話。SAS/キーは依然必須。ブラウザ SAS アップロード＋Container Apps 到達のため妥当 |

→ **F-2 クリア確定**。ただし F-1（正規 SAS の過剰スコープ）は匿名アクセス無効では防げない＝**別問題として残存**。

- **PostgreSQL（`psql-tvmvp-73bb`）直接確認**:

| 設定 | 値 | 判定 |
| --- | --- | --- |
| `0.0.0.0-255.255.255.255` 全開放ルール | **無し** | ✅ 致命傷なし |
| SSL/TLS 強制（`require_secure_transport`） | 既定 ON | ✅ 平文接続不可 |
| ファイアウォール規則 | `allow-local-devip`（単一IP・開発機）のみ | 範囲は限定 |
| 「Azure サービスからのアクセスを許可」 | ON | F-9（Low）。**自テナントだけでなく全 Azure テナントのサービス**に開く設定（Azure の既知の落とし穴・認証は必須）。現状は Container App の DB 接続に必要 |

→ **DB 側に致命傷なし**。残課題は多層防御（F-9）と開発機IPの棚卸しのみ。

---

## ■ 考察

- **ツールの限界を実証**。SCA/SAST は真の脆弱性ゼロ、一方で最も重い F-1 はどちらのツールにも出なかった。→ 認可バグは「仕様を知る人間」にしか判定できない、というメンター指摘の通り。
- **静的エクスポートが効いている**。frontend の Critical が並ぶが、本番にサーバが無い構成のため実行時の攻撃面が消えている。→ 数字の見た目と実リスクは別。
- **穴は API ではなく Storage 層**。API 認可は堅い一方、SAS の発行スコープという「1段下のレイヤ」に穴。→ 認可は入口だけでなくデータ実体の層まで通して見る必要がある。
- **DAST は実害ゼロ・多層防御ヘッダが空**。injection 系は全 PASS、一方で CSP 等のブラウザ側の保険が未設定。→ アプリ本体は堅いが「もう一枚の壁」が無い。低コストで足せる。
- **F-2 は CSPM で解消確認**。Blob 匿名アクセスは無効＝SAS 必須が Azure 側でも担保。→ コードでは判定できない層を CSPM が埋めた好例。一方 F-1 は正規 SAS の問題で、この設定では防げない。

---

## ■ ネクストアクション

優先順位順。

1. **F-1 ＋ F-10 修正（本番前必須・一対）** → `upload_sas_url` を `generate_blob_sas`（単一 Blob スコープ）へ。あわせて `register_media` で `storage_key` が当該 `call_prefix` 配下かをサーバ側検証（read 越境の芽を塞ぐ）。実装後、越境 PUT/read が拒否されることを確認。
2. **F-3 dev トークンの本番失効** → プロバイダ認証のみにする判断。ローカルは現状維持。
3. **next 14.2.35 へパッチ更新** → 回帰は vitest/pytest で確認。
4. **F-6 セキュリティヘッダ追加** → SWA に `staticwebapp.config.json` を新設し `globalHeaders`（CSP・X-Frame-Options・HSTS・Permissions-Policy・nosniff）。F-7 もここで同時解消。
5. **F-9 DB ネットワーク強化（本番前・任意）** → 「Azure サービス許可」を OFF にし、VNet 統合 / プライベートエンドポイントへ。あわせて開発機IP（`allow-local-devip`）を棚卸し。
6. **認証済み DAST（ZAP＋Bearer）** → 認証必須エンドポイントまで能動スキャンを届かせる。
7. **F-4 依存バージョン固定** → `requirements.txt` をピン留め。SCA の再現性を担保。
8. **`.snyk` にテスト除外を追加** → SAST の偽陽性ノイズを抑制。

（③ CSPM は実施済み＝Storage 匿名アクセス無効・DB 全開放なし・SSL 強制を確認。致命傷なし。）

---

## ■ まとめ

MVP としての認可設計は水準以上。→ API 層の隔離は堅牢で、ツール指摘にも実害なし。

残る本丸は F-1（SAS 越境書き込み）1点。→ 修正は `generate_blob_sas` への置き換えで軽く、本番前に潰せば PII を扱うサービスとして最低ラインを満たす。

③ CSPM・④ DAST は本レビューで**実施済み**。→ ③ で F-2（Blob 匿名アクセス無効）を確定・DB に致命傷なしを確認、④ で injection 系 0 FAIL。**未実施は F-1 の実 Azure live PUT 確認と認証済み DAST（Bearer 注入）**で、これを次段とする。

---

### 付記（実施範囲・未実施の明示）

- 実施済み: ① SCA・② SAST・③ CSPM（推奨事項＋Storage＋PostgreSQL 直接確認）・④ DAST（本番受動＋ローカル能動）・⑤ 手動 IDOR（API 層）・F-1 コード確定。**メンター提示の4種＋手動 IDOR をすべて実施**。
- 未実施: F-1 の実 Azure live PUT 確認・認証済み DAST（Bearer 注入）・IDOR クロステスト未網羅経路（end/tokens/answer）。
- 対応済み（デプロイ）: F-1・F-6・F-10（越境 read 再現拒否のテスト追加済み）。
- QA レビュー: シナモロール（QA主担当）が実施＝**条件付き承認**。指摘（まとめ節の内部矛盾・実施種別の表記・F-10 の追記）を本版で反映済み。
- 検査バージョン記録: frontend=`package-lock.json`／backend=`requirements.lock.txt`。
