# 検知パラメータ

支給物A6の雛形。通話中検知（RMS/MediaPipe/STT）の初期パラメータ案。
実測で調整する前提の初期値であり、チューニングは検収対象外とする。

| パラメータ | 初期値 |
| --- | --- |
| RMS発火しきい値（baseline比上昇 riseThresholdDb） | **+6dB** |
| EMA（指数移動平均）τ | 3〜5秒（初期値4秒）**／ウォームアップ: 有声3秒は τ=1s（コールドスタート緩和・修正4）** |
| 検知の持続時間（sustainMs） | 150〜300ms（**初期値150ms**） |
| クールダウン（cooldownMs） | 3〜5秒（初期値4秒） |
| VADゲート（vadFloorDb） | -55dB（初期値）**／家族側は自動化: ノイズフロア推定 → 床=ノイズ+8dB・[-70,-45] クランプを1秒ごとに反映（`audioPipeline`→`rmsTrigger.setVadFloorDb`）** |
| 連写枚数・間隔 | 10枚・約2秒間・200ms間隔 |
| スニペット範囲 | 検知前2秒＋検知後3秒 |
| AGC（自動ゲイン制御） | オフ（送信側で設定）**／実装済み（`agoraCall.ts`：高齢者側 join=uid=2 で `AGC:false`。AEC=維持・ANS=既定）** |
| 自動ゲイン（送信側の発話レベル正規化） | **有効化（`autoGain.ts`：高齢者側 uid=2 のみ）。目標 -30dBFS・有声RMS EMA τ≈3s・更新2秒ごと・スルーレート±2dB/更新・クランプ 0〜+18dB。AGC の代替ではなく“ゆっくり正規化”（相対上昇検知を壊さない）** |

> 実測で調整。チューニングは検収対象外。
> 実装の正は `frontend/src/modules/detection/rmsTrigger.ts` の `DEFAULT_RMS_PARAMS`。

## 初期値の変更履歴

初期値の更新は「支給初期値の改訂」であり、検収条件（機能）は不変。

- **2026-07-05**: オーナー実測フィードバック（実カメラ通話で RMS 発火が渋い）により、
  RMS発火感度を上げる。`riseThresholdDb` **+8dB → +6dB**、`sustainMs` **200ms → 150ms**。
  クールダウン（4秒）・VADゲート（-55dB）は据え置き。
- **2026-07-05（発火まわり4修正）**:
  - **baseline ウォームアップ追加（コールドスタート緩和・修正4）**: 通話冒頭の有声サンプル
    累計3秒（`warmupMs=3000`）までは baseline の EMA を速い τ=1s（`warmupTauMs=1000`）で
    順応させ、その後は通常運転 τ=4s に戻す。通話冒頭にいきなり叫んだケースでも基準が数秒で
    平常側へ降り、追加の発話で発火できる。「初回有声サンプル=baseline 確定」の挙動は不変。
  - **AGC 無効化を実装（修正2）**: 高齢者側（送信側・uid=2）マイクの `AGC:false` を
    `frontend/src/modules/call/agoraCall.ts` で明示（AEC=維持・ANS=既定）。上表 AGC 行に反映。
  - **発火キャプチャの全体タイムアウト＋スニペット内部タイムアウト（修正1）**: 発火処理が
    settle しない await で永久 busy 化するのを根絶。詳細は実装（`index.ts`／`audioPipeline.ts`）。
- **2026-07-06（マイク自動ゲイン＋VAD 床の自動化）**:
  - **マイク入力の自動ゲイン（Zoom 風のゆっくり正規化・B）**: 高齢者側（送信側・uid=2）のみ、
    マイク → WebAudio（AnalyserNode で測定・GainNode で適用）→ MediaStreamDestination →
    Agora カスタムオーディオトラックで publish する（`agoraCall.ts`＋純粋ロジック `autoGain.ts` の
    `SlowGainNormalizer`）。**目標発話レベル -30dBFS 定数**へ、有声 RMS(dBFS) の EMA（約3秒）との
    差からゲインを算出。**クランプ 0〜+18dB・更新2秒ごと・スルーレート±2dB/更新**でゆっくり動かす
    （急変させない＝相対上昇トリガーを壊さない）。echoCancellation は既定維持・**AGC:false 据え置き**
    （自動ゲインは AGC の代替ではなく、AGC より遥かに遅い発話レベル正規化）。家族側（uid=1）は従来どおり。
    高齢者待受の `?debug=1` に測定レベル・EMA・適用ゲイン dB のミニ表示を追加。
  - **家族側 VAD 床の自動化（item 12）**: `rmsTrigger` の `vadFloorDb` を動的更新可能にし
    （`setVadFloorDb`）、`audioPipeline` がノイズフロアを推定（**無音寄りの遅い追跡＝下降 τ=1s・
    上昇 τ=8s の非対称 EMA**）して、**床＝ノイズ+8dB・[-70,-45] クランプ**を1秒ごとに反映する。
    静かな環境では床が下がって発火しやすく、うるさい環境では床が上がって誤発火を抑える。
    家族側 `?debug=1` パネルに `vadFloor` を追加。

## 感情ワード辞書（STT・削減ラダー②解除）

Azure Speech STT（`ja-JP` 連続認識）で検出する感情ワードの初期辞書。
辞書は `frontend/src/modules/detection/sttConfig.ts` の `EMOTION_WORDS` に定義し、
Speech SDK の **フレーズリスト（PhraseListGrammar）** に登録して認識精度を上げる。
認識テキストとの **部分一致**（`text.includes(word)`）でヒットを判定する。

| 感情ワード（初期値） |
| --- |
| かわいい |
| かわいいね |
| 大きくなった |
| 大きくなったね |
| すごい |
| すごいね |
| おめでとう |
| ありがとう |
| 会いたい |
| 元気だね |
| 上手 |
| 笑った |

- ヒット時: `metadata.stt_labels` にヒット語、`metadata.stt_text` に直近認識テキスト（約10秒）を付与し、
  安全網トリガーを `trigger_reason="stt"` で発火する。
- STT発火は **RMS発火と共有のクールダウン（4秒）** を適用する（連打防止）。
- STT の各種パラメータ（言語・トークン更新間隔=約9分・latest 窓=約10秒・16kHz）も同ファイルに集約。
- 辞書・しきい値は支給初期値であり、**チューニングは検収対象外**。
- **best-effort**: SDK ロード失敗・トークン取得失敗（Speech 未設定＝Fake トークンの認証失敗を含む）では
  警告ログのみで STT 無効のまま通話・RMS検知を継続する。
