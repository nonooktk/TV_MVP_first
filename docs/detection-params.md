# 検知パラメータ

支給物A6の雛形。通話中検知（RMS/MediaPipe/STT）の初期パラメータ案。
実測で調整する前提の初期値であり、チューニングは検収対象外とする。

| パラメータ | 初期値 |
| --- | --- |
| RMS発火しきい値（baseline比上昇 riseThresholdDb） | **+6dB** |
| baseline 仮初期値（provisionalBaselineDb） | **-32dB**（自動ゲイン目標 -30dBFS と整合。初回有声サンプルで baseline = min(サンプル値, -32)） |
| **基準の2段階化（改良1・発話基準）** | **Phase 1（発話累計 <5秒）= 仮基準・静音区間ベースの非対称 EMA（下記）。Phase 2（発話累計 ≥5秒で切替）= 発話フレーム音圧の中央値（直近20秒ローリング窓）を基準にする。以後も窓は更新し続ける** |
| 発話ゲート（speechGateDb） | **ノイズフロア +8dB 以上のフレームを「発話」とみなす（SPEECH_GATE_DB=8）。発話累計・中央値窓の対象判定に使う。rise ≥ riseThresholdDb の盛り上がりフレームは中央値窓に入れない** |
| Phase 2 切替（speechAccumMs） | **発話累計 5秒（SPEECH_ACCUM_MS=5000）で speech モードへ移行** |
| 中央値窓（medianWindowMs） | **直近20秒（MEDIAN_WINDOW_MS=20000）** |
| Phase 2 基準スルーレート（baselineSlewDbPerSec） | **±1dB/秒（BASELINE_SLEW_DB_PER_SEC=1）。発話中央値が急変しても baseline はこの速度でしか動かさない（急変防止）** |
| baseline EMA τ（Phase 1・非対称・静音区間ベース） | **上昇方向 τ=8s／下降方向 τ=2s**。rise ≥ riseThresholdDb の間は **EMA 更新を凍結**（定常区間のみ学習）。**旧ウォームアップ機構は廃止**（2026-07-07 再設計） |
| 検知の持続時間（sustainMs） | 150〜300ms（**初期値150ms**） |
| クールダウン（cooldownMs） | 3〜5秒（初期値4秒）**／RMS・STT・重心で共有** |
| VADゲート（vadFloorDb） | -55dB（初期値）**／家族側は自動化: ノイズフロア推定 → 床=ノイズ+8dB・[-70,-45] クランプを1秒ごとに反映（`audioPipeline`→`rmsTrigger.setVadFloorDb`）** |
| **スペクトル重心トリガー（改良2）** | **AnalyserNode 周波数データから重心(Hz)を50ms間隔で算出（発話フレームのみ）。基準=発話重心の中央値（20秒窓・改良1と同じ仕組み）。重心が基準比 +20%（CENTROID_RISE_RATIO=1.2）を 200ms（CENTROID_SUSTAIN_MS=200）持続かつ発話中で `trigger_reason="centroid"` を発火（共有クールダウン4秒）。声色（笑い声・高い声）を音圧と独立の軸で捉える。実装: `centroidTrigger.ts`** |
| 連写枚数・間隔 | 10枚・約2秒間・200ms間隔 |
| スニペット範囲 | 検知前2秒＋検知後3秒 |
| AGC（自動ゲイン制御） | オフ（送信側で設定）**／実装済み（`agoraCall.ts`：高齢者側 join=uid=2 で `AGC:false`。AEC=維持・ANS=既定）** |
| 自動ゲイン（送信側の発話レベル正規化） | **有効化（`autoGain.ts`：高齢者側 uid=2 のみ）。目標 -30dBFS・有声RMS EMA τ≈3s・更新2秒ごと・スルーレート±2dB/更新・クランプ 0〜+18dB。AGC の代替ではなく“ゆっくり正規化”（相対上昇検知を壊さない）** |

> 実測で調整。チューニングは検収対象外。
> 実装の正は `frontend/src/modules/detection/rmsTrigger.ts` の `DEFAULT_RMS_PARAMS`
> （＋スペクトル重心は `frontend/src/modules/detection/centroidTrigger.ts` の `DEFAULT_CENTROID_PARAMS`）。

## 初期値の変更履歴

初期値の更新は「支給初期値の改訂」であり、検収条件（機能）は不変。

- **2026-07-07（検知の3改良: 発話基準の2段階化・スペクトル重心トリガー・記録通知の2段階化）**:
  実装の正は `rmsTrigger.ts`（`RollingMedian` / 2段階 baseline）・`centroidTrigger.ts`・
  `audioPipeline.ts`・`index.ts`・`app/call/page.tsx`。
  - **改良1（基準レベルの2段階化・発話基準）**: 基準学習を発話ベースに拡張した。
    - **発話判定**: 「ノイズフロア +8dB 以上（`SPEECH_GATE_DB=8`）」のフレームを発話とみなす
      （ノイズフロア推定は `audioPipeline`→`rmsTrigger.setNoiseFloorDb`）。
    - **Phase 1（発話累計 <5秒）**: 従来どおり（仮初期値 -32・min 採用・rise≥閾値中は学習凍結・
      非対称 τ8s/2s）。
    - **Phase 2（発話累計 ≥5秒＝`SPEECH_ACCUM_MS=5000` で切替）**: 基準 = **発話フレーム音圧の
      中央値**（直近20秒ローリング窓＝`MEDIAN_WINDOW_MS=20000`。rise≥閾値中の盛り上がりフレームは
      窓に入れない）。基準の反映は**スルー制限 ±1dB/秒（`BASELINE_SLEW_DB_PER_SEC=1`）**で急変させない。
      以後も窓は更新し続ける。
    - snapshot に `mode`（"provisional"/"speech"）・`speechAccumMs`・`speechMedianDb` を追加。
      デバッグパネルに「基準モード（発話基準）」セクション（mode/発話蓄積秒/発話メジアン）を追加。
  - **改良2（スペクトル重心トリガー）**: 声色（笑い声・高い声・興奮）を音圧と独立の軸で捉える
    トリガーを追加した（`centroidTrigger.ts`）。AnalyserNode の周波数データから重心(Hz)を50ms間隔で
    算出（**発話フレームのみ**。非発話時は無視）。基準も発話フレームの中央値（改良1と同じ20秒窓）。
    重心が基準比 **+20%（`CENTROID_RISE_RATIO=1.2`）を 200ms（`CENTROID_SUSTAIN_MS=200`）持続**かつ
    発話中で `handleTrigger` を `reason="centroid"` で発火（**RMS/STT と共有クールダウン4秒**）。
    `TriggerReason` 型に `"centroid"` を追加。全写真 metadata に `spectral_centroid`（発火時Hz）と
    `centroid_rise_ratio` を付与（data-contract.md 付録に追記）。デバッグパネルに「重心（声色）」
    セクション（現在値/基準/上昇率/持続）を追加。**worker/stage1 は変更不要**（reason で分岐しない。
    ラベリング文脈のみ `声色の変化` として集計する `_TRIGGER_LABELS` を追加）。
  - **改良3（記録通知の2段階化・即時化）**: `onEvent` を2段階化した。**トリガー瞬間**に
    `{type:"started", reason}`（即時）→ 保存完了時に `{type:"completed", photoCount, hasAudio, ...}`
    （従来内容）。`call/page.tsx` は started で即バッジフラッシュ＋「📸 思い出を記録中…」表示 →
    completed で「思い出を記録しました（N）」へ更新（8秒タイムアウトの部分保存でも実枚数に整合）。
    既存の記録カウント（triggerCount）は completed 基準を維持。forceTrigger・Playwright フックとの
    互換を保つ（`__detection.state` の互換フィールドは残す）。
  - 検収条件（機能）は不変。RMS発火しきい値（+6dB）・sustain（150ms）・クールダウン（4s）・
    VADゲート（-55dB・家族側は自動化）は据え置き。

- **2026-07-07（baseline の静音区間ベース再設計）**: baseline の学習方式を全面的に見直した。
  実装の正は `frontend/src/modules/detection/rmsTrigger.ts`。
  - **仮初期値 `provisionalBaselineDb = -32`（定数化）**: 初回有声サンプルで
    baseline = **min(サンプル値, -32)**。自動ゲイン目標 -30dBFS と整合させた仮値。
    冒頭がいきなり大声（例 -15dB）でも仮値 -32 を採用して大きな rise（+17dB）を作り、
    **冒頭からでも発火できる**。冒頭が静かな声ならその値を採用する（min で平常側に寄る）。
  - **定常区間のみ学習（凍結）**: rise（現在値 − baseline）が `riseThresholdDb` 以上の間は
    **EMA 更新を凍結**する。発話・泣き声のピークを平常基準に取り込まず、「静かに戻った区間」
    だけで baseline を学習する。凍結中はデバッグパネルに「凍結中」と表示する。
  - **非対称追従（定数化・コメント）**: 更新時、baseline が**上がる方向は τ=8s（ゆっくり）**、
    **下がる方向は τ=2s（速い）**。環境が静かになったら基準を速やかに引き下げ、うるさく
    なっても基準はゆっくりしか上げない（誤発火を抑えつつ、静音復帰後の感度を素早く回復）。
  - **ウォームアップ機構（`warmupMs` / `warmupTauMs`・修正4）を廃止**し、本方式に置換した。
    デバッグパネルの `warmup` 行は `baseline学習`（凍結中／学習中＋非対称τ・仮初期値）に差し替え。
    関連する vitest（`tests-unit/rmsTrigger.test.ts`）も本方式のシナリオへ更新済み
    （冒頭ギャン泣き即発火→凍結→泣き止み追従→再発火／静かな開始の従来ケース回帰／
    長い興奮後の静音復帰で下降τ=2s の速い降下）。
  - 検収条件（機能）は不変。RMS発火しきい値（+6dB）・sustain（150ms）・クールダウン（4s）・
    VADゲート（-55dB・家族側は自動化）は据え置き。
- **2026-07-05**: オーナー実測フィードバック（実カメラ通話で RMS 発火が渋い）により、
  RMS発火感度を上げる。`riseThresholdDb` **+8dB → +6dB**、`sustainMs` **200ms → 150ms**。
  クールダウン（4秒）・VADゲート（-55dB）は据え置き。
- **2026-07-05（発火まわり4修正）**:
  - **baseline ウォームアップ追加（コールドスタート緩和・修正4）**〔**2026-07-07 に廃止・
    静音区間ベース再設計へ置換**〕: 通話冒頭の有声サンプル累計3秒（`warmupMs=3000`）までは
    baseline の EMA を速い τ=1s（`warmupTauMs=1000`）で順応させ、その後は通常運転 τ=4s に戻す
    方式だった。冒頭のコールドスタート緩和という目的は、再設計の「仮初期値 -32 ＋ 非対称τ」で
    達成している。
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
