# worker

常駐ワーカー。**担当: 委託コア③（通話後パイプライン）**

`pipeline-jobs` キューをポーリングし、`job_type`（score / auto_confirm / render）で分岐する。
メッセージ形式・投函ルール・冪等性・可視性タイムアウト・毒メッセージ処理は
`docs/data-contract.md` §3/§4 に準拠する。

## 2段階構成

- **第1段（stage1: score）** `stages/stage1_scoring.py`
  写真候補をスコアリング（`score = 0.6*rms_rise正規化 + 0.4*face_score`・無表情ゲート付き）し、
  `album`（`awaiting_selection`・`presented_at=now`）を作成して候補提示する。
  提示と同時に、5分自動確定用の `auto_confirm` を可視化遅延300秒で投函する。
- **auto_confirm（時限処理）** `stages/auto_confirm.py`
  候補提示から遅延後に取り出される。`albums.status` が `awaiting_selection` のままなら
  上位5枚（スコア順）で自動確定し `generating` へ遷移して `render` を投函。
  家族が既に選択確定済みなら何もしない（冪等）。
- **第2段（stage2: render）** `stages/stage2_video.py`
  `generating` のときのみ処理。選択5枚を Blob からDL → タイトル・キャプション付与
  （`stages/labels.py` の定型フォールバック）→ BGM 付与（無ければ無音）→
  FFmpeg でハイライト動画生成（`stages/ffmpeg_render.py`。クロスフェード版→失敗時 concat）→
  Blob アップロード → `album.status=ready`。未選択候補に `delete_after` タグを付与する。

## モジュール構成

| ファイル | 役割 |
| --- | --- |
| `main.py` | ポーリングループ・job_type 分岐・毒メッセージ処理。`--once` で空になるまで処理して終了 |
| `bootstrap.py` | backend/ を `sys.path` に追加し `app.*`（モデル・設定）を再利用可能にする |
| `services.py` | ワーカー用 Blob（DL/UP/タグ）・Queue（受信/削除/可視化遅延投函）クライアント |
| `stages/stage1_scoring.py` | score（スコアリング・無表情ゲート・提示・auto_confirm 投函） |
| `stages/auto_confirm.py` | auto_confirm（上位5枚自動確定・generating 遷移・render 投函） |
| `stages/stage2_video.py` | render（DL・ラベル・BGM・FFmpeg・UP・delete_after タグ） |
| `stages/ffmpeg_render.py` | FFmpeg コマンド組み立て・実行（xfade / concat フォールバック） |
| `stages/labels.py` | タイトル・キャプション（FallbackLabelProvider / Azure OpenAI スタブ） |
| `assets/bgm/` | 支給BGM（A12）。無い場合は無音でフォールバック |

## 前提・起動

- 実行は **backend/.venv の python** を使う（backend の依存・モデルを再利用するため）。
- FFmpeg はローカルにインストール済みであること（`ffmpeg` / `ffprobe`）。
- 起動手順・デモの実行は `docs/dev-setup.md`「worker の起動」「デモパイプラインの実行」を参照。

```bash
cd /Users/mitsuru/Desktop/MyDocs/outputs/TV_MVP
backend/.venv/bin/python worker/main.py          # 常駐ポーリング（空なら2秒待ち）
backend/.venv/bin/python worker/main.py --once    # 空になるまで処理して終了（テスト・デモ用）
```

## チューニング定数（初期値・検収対象外）

- 無表情ゲート閾値 `FACE_GATE_THRESHOLD = 0.1`（`stages/stage1_scoring.py`）
- auto_confirm 可視化遅延: 既定300秒。環境変数 `AUTO_CONFIRM_DELAY_SECONDS` で短縮可（デモ用）
