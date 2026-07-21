# セキュリティチェック手順書（エンプラ水準・最低限ライン）

TV電話「元気にしてる？」MVP を、Tech0 メンター提示の「MVP をエンタープライズ水準に近づける
最低限のセキュリティチェックリスト」に沿って点検するための手順書。**4種のツールチェック
（SCA / SAST / CSPM / DAST）＋手動 IDOR テスト**を、本リポジトリの実ファイル・実エンドポイントに
当てはめてコピペで実行できる形にまとめた。QA 主担当（シナモロール）のコードレビュー観点も反映している。

> [!important] この文書の位置づけ（2026-07-19 作成）
> - **本書は「手順書」であり、スキャンの実行はまだ行わない。** 実行は統括（のんちゃん）の承認後。
> - コマンドはコピペでそのまま動く形で書く（[[作業ルール]] 第3項）。
> - 各項目に **実行主体（Claude 実行可能 / 統括の手作業が必要）** と、実行後に埋める
>   **レポート表（空欄形式）** を用意した。
> - 判定・重大度は [[レビュー規定]] に準拠し、根拠を `[要件]` `[仕様]` `[規定]` で引用する。

---

## 0. 前提と重要な警告（必ず先に読む）

| # | 警告 | 対象 |
| --- | --- | --- |
| W1 | **CSPM（③ Defender for Cloud）は Azure ポータルの手作業で行う。** Claude/エージェントはポータルを直接操作できず、かつ**プラン有効化を誤ると高額請求が発生する**（メンターも警告）。**統括の手作業＋ダブルチェック前提**。本書の③は「人が実施するチェックリスト」として書く。 | ③ CSPM |
| W2 | **DAST（④ OWASP ZAP）は、必ず自分たちのアプリにのみ・ローカル起動したアプリに対して実行する。** 他者サイト・本番 SWA・Azure 上の稼働環境へのスキャンは**不正アクセス（不正アクセス禁止法）や各種規約違反**になり得る。ローカル（`localhost`）に立てたインスタンスだけを対象にする。 | ④ DAST |
| W3 | **秘匿情報の扱い**（[[セキュリティ規定]]）。`backend/cloud.env` / `backend/.env` / `frontend/.env.local` には実キー・トークンが入る。スキャン結果・ログ・レポートに**秘匿値を貼り付けない**。Snyk 等クラウド送信を伴うツールは、送信対象がソースコードのみか（秘匿ファイルを除外できているか）を確認する。 | 全体 |
| W4 | **スキャン自体が攻撃と誤認される/データを汚す可能性。** DAST はテスト用アカウント・テスト用 DB に対してのみ実行し、本番 DB・実ユーザーデータには一切向けない。 | ④ / 手動 |

### 実行主体の凡例

- 🟢 **Claude 実行可能**: エージェント（Claude）がローカルでコマンド実行まで担える。
- 🟡 **統括の手作業が必要**: ポータル操作・課金を伴う有効化・対話ログイン・受入判断など、人が行う。
- 🔵 **併走**: Claude が下準備（コマンド・スクリプト・観点整理）を行い、実行/判断は統括。

---

## 1. 対象アプリの構成マップ（点検の土台）

チェックの前提として、**認証の入口・IDOR になり得るエンドポイント・メディアの保存方式**を実コードから整理する。

### 1-1. 認証の入口

| 認証系統 | 実装 | 対象 |
| --- | --- | --- |
| 家族側 Bearer | `backend/app/api/deps.py::require_family`（`app/core/entra.py`・`app/core/google.py`） | 家族向け全 API |
| 開発用固定トークン（裏口） | `deps.py::_resolve_dev_family_owner`（`DEV_FAMILY_TOKEN`）／frontend `lib/auth-stub.ts` | 開発・テスト用。**本番前に失効が課題（後述 F-3）** |
| デバイス X-Device-Token | `deps.py::require_device`（sha256 照合・`status=active` のみ） | 高齢者待受（`/albums/latest`・`/calls/incoming`・`/calls/{id}/answer`） |
| 家族 or デバイス | `deps.py::require_family_or_device` | `POST /calls/{id}/end` |

- フロント側のゲート: `frontend/src/components/FamilyAuthGate.tsx`（家族側4ページをラップ）、
  トークン解決は `frontend/src/lib/api-client.ts::resolveFamilyToken`、Entra 実装は `frontend/src/lib/auth.ts`。

### 1-2. IDOR 検証対象エンドポイント（family_id / call_id / album_id を扱う）

`docs/api/openapi.yaml` が API 契約の正。以下は backend ルーターから抽出した「他人のリソースを
参照/変更し得る」経路。**手動 IDOR テストの主対象**（§6）。

| メソッド・パス | 認証 | 帰属チェック（正） | ファイル |
| --- | --- | --- | --- |
| `GET /albums` | 家族 Bearer | `Call.family_id == user.family_id` | `api/albums.py:57` |
| `GET /albums/latest` | X-Device-Token | `Call.family_id == device.family_id` | `api/albums.py:29` |
| `DELETE /albums/{album_id}` | 家族 Bearer＋`role=owner` | `call.family_id != user.family_id` を 404 で秘匿 | `api/albums.py:192` |
| `GET /calls/{call_id}/candidates` | 家族 Bearer | `_owned_call`（`call.family_id` 一致） | `api/media.py:144` |
| `POST /calls/{call_id}/selection` | 家族 Bearer | `_owned_call` | `api/media.py:205` |
| `POST /media/register` | 家族 Bearer | `_owned_call` | `api/media.py:58` |
| `POST /media/upload-sas` | 家族 Bearer | `_owned_call` ＋ SAS スコープ（**F-1 要確認**） | `api/media.py:120` |
| `POST /calls` | 家族 Bearer | `device.family_id != user.family_id` を 404 | `api/calls.py:39` |
| `POST /calls/{call_id}/answer` | X-Device-Token | `call.device_id != device.id` を 404 | `api/calls.py:135` |
| `POST /calls/{call_id}/end` | 家族 or デバイス | 家族=family_id / デバイス=device_id 一致 | `api/calls.py:170` |

> [!note] レビュー所見（良い点）
> `[仕様]` 帰属しないリソースは **存在を秘匿して 404** を返す実装（`DELETE /albums`・`_owned_call`）が
> 一貫している。IDOR 対策として妥当な設計。手動テストではこの 404/403 が本当に返るかを実測で確かめる。

### 1-3. メディアの保存先（Blob / SAS）

- 保存先: **Azure Blob Storage（東日本）**。コンテナは `MEDIA_CONTAINER`（既定 `media`）。
  DB（PostgreSQL）は台帳で、メディア実体は持たない（`CLAUDE.md` 設計判断）。
- アクセス方式: **非公開コンテナ＋SAS（署名付きURL）のみ**の設計。
  - 閲覧 SAS: `services/blob.py::view_sas_url` … `read`・**15分**・Blob 単位（`generate_blob_sas`）。
  - アップロード SAS: `services/blob.py::upload_sas_url` … `create+write`・**1時間**。
    **実装は `generate_container_sas`（コンテナ全体スコープ）**で発行し、URL のパスだけを
    当該通話プレフィックスに向けている（→ **F-1 要確認**）。
- コンテナ作成: `blob.py::ensure_container` は `create_container` のみ（public access 指定なし＝既定 private）。
  **ただし Azure 側で匿名アクセスが有効化されていないかは③ CSPM＋手動で要確認**（F-2）。

---

## 2. QA コードレビューで事前に検出した要確認事項（ツール前の観点）

ツールを流す前に、QA レビュー（正確性・セキュリティ・保守性）で気づいた論点を先に挙げる。
**ツールでは検出されにくい設計・契約レベルの指摘**であり、手動テスト（§6）とレポートで裏取りする。

> [!warning] F-1 アップロード SAS のスコープがコンテナ全体（重大度: Major／要確認・要 DAST/手動裏取り）
> - 該当: `backend/app/services/blob.py::upload_sas_url`（L85-102）
> - 根拠: `[仕様]` `docs/data-contract.md §2` は「アップロード用 SAS は**当該通話のプレフィックス限定**」を約束。
>   `[仕様]` 同関数の docstring も「スコープは当該通話のプレフィックスに限定する」と明記。
> - 実態: 実装は `generate_container_sas`（`create+write`）で**コンテナ全体に有効な SAS トークン**を発行し、
>   返す URL のパスだけを当該プレフィックスに向けている。SAS トークン自体はプレフィックスに束縛されないため、
>   **払い出された SAS を持つ家族が URL のパスを他家族のプレフィックス
>   `families/{別のfamily_id}/...` に書き換えると、他家族領域へ書き込める可能性**がある（クロステナント書き込み＝IDOR/権限昇格）。
> - 推奨対応: 署名付きポリシーで**プレフィックス/Blob 単位に絞る**（`generate_blob_sas` を対象 Blob ごとに発行、
>   または stored access policy＋パス制限、ユーザーデリゲーション SAS 等）。**§6 手動テストの検証項目④として実証**する。
> - 位置づけ: 契約と実装の乖離。エンプラ水準では要修正候補。**断定はせず「要確認」**とし、手動で再現可否を確かめる。

> [!warning] F-2 Blob 匿名アクセスの確認（重大度: Major／③ CSPM＋手動）
> - 根拠: `[仕様]` `CLAUDE.md`「Blob は非公開＋SAS のみ」。`[規定]` [[セキュリティ規定]]§4 権限最小化。
> - 実態: コード上コンテナは既定 private だが、**Azure ストレージアカウント/コンテナの匿名アクセス許可
>   （Blob public access）設定はコード外**。誤って有効だと SAS 無しで
>   `https://<account>.blob.core.windows.net/media/families/.../v1.mp4` が直接読める。
> - 推奨対応: ③ CSPM の該当項目（§5）と、手動での匿名 GET（§6 検証項目③）で確認する。

> [!warning] F-3 開発用固定トークン（DEV_FAMILY_TOKEN）の裏口（重大度: Major／本番前必須）
> - 該当: `deps.py::require_family`（L154）・`frontend/src/lib/auth-stub.ts`。
> - 根拠: `[規定]` [[セキュリティ規定]]§4（本番認証情報の分離）。`CLAUDE.md`「認証の未完了課題（本番前）」でも課題として明記。
> - 実態: `DEV_FAMILY_TOKEN` 一致で owner に解決する裏口が、プロバイダ有効時も**併存**する。
>   クラウドはランダム値へローテーション済みだが、**裏口自体は残存**。エンプラ水準では本番で完全失効が必要。
> - 推奨対応: 本番では `DEV_FAMILY_TOKEN` を空/無効化し、プロバイダ認証のみにする。**手動テストで裏口の生死を確認**（§6 補助）。

> [!warning] F-4 依存パッケージのバージョン未固定（重大度: Minor／SCA の前提）
> - 該当: `backend/requirements.txt`（`fastapi` 等がバージョン指定なし）。`frontend/package.json`（`^` 範囲指定）。
> - 根拠: `[規定]` [[セキュリティ規定]]§3「可能な範囲でバージョンを固定し、監査コマンドを活用する」。
> - 影響: SCA（① Snyk）の結果が実行時に変わり、**再現性・監査性が下がる**。lockfile の有無も確認
>   （`package-lock.json` / `requirements` のピン止め）。SCA 実行時に「どのバージョンを検査したか」を必ず記録する。

> [!note] F-5 Entra の scp 検証が「存在すれば確認」（重大度: 要確認・Nit〜Minor）
> - 該当: `backend/app/core/entra.py`（L138-146）。
> - 内容: `scp` クレームが**無い**場合はスコープ確認をスキップして通す実装。v2.0 アクセストークンでは通常
>   `scp`（委任）または `roles`（アプリ権限）が付くため実害は限定的だが、`access_as_user` の強制が緩い。
> - 推奨対応: 有効化（Entra クライアントID 設定）後の実トークンで `scp` が入ることを実サインインで確認（受入時）。**要確認**。

---

## 3. 総括レポート（実行後に埋める）

各チェック完了後、ここに要点を1行で集約する（詳細は各章のレポート表）。判定は **通過 / 要修正 / 要確認**。

| チェック | 実行主体 | 実行日 | 検出（Critical/High/Med/Low） | 判定 | 対応要否 | 備考 |
| --- | --- | --- | --- | --- | --- | --- |
| ① SCA（frontend） | 🟢 | | | | | |
| ① SCA（backend） | 🟢 | | | | | |
| ② SAST（snyk code） | 🟢 | | | | | |
| ③ CSPM（Defender） | 🟡 | | | | | |
| ④ DAST（ZAP） | 🔵 | | | | | |
| 手動 IDOR | 🔵 | | | | | |
| F-1 upload-sas スコープ | 🔵 | | | | | 契約乖離の裏取り |
| F-2 Blob 匿名アクセス | 🟡 | | | | | ③＋手動 |
| F-3 DEV トークン裏口 | 🔵 | | | | | 本番前失効 |

---

## 4. ① SCA — Snyk（依存パッケージの既知脆弱性）

**目的**: frontend / backend が使う**第三者ライブラリの既知脆弱性（CVE）**を検出する。自作コードではなく依存が対象。

- 実行主体: 🟢 **Claude 実行可能**（ローカルでコマンド実行）。ただし `snyk auth` の**初回ブラウザ認証は 🟡 統括**。
- 前提: **Snyk 無料枠（Free）** で SCA（Open Source）は利用可能。テスト回数に月次上限があるため、
  むやみに連打しない。クラウド（snyk.io）にプロジェクトのメタデータが送られる点に留意（W3）。

### 4-1. セットアップ（初回のみ）

```bash
# Snyk CLI 導入（Node があれば npm、無ければ Homebrew）
npm install -g snyk
# もしくは: brew install snyk-cli

# 認証（初回。ブラウザが開き Snyk アカウントで承認 → CLI にトークンが保存される）
# ※ このブラウザ承認は統括（人）が実施する。無料アカウントで可。
snyk auth
```

### 4-2. frontend（npm）の SCA

```bash
cd /Users/mitsuru/Desktop/toolmaker/apps/TV_MVP/frontend

# 依存を実体化（lockfile が無い場合。既にあるならスキップ可）
npm install

# 依存脆弱性スキャン（本番依存のみに絞る場合は --prod）
snyk test --file=package.json --severity-threshold=low

# 参考: Snyk を使わず標準ツールでも一次確認できる（無料・オフライン）
npm audit
```

### 4-3. backend（pip）の SCA

```bash
cd /Users/mitsuru/Desktop/toolmaker/apps/TV_MVP/backend

# Snyk は requirements.txt を解析できるが、バージョン未固定（F-4）だと解決が不安定。
# まず現在の解決結果を固定した一時ファイルを作ると再現性が上がる。
python3 -m venv .venv-scan && . .venv-scan/bin/activate
pip install -r requirements.txt
pip freeze > requirements.lock.txt   # 検査した実バージョンを記録（レポートに添付）

# Snyk による Python 依存スキャン
snyk test --file=requirements.txt --package-manager=pip --severity-threshold=low

# 参考: pip-audit（PyPA 公式・無料・オフライン寄り）でも確認
pip install pip-audit && pip-audit -r requirements.txt
deactivate
```

### 4-3-1. 結果の読み方（CVE / severity）

- **severity**: `critical` / `high` / `medium` / `low`。エンプラ最低ラインでは **Critical / High を優先対応**、
  Medium は影響評価のうえ判断、Low は記録のみでも可。
- **各指摘の見どころ**:
  - `CVE-xxxx-yyyy` / `SNYK-...` … 脆弱性 ID。
  - `Introduced through` … どの依存経由か（直接 or 推移的）。推移的なら親の更新で解消することが多い。
  - `Fixed in` / `Remediation` … 修正版バージョン。`snyk test` は「このバージョンに上げれば直る」を提示する。
  - `Exploit maturity` … 実際の悪用可能性（`Mature` は要注意）。
- **判定の目安**: Critical/High が1件でもあれば **要修正**。ただし**修正版が MVP の他要件を壊さないか**は
  QA が回帰（vitest / pytest）で確認してから上げる。

### 4-4. レポート表（SCA）

| 対象 | パッケージ | 脆弱性ID(CVE/SNYK) | severity | 概要 | 修正版 | 対応要否 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| frontend | | | | | | | |
| backend | | | | | | | |

- 検査したバージョン記録: frontend=`package-lock.json` / backend=`requirements.lock.txt` を添付。
- 総括: Critical __件 / High __件 / Medium __件 / Low __件 → 判定: __________

---

## 5. ② SAST — Snyk Code（自作コードの静的解析）

**目的**: 自分たちが書いたコード（Python/TypeScript）の**脆弱パターン**を静的に検出する。
SQLi・XSS・パストラバーサル・ハードコード秘密情報など。

- 実行主体: 🟢 **Claude 実行可能**（`snyk code test`）。認証は §4-1 と共通。
- 前提: Snyk Code（SAST）も Free プランで一定回数利用可。ソースがクラウド解析に送られる点に留意（W3）。
  秘匿ファイル（`.env`・`cloud.env`）は `.gitignore` 済みだが、**スキャン対象から明示除外**しておく。

### 5-1. 実行

```bash
cd /Users/mitsuru/Desktop/toolmaker/apps/TV_MVP

# リポジトリ全体の SAST（自作コード対象）
snyk code test --severity-threshold=low

# サブツリーを分けて見たい場合
snyk code test backend --severity-threshold=low
snyk code test frontend --severity-threshold=low
```

`.snyk` で除外設定を置ける（秘匿・生成物・テスト固定値の誤検知を抑える）:

```yaml
# /Users/mitsuru/Desktop/toolmaker/apps/TV_MVP/.snyk
exclude:
  global:
    - "**/.env*"
    - "**/cloud.env"
    - "frontend/out/**"
    - "**/node_modules/**"
    - "**/.venv*/**"
```

### 5-2. 本アプリで重点的に見る観点（コードに即して）

| 観点 | 本アプリでの着目点 | 該当 |
| --- | --- | --- |
| SQLi | ORM（SQLAlchemy 2.0 `select()`）中心で生 SQL は基本なし。生文字列連結の SQL が無いかを確認 | `backend/app/api/*`・`db/` |
| パストラバーサル | `POST /media/upload-sas` が **`filename` をそのまま `storage_key` に連結**（`media.py:134`）。`../` 等で通話プレフィックス外へ抜けないか（F-1 と関連） | `api/media.py`・`core/paths.py` |
| XSS | Next.js は既定エスケープ。`dangerouslySetInnerHTML` の有無、SAS URL の生表示を確認 | `frontend/src/app/**` |
| ハードコード秘密情報 | トークン・キー直書きが無いか。`auth-stub.ts` は env 化済み（F-3 は裏口として別途）。SAST が偽検知しやすい領域 | 全体 |
| 認証・認可 | JWT 検証（`entra.py`/`google.py`）の危険オプション（署名検証オフ等）。`_peek_unverified_issuer` は**振り分け専用で信用しない**設計を確認済み | `core/entra.py`・`core/google.py`・`api/deps.py` |

> [!note] レビュー補足
> `deps.py::_peek_unverified_issuer` は `verify_signature: False` でデコードするが、**iss の振り分けにのみ使い、
> 実際の検証は各プロバイダ検証器が行う**設計（コメントにも明記）。SAST がここを「署名検証なし」と
> フラグする可能性があるが、**設計上は妥当**。レポートでは False Positive として根拠付きで扱う。

### 5-3. レポート表（SAST）

| ファイル:行 | ルール/カテゴリ | severity | 概要 | 真陽性/偽陽性 | 推奨対応 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

- 総括: Critical __件 / High __件 / Medium __件 / Low __件（うち偽陽性 __件）→ 判定: __________

---

## 6. ⑤ 手動 IDOR テスト（最優先・ツールでは検出不能）

**目的**: 認可の穴（他人のリソースへのアクセス）を人手で突く。**ツールで最も見つけにくく、
本アプリで最も重要**（家族ごとの写真・動画＝PII を扱うため）。

- 実行主体: 🔵 **併走**（Claude がコマンド/スクリプトを準備、実行と判断は統括）。
- 対象: **ローカル起動したアプリ**のみ（W2/W4）。テスト用の家族 A / B を作って行う。
- 合格基準: 他人の `album_id` / `call_id` を直叩きして **401 / 403 / 404 なら OK**、**200 で他人のデータが返れば重大バグ（Blocker）**。

### 6-1. ローカル起動（テスト対象）

```bash
cd /Users/mitsuru/Desktop/toolmaker/apps/TV_MVP

# DB(postgres@5433)＋Blob/Queue(Azurite) を起動（手順は docs/dev-setup.md §1-2）
docker compose up -d

# backend 起動（別ターミナル。手順は dev-setup.md §4）
cd backend
uvicorn app.main:app --reload --port 8000
# → http://localhost:8000  （OpenAPI: http://localhost:8000/docs）
```

### 6-2. アカウント A / B の用意（家族スコープを2つ作る）

MVP はローカルでは `DEV_FAMILY_TOKEN`（既定 `dev-fixed-token`）で **単一の owner** に解決されるため、
**IDOR を本当に検証するには「別家族」を2つ用意する**必要がある。方法は2通り:

- **方法1（推奨・プロバイダ有効化）**: Google/Entra を有効化し、**別々の Google/MS アカウント**で
  サインイン → `deps.py::_provision_or_get_by_auth_id` が **家族A / 家族B を自動作成**する。
  各ブラウザ DevTools の Network で `Authorization: Bearer <token>` を控える（→ 6-3）。対話ログインは 🟡 統括。
- **方法2（DB シードで2家族）**: テスト用に family/owner/device を2組シードし、
  それぞれの Bearer（または dev トークン相当）を用意する。`backend/scripts/seed.py` を土台に
  A/B 2家族版の一時シードを作る（Claude が用意可）。**本番 DB では絶対に行わない**（ローカル専用）。

> 検証には最低限、**家族 A のトークン `TOKEN_A`** と **家族 B のトークン `TOKEN_B`**、
> および **家族 A が保有する `ALBUM_ID_A` / `CALL_ID_A`** が必要。

### 6-3. 手順（メンター提示の流れをこのアプリに当てはめる）

1. **A でログインし、自分のリソース ID を控える**
   DevTools → Network を開いた状態で家族 A の閲覧 UI（`/album`）を操作し、
   `GET /albums` のレスポンスから **`album_id`（=`ALBUM_ID_A`）** と、候補取得で使う **`call_id`（=`CALL_ID_A`）**、
   および API パス（`/albums`・`/calls/{call_id}/candidates` 等）を控える。

```bash
# 変数に控える（実値に置き換え）
export API=http://localhost:8000
export TOKEN_A='＜家族AのBearer＞'
export TOKEN_B='＜家族BのBearer＞'
export ALBUM_ID_A='＜家族A所有のalbum_id＞'
export CALL_ID_A='＜家族A所有のcall_id＞'

# まず A 自身では 200 で見えることを確認（正常系のベースライン）
curl -s -o /dev/null -w "A→A candidates: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN_A" \
  "$API/calls/$CALL_ID_A/candidates"
```

2. **B のトークンで A の `album_id` / `call_id` を直叩き（本題）**

```bash
# ① B が A の候補一覧を覗けるか（期待: 404）
curl -s -o /dev/null -w "B→A candidates: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN_B" \
  "$API/calls/$CALL_ID_A/candidates"

# ② B が A のアルバムを削除できるか（期待: 404。owner でも他家族は不可）
curl -s -o /dev/null -w "B→A delete album: %{http_code}\n" \
  -X DELETE -H "Authorization: Bearer $TOKEN_B" \
  "$API/albums/$ALBUM_ID_A"

# ③ B が A の通話に選択確定を送れるか（期待: 404）
curl -s -o /dev/null -w "B→A selection: %{http_code}\n" \
  -X POST -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" \
  -d '{"memory_ids":["00000000-0000-0000-0000-000000000000"]}' \
  "$API/calls/$CALL_ID_A/selection"

# ④ B が A の通話へ upload-sas を要求できるか（期待: 404）
curl -s -o /dev/null -w "B→A upload-sas: %{http_code}\n" \
  -X POST -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" \
  -d "{\"call_id\":\"$CALL_ID_A\",\"filenames\":[\"x.jpg\"]}" \
  "$API/media/upload-sas"
```

> **判定**: いずれも **401/403/404 なら OK**。**200（かつ他家族データが返る/変更できる）は Blocker**。

### 6-4. メンター指摘の「3つの抜け道」も検証

**抜け道A: トークン未検証（ヘッダ差し替え）**

```bash
# 空/でたらめ Bearer（期待: すべて 401）
for T in '' 'Bearer' 'Bearer garbage' 'Bearer null'; do
  curl -s -o /dev/null -w "no-auth [$T]: %{http_code}\n" \
    -H "Authorization: $T" "$API/albums"
done

# dev 固定トークンの裏口が本番想定で生きていないか（F-3。ローカルは通る想定）
curl -s -o /dev/null -w "dev-token: %{http_code}\n" \
  -H "Authorization: Bearer dev-fixed-token" "$API/albums"
```

- 期待: 無/空/不正 Bearer は **401**（`require_family` L146-150）。
- **本番相当環境**では `dev-fixed-token` が **401 になるべき**（F-3）。ローカルでは通る（裏口）。この差を記録する。

**抜け道B: 画像/動画 URL の推測可能性（SAS 無し直アクセス）**

```bash
# SAS を外した生 Blob URL に匿名アクセスできないか（期待: 失敗＝AuthenticationFailed / 404）
# 例: view_sas_url が返す URL から "?..." 以降（SAS）を削って叩く。
# ローカル Azurite の例（実 URL は API レスポンスの sas_url から取得して置換）:
curl -s -o /dev/null -w "blob no-SAS: %{http_code}\n" \
  "http://127.0.0.1:10000/devstoreaccount1/media/families/＜family_id＞/calls/＜call_id＞/albums/v1.mp4"
```

- 期待: **SAS 無しでは 4xx**（非公開コンテナ）。**200 で中身が返れば重大（F-2）**。
- あわせて **SAS の有効期限**を確認（`view_sas_url` は 15分）。期限切れ SAS が 4xx になることも確認。

**抜け道C: SAS スコープ越境（F-1 の裏取り・upload-sas）**

```bash
# 1) A が自分の通話で upload-sas を取得
UP=$(curl -s -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d "{\"call_id\":\"$CALL_ID_A\",\"filenames\":[\"legit.jpg\"]}" \
  "$API/media/upload-sas")
echo "$UP"   # upload_url（?以降が SAS トークン）を控える

# 2) 取得した SAS の「パス部分だけ」を他家族プレフィックスに書き換えて PUT できるか試す
#    （generate_container_sas ならコンテナ全体に効くため通ってしまう懸念＝F-1）。
#    upload_url を  .../media/families/＜別のfamily_id＞/calls/＜任意＞/evil.jpg?<同じSAS>  に改変して:
curl -s -o /dev/null -w "cross-prefix PUT: %{http_code}\n" \
  -X PUT -H "x-ms-blob-type: BlockBlob" --data-binary 'test' \
  "http://127.0.0.1:10000/devstoreaccount1/media/families/＜別family_id＞/calls/xxxx/evil.jpg?＜Aが得たSASトークン＞"
```

- 期待（あるべき姿）: **403 / AuthorizationFailure**（プレフィックス外は書けない）。
- **もし 201/PUT 成功なら F-1 が現実の脆弱性**（他家族領域へ書き込み可能）＝ **Blocker 候補**。要修正。

### 6-5. レポート表（手動 IDOR）

| # | シナリオ | 実行コマンド | 期待 | 実測 status | 判定 | 重大度 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | B→A candidates 直叩き | 6-3 ① | 404 | | | |
| 2 | B→A album 削除 | 6-3 ② | 404 | | | |
| 3 | B→A selection | 6-3 ③ | 404 | | | |
| 4 | B→A upload-sas | 6-3 ④ | 404 | | | |
| A | 無/空/不正 Bearer | 6-4 A | 401 | | | |
| A' | dev トークン裏口（本番相当） | 6-4 A | 401（本番） | | | |
| B | SAS 無し Blob 直読み | 6-4 B | 4xx | | | |
| C | SAS スコープ越境 PUT | 6-4 C | 403 | | | |

---

## 7. ③ CSPM — Microsoft Defender for Cloud（人が実施するチェックリスト）

> [!danger] 実行主体: 🟡 統括の手作業＋ダブルチェック（W1）
> - **Claude は Azure ポータルを操作できない。** 本章は**人が Azure ポータルで確認する項目表**。
> - **Defender for Cloud のプラン（有料）を安易に「有効化」しない。** 課金が発生する。
>   まず**無料の Foundational CSPM（セキュア スコア・推奨事項）**の範囲で確認し、
>   有料プラン有効化が必要かは統括が判断（費用影響を見てから）。**設定変更前に必ずダブルチェック**。

### 7-1. 事前情報（対象リソース）

- リソースグループ: `rg-001-gen12`（東日本）、命名サフィックス `73bb`（`infra/README.md` 参照）。
- 主な対象: PostgreSQL Flexible Server / Storage Account（`media`・`pipeline-jobs`）/
  Container Apps（`ca-tvmvp-api`・`ca-tvmvp-worker`）/ Azure OpenAI（`oai-tvmvp-73bb`）/
  Speech（`speech-tvmvp-73bb`）/ Static Web Apps。

### 7-2. 人手チェック項目（ポータル: Defender for Cloud → 推奨事項 / 各リソース設定）

| # | 確認項目 | あるべき状態 | 根拠 | 結果 | 対応要否 |
| --- | --- | --- | --- | --- | --- |
| C1 | **Storage の匿名 Blob アクセス** | 「BLOB パブリック アクセス」＝**無効**（F-2） | [[セキュリティ規定]]§4・CLAUDE.md「非公開＋SAS のみ」 | | |
| C2 | **Storage の「安全な転送（HTTPS のみ）」** | 有効 | 通信の暗号化 | | |
| C3 | **Storage のネットワーク公開範囲** | 可能なら選択ネットワーク限定／最小 | 権限最小化 | | |
| C4 | **PostgreSQL のファイアウォール** | **`0.0.0.0 - 255.255.255.255`（全開放）でない**こと。`Allow public access from any Azure service`＋広域許可を確認 | [[セキュリティ規定]]§4 | | |
| C5 | **PostgreSQL の SSL/TLS 強制** | `require_secure_transport=ON` 相当 | 通信暗号化 | | |
| C6 | **秘密の保管** | 本番秘密は **Key Vault＋マネージド ID**（`.env` 直書きでない） | CLAUDE.md「本番秘密は Key Vault」 | | |
| C7 | **Container Apps の Ingress** | `ca-tvmvp-worker` は Ingress 無し／`ca-tvmvp-api` は必要ポートのみ外部公開 | 最小公開 | | |
| C8 | **診断ログ/監視** | 主要リソースで診断設定/監視が有効（インシデント検知の前提） | リリース後確認（[[リリース規定]]） | | |
| C9 | **Defender セキュア スコア** | スコアと High 推奨事項を記録。**有料プラン有効化はしない（判断のみ）** | W1 | | |
| C10 | **CORS（Storage/API）** | 許可オリジンが本番ドメインに限定（ワイルドカード放置でない）。`blob.py::set_cors` はローカル用 | 権限最小化 | | |

### 7-3. レポート（CSPM）

- セキュア スコア: ______ / High 推奨事項: ______ 件
- 要修正項目（C1〜C10 で NG のもの）: ______________________________
- 判定: ____________（有料プラン有効化の要否も統括判断で記載）

---

## 8. ④ DAST — OWASP ZAP（動的スキャン・ローカル・認証あり）

> [!danger] 実行主体: 🔵 併走（実行は 🟡 統括寄り）／対象は必ずローカル（W2）
> - **本番 SWA・Azure 稼働環境・他者サイトへは絶対に実行しない**（不正アクセス/規約違反）。
> - `localhost` に立てた backend/frontend のみを対象にする。テスト用アカウント・テスト DB のみ。

### 8-1. セットアップ

```bash
# ZAP 導入（macOS）
brew install --cask zap
# もしくは Docker 版（CI/自動化向き）:
docker pull ghcr.io/zaproxy/zaproxy:stable
```

ローカル対象を起動（§6-1 と同じ。frontend も見るなら別ターミナルで）:

```bash
cd /Users/mitsuru/Desktop/toolmaker/apps/TV_MVP/frontend
npm install && npm run dev    # → http://localhost:3000
# backend は http://localhost:8000（§6-1）
```

### 8-2. Automated Scan（まず API を対象に）

**GUI（ZAP Desktop）**:
1. `Automated Scan` を開く → 対象 URL に `http://localhost:8000`（API）を入力。
2. `traditional spider` を ON、`ajax spider` は SPA（frontend）を見るとき ON。
3. `Attack` 実行 → 完了後 `Report > Generate HTML Report`。

**Docker（ベースライン。まず受動スキャンで様子を見る）**:

```bash
# ベースライン（受動中心・非破壊寄り）。localhost をコンテナから見るため host ネットワーク指定。
docker run --rm --network host -v "$PWD:/zap/wrk:rw" \
  ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t http://localhost:8000 -r zap-baseline-report.html
```

### 8-3. 認証を通したスキャン（Context / User）

**認証後ろの API を検査しないと意味が薄い**（`/albums` 等は 401 で弾かれるだけになる）。ZAP に Bearer を持たせる。

- **手軽な方法（Replacer で全リクエストに Authorization を付与）**:
  ZAP → `Tools > Options > Replacer` → ルール追加:
  - Match Type: `Request Header (will add if not present)`
  - Header: `Authorization`／Value: `Bearer ＜TOKEN_A＞`（§6 で用意したテスト家族 A のトークン）
- **Context/User 認証（本格版）**:
  1. `http://localhost:8000` を Context に追加。
  2. `Authentication` = `Script-based` か `HTTP Header`、トークンを User に紐付け。
  3. `Users` に家族 A を作成 → スキャンで「認証済みユーザー」として実行。
  4. `Spider`（認証済み）→ `Active Scan` の順で実行。

> [!note] IDOR は DAST 単独では見抜きにくい
> ZAP の自動スキャンは XSS/SQLi/ヘッダ不備等は拾うが、**IDOR（横方向の認可）は自動検出が弱い**。
> ZAP は「認証あり/なしの差分」まで、**IDOR の本丸は §6 手動テスト**で確認する（役割分担を明記）。

### 8-4. 見る観点（本アプリ）

- セキュリティヘッダ（`Content-Security-Policy` / `X-Content-Type-Options` / `Strict-Transport-Security` 等）の有無。
- エラー時の情報漏洩（スタックトレース露出など）。FastAPI 既定の 4xx/5xx 応答が過剰情報を返さないか。
- CORS 応答ヘッダ（`main.py` は `CORS_ALLOW_ORIGINS` 環境変数。許可オリジンが緩すぎないか）。
- 入力検証（`limit`・`cursor`・`status` 等のクエリ。`albums.py` は範囲チェックあり＝良い点）。

### 8-5. レポート表（DAST）

| Alert | Risk(High/Med/Low/Info) | URL/パラメータ | 概要 | 真陽性/偽陽性 | 推奨対応 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

- 総括: High __ / Med __ / Low __ / Info __ → 判定: __________

---

## 9. まとめと運用

- **優先順位**: ①②（依存・自作コードの静的検出）→ ⑤手動 IDOR（最重要）→ ④DAST → ③CSPM（統括手作業）。
  **手動 IDOR と F-1（SAS スコープ）を最優先**で裏取りする（PII を扱うサービスの生命線）。
- **判定とリリース**: 検出結果は本書のレポート表に記入し、**判定（通過/要修正/要確認）と対応方針**を
  統括に提示 → [[リリース規定]] に沿って**統括の明示的承認**を得てから修正/リリースへ進む。
- **QA からの事前所見（§2）**は、ツール結果と突き合わせて最終判定する。特に **F-1 / F-2 / F-3** は
  エンプラ水準では対応必須の候補。ただし本書時点では**実行前のため断定せず「要確認」**とし、
  スキャン・手動テストの実測で確定させる。
- **記録**: 頻出パターン・観点は [[01_ナレッジ/README|ナレッジ]] へ還元（整備は [[ハローキティ]]）。
  レビュー結果の正本は Obsidian（[[Slack運用規定]]）。Slack には判定と要点のみを流す。

---

## 付録: チェック項目 × 実行主体 早見表

| チェック | ツール | 実行主体 | 課金/対話の注意 |
| --- | --- | --- | --- |
| ① SCA | Snyk Open Source / npm audit / pip-audit | 🟢 Claude（認証は🟡） | Free 枠・回数上限・クラウド送信 |
| ② SAST | Snyk Code | 🟢 Claude（認証は🟡） | Free 枠・ソースがクラウド解析へ |
| ③ CSPM | Defender for Cloud | 🟡 統括＋ダブルチェック | **有料プラン有効化で課金**。無効化のまま推奨事項確認 |
| ④ DAST | OWASP ZAP | 🔵 併走（実行🟡寄り） | **ローカルのみ**・本番/他者禁止 |
| ⑤ 手動 IDOR | curl / DevTools | 🔵 併走 | ローカル・テストDBのみ |

> 関連: [[レビュー規定]] / [[セキュリティ規定]] / [[リリース規定]] / `docs/api/openapi.yaml` / `docs/data-contract.md` / `infra/README.md`
