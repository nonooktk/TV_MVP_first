# 検知パラメータ

支給物A6の雛形。通話中検知（RMS/MediaPipe/STT）の初期パラメータ案。
実測で調整する前提の初期値であり、チューニングは検収対象外とする。

| パラメータ | 初期値 |
| --- | --- |
| **RMS発火しきい値（baseline比上昇・モード依存化）** | **仮基準（provisional）= +26dB（riseThresholdProvisionalDb）／発話基準（speech）= +20dB（riseThresholdSpeechDb）。2026-07-07 に一律 +6dB から +24／+12 へ分割、2026-07-18（Round 1 実測）に通常発話での過検出を抑えるため +26／+20 へ引き上げ。凍結判定・持続カウント・発火判定はすべて現行モードの閾値を参照する** |
| **発火確認窓＝スパイク棄却（confirmWindowMs・2026-07-18 追加）** | **150ms。sustain 成立後、即発火せず 150ms の「確認窓」を張り、その間に非発話（ノイズゲート割れ or VAD床割れ）へ一度でも落ちたら咳・くしゃみ等の破裂音とみなして発火を破棄する（確認窓の間ずっと発話が続けば満了時に発火）。発火は最大150ms遅れるが、写真連写は look-back リングで過去に遡って撮るため取りこぼしはない。破棄回数は snapshot().spikeRejectedCount／計測ログの `spike_rejected` イベントで観測。confirmWindowMs<=0 で従来どおり即発火（後方互換）。実装: `rmsTrigger.ts`（elder／family 両レーン）** |
| baseline 仮初期値（provisionalBaselineDb） | **-32dB**（自動ゲイン目標 -30dBFS と整合。初回有声サンプルで baseline = min(サンプル値, -32)） |
| **基準の2段階化（改良1・発話基準）** | **Phase 1（発話累計 <5秒）= 仮基準・静音区間ベースの非対称 EMA（下記）。Phase 2（発話累計 ≥5秒で切替）= 発話フレーム音圧の中央値（直近20秒ローリング窓）を基準にする。以後も窓は更新し続ける** |
| 発話ゲート（speechGateDb） | **ノイズフロア +8dB 以上のフレームを「発話」とみなす（SPEECH_GATE_DB=8）。発話累計・中央値窓の対象判定に使う。rise ≥ 現行モードの閾値の盛り上がりフレームは中央値窓に入れない** |
| Phase 2 切替（speechAccumMs） | **発話累計 5秒（SPEECH_ACCUM_MS=5000）で speech モードへ移行** |
| 中央値窓（medianWindowMs） | **直近20秒（MEDIAN_WINDOW_MS=20000）** |
| Phase 2 基準スルーレート（baselineSlewDbPerSec） | **±1dB/秒（BASELINE_SLEW_DB_PER_SEC=1）。発話中央値が急変しても baseline はこの速度でしか動かさない（急変防止）** |
| baseline EMA τ（Phase 1・非対称・静音区間ベース） | **上昇方向 τ=8s／下降方向 τ=2s**。rise ≥ 現行モードの閾値の間は **EMA 更新を凍結**（定常区間のみ学習）。**旧ウォームアップ機構は廃止**（2026-07-07 再設計） |
| 検知の持続時間（sustainMs） | 150〜300ms（**初期値150ms**） |
| **クールダウン（cooldownMs）** | **8秒（2026-07-07 実測フィードバックにより 4秒→8秒）／RMS・STT・重心で共有** |
| **リアーム条件（2026-07-07 追加）** | **発火後は「rise が現行閾値未満に一度戻る」まで再発火しない（armed フラグ・クールダウンと AND）。無音（VADゲート未満）は「声が収まった」とみなしリアームする。重心トリガーにも同様のリアームを適用（基準比が閾値未満に戻るまで再発火しない）** |
| VADゲート（vadFloorDb） | -55dB（初期値）**／家族側は自動化: ノイズフロア推定 → 床=ノイズ+8dB・[-50,-45] クランプを1秒ごとに反映（`audioPipeline`→`rmsTrigger.setVadFloorDb`。2026-07-10: ノイズゲート追加に伴いクランプ下限を -70→-50 に変更）** |
| **ノイズゲート（noiseGateDb・2026-07-10 追加）** | **固定 -50dB。vadFloorDb（動的）の値に関わらず、これ未満は常に「完全な無音」として扱う（トリガー評価・baseline学習・発話判定のいずれも行わない）。「-50dB未満には絶対反応しない」ことの固定の安全網。実装: `rmsTrigger.ts` の `DEFAULT_RMS_PARAMS.noiseGateDb`。snapshot に `noiseGateDb`／`gated`（現在フレームがゲート未満か）を追加しデバッグパネルに表示。送信音声そのものには一切手を加えない（聞こえ方は不変）** |
| **スペクトル重心トリガー（改良2・2026-07-18 既定停止）** | **【2026-07-18 Round 1 実測により発火経路を既定停止（enabled=false）】重心は通常発話の 92% の時間で基準比 1.3 を超え、誤発火の 78% を占めた＝音圧と独立の特徴量として現状は成立していないため、発火だけを止める（Phase B で再設計するまで停止）。**計測（sample()/snapshot()・計測ログの重心値）は継続する**（停止＝発火しないだけ）。パラメータ `enabled:true` で再有効化可能。以下は enabled=true 時の挙動: AnalyserNode 周波数データから重心(Hz)を50ms間隔で算出。基準=発話重心の中央値（20秒窓）。基準比 +30%（CENTROID_RISE_RATIO=1.3）を 200ms（CENTROID_SUSTAIN_MS=200）持続かつ発話ゲート成立で `trigger_reason="centroid"` 発火（共有クールダウン8秒）。実装: `centroidTrigger.ts`** |
| 連写枚数・間隔 | 10枚・約2秒間・200ms間隔 |
| スニペット範囲 | 検知前2秒＋検知後3秒 |
| AGC（自動ゲイン制御） | オフ（送信側で設定）**／実装済み（`agoraCall.ts`：高齢者側 join=uid=2 で `AGC:false`。AEC=維持・ANS=既定）** |
| 自動ゲイン（送信側の発話レベル正規化） | **有効化（`autoGain.ts`：高齢者側 uid=2 のみ）。目標 -30dBFS・有声RMS EMA τ≈3s・更新2秒ごと・スルーレート±2dB/更新・クランプ 0〜+18dB。AGC の代替ではなく“ゆっくり正規化”（相対上昇検知を壊さない）** |
| **声トリガーの両側化（family lane・2026-07-10 追加）** | **家族側ローカルマイク音声に第2の検知系統（family lane）を追加。rmsTrigger／centroidTrigger／audioPipeline を高齢者側（elder レーン）とは別インスタンスで持ち、baseline・発話累計・ノイズフロア推定・ノイズゲート・リアームのすべてを独立に学習する。初期値は elder レーンと同一（noiseGate 含む）。STT は elder のみ（family lane には付けない）。クールダウンは elder/family 全系統で共有（8秒）。発火時の写真連写は現状どおり高齢者側 video リングから（両側連写は次フェーズ）。発火イベント・写真 metadata に `trigger_source`（"elder"／"family"）を追加（既存データは elder 扱いのデフォルト）。実装: `frontend/src/modules/detection/index.ts`（family lane 配線）・`frontend/src/modules/call/agoraCall.ts`（`onLocalAudioTrack` で家族側ローカルマイクの生トラックを渡す）** |
| **顔検知の家族側化（Phase 2・2026-07-10 追加）** | **MediaPipe 表情検知（facePipeline）の入力を、高齢者側リモート映像 → **家族側ローカルカメラ**（孫が映る側）に切り替える。MediaPipe インスタンスは従来どおり1つだけ（高齢者側の顔検知はしない＝負荷対策）。face_score 算出ロジック（mouthSmile 系 blendshape 平均）は不変。実装: `frontend/src/modules/detection/index.ts`（facePipeline を family 映像に接続）・`frontend/src/modules/call/agoraCall.ts`（`onLocalVideoTrack` で家族側ローカルカメラの生トラックを渡す）** |
| **顔トリガー（faceTrigger・2026-07-18「変化」化）** | **【2026-07-18 Round 1 実測により絶対値のみ→「変化」化】普通の笑顔でも 0.7 を超えて過検出したため、**本人ベースライン比の上昇**を AND 条件に追加した。発火条件: `score >= 0.85`（絶対 `faceTriggerScore`）**かつ** `score - baseline >= 0.4`（上昇 `faceRiseDelta`）を **500ms 持続**（`faceSustainMs`。300→500）。ベースライン = 顔スコアの直近10秒ローリング中央値（`faceBaselineWindowMs=10000`。RollingMedian 流用）。無表情→笑顔の“変化”で発火し、ずっと笑顔（変化なし）では発火しない。reason="face"・trigger_source="family"。全系統共有クールダウン（8秒）に参加。リアーム: スコアが 0.85 未満に戻るまで再発火しない。計測ログに `face_baseline`（本人ベースラインの1秒毎の現在値）を記録。実装: `frontend/src/modules/detection/faceTrigger.ts` の `DEFAULT_FACE_TRIGGER_PARAMS`（`scoreThreshold=0.85`／`riseDelta=0.4`／`baselineWindowMs=10000`／`sustainMs=500`／`sampleIntervalMs=100`）** |
| **両側連写（Phase 2・2026-07-10 追加）** | **どのトリガー（rms/stt/centroid/face・elder/family いずれ）でも、発火時に**高齢者側リング＋家族側リングの両方から10枚ずつ（計20枚）連写**する（look-back 込み・2バーストは並列実行）。写真 metadata に `stream`（"elder"／"family"）を付与。家族側の写真には家族側 facePipeline のコマ別 face_score を付与、**高齢者側の写真は face_score=0**（音圧採点＋既存の救済フォールバックで選別）。通知「記録しました（N）」の N は両側合計。8秒全体タイムアウト・部分保存の既存機構は両側分に対して機能する。音声スニペットは従来どおり高齢者側のみ（変更しない）。実装: `index.ts`（family videoRing＋両側 captureBurst＋`toPhotoRecords`）** |

> 実測で調整。チューニングは検収対象外。
> 実装の正は `frontend/src/modules/detection/rmsTrigger.ts` の `DEFAULT_RMS_PARAMS`
> （＋スペクトル重心は `frontend/src/modules/detection/centroidTrigger.ts` の `DEFAULT_CENTROID_PARAMS`）。

## 初期値の変更履歴

初期値の更新は「支給初期値の改訂」であり、検収条件（機能）は不変。

- **2026-07-18（Round 1 実測に基づく検知トリガーの再構成）**: 実地テスト Round 1
  （3セッション・231発火）の分析結果に基づき、トリガー構成を見直した。根拠数字と変更点:
  - **重心トリガーの停止（既定 enabled=false・計測は継続）**: 重心は**誤発火の78%**を占め、
    **通常発話の92%の時間で閾値1.3を超過**（＝音圧と独立の特徴量として不成立）だったため、
    発火経路を既定停止した。計測ログへの重心値の記録は継続し、`centroid_ratio_median`
    （その1秒の基準比の中央値＝平滑値）を追加して Phase B で「平滑重心なら識別できるか」を
    検証する材料にする。実装: `centroidTrigger.ts` の `DEFAULT_CENTROID_PARAMS.enabled`。
  - **RMS 閾値の引き上げ**: 通常発話での過検出を抑えるため、`riseThresholdSpeechDb` 12→**20**、
    `riseThresholdProvisionalDb` 24→**26**（elder・family 両系統。DEFAULT_RMS_PARAMS）。
  - **スパイク棄却（発火確認窓 confirmWindowMs=150ms）**: 咳・くしゃみ・生活音の破裂音対策。
    sustain 成立後に即発火せず150msの確認窓を張り、その間に非発話へ落ちたら発火を破棄する。
    発火は最大150ms遅れるが look-back リングで写真は取りこぼさない。破棄は snapshot の
    `spikeRejectedCount`・計測ログの `spike_rejected` イベントに記録。実装: `rmsTrigger.ts`。
  - **顔トリガーの「変化」化**: 絶対値0.7は普通の笑顔で超えるため、`score>=0.85` **かつ**
    `score-baseline>=0.4`（本人の直近10秒中央値からの上昇）を **500ms 持続**へ変更
    （`faceTriggerScore=0.85`／`faceRiseDelta=0.4`／`faceSustainMs=500`／
    `faceBaselineWindowMs=10000`）。計測ログに `face_baseline` を追加。実装: `faceTrigger.ts`。
  - **シナリオマーカー**: 計測UI（`NEXT_PUBLIC_MEASUREMENT_UI=1`）に打刻UI（A1〜C3・自由入力＋
    「打刻」ボタン）を追加し、計測ログの events に `marker` を記録する（Round 2 の集計自動化）。
    実装: `app/call/page.tsx`・`index.ts`（`recordMarker`）・`measurementLog.ts`。
  - 検収条件（機能）は不変。連写10枚・スニペット範囲（前2秒〜後3秒）・共有クールダウン（8秒）・
    重心の判定式（enabled=true 時は +30%/200ms 据え置き）は変えていない。

- **2026-07-10（Phase 2: 顔検知の家族側化・顔トリガー新設・両側連写）**: 実装の正は
  `faceTrigger.ts`（新規）・`index.ts`・`app/call/agoraCall.ts`・`app/call/page.tsx`・
  `storage.ts`・`measurementLog.ts`（frontend）／`worker/stages/stage1_scoring.py`・
  `call_context.py`・`backend/app/api/albums.py`・`backend/app/schemas.py`。
  - **顔検知の家族側化**: facePipeline（MediaPipe）の入力を高齢者側リモート映像 → 家族側
    ローカルカメラ（孫が映る側）へ切替。MediaPipe インスタンスは1つだけ（高齢者側の顔検知は
    しない＝負荷対策）。`agoraCall.ts` に `onLocalVideoTrack`（家族側ローカルカメラの生
    MediaStreamTrack を渡す差し込み口）を追加し、`call/page.tsx` が `attachDetection` の
    `familyVideoTrack` へ配線した。
  - **顔トリガー新設**: 家族側の face_score が**絶対閾値 `faceTriggerScore=0.7` を
    `faceSustainMs=300ms` 持続**で発火する（reason="face"・trigger_source="family"）。
    全系統共有クールダウン（8秒）に参加（`handleTrigger` の `isRealTrigger` に "face" を
    含めた）。リアーム: スコアが閾値未満に一度戻るまで再発火しない。デバッグパネルに
    「顔トリガー（家族側）」セクション（現在スコア/閾値/持続/armed）を追加。計測ログの
    サンプルに `face_score_peak`（この1秒間の face_score ピーク）を追加した。
  - **両側連写**: 発火時に高齢者側リング＋家族側リング（新設 family videoRing）の両方から
    10枚ずつ（計20枚・look-back 込み・2バースト並列）連写する。写真 metadata に
    `stream`（"elder"／"family"）を付与。家族側写真は facePipeline のコマ別 face_score、
    高齢者側写真は face_score=0（音圧採点＋救済フォールバックで選別）。通知の N は両側合計。
    8秒全体タイムアウト・部分保存の既存機構は両側分に対して機能する。音声スニペットは
    従来どおり高齢者側のみ（不変）。
  - **worker**: `stage1_scoring.py` の無表情ゲート／フォールバック／rms_rise 正規化を
    **ストリーム別**に適用（高齢者側 face=0 が家族側の表情信号を理由に全滅→独占されるのを
    防ぐ。両ストリームが非ゼロで混在）。`call_context.py` に reason="face" の文脈語
    「孫の笑顔・変顔」と、家族側写真を含む旨の構成行を追加（判定ロジックは無変更）。
  - **backend**: `metadata.stream` はフリー dict のため `media/register` は素通し（変更不要）。
    アルバム閲覧のバッジ用に `AlbumPhoto.stream` を追加し `albums.py` で metadata から導出。
  - 検収条件（機能）は不変。連写「片側10枚」・スニペット範囲（前2秒〜後3秒）・共有
    クールダウン（8秒）・sustainMs（150ms/200ms）・重心閾値（+30%/200ms）は据え置き。

- **2026-07-10（ノイズゲート追加・声トリガーの両側化）**: 実装の正は `rmsTrigger.ts`・
  `audioPipeline.ts`・`centroidTrigger.ts`・`index.ts`・`app/call/agoraCall.ts`・
  `app/call/page.tsx`・`storage.ts`（frontend）／`worker/stages/call_context.py`。
  - **ノイズゲート（固定 -50dB・`noiseGateDb`）を追加**: `DEFAULT_RMS_PARAMS` に
    `noiseGateDb: -50` を追加した。ゲート未満のフレームは vadFloorDb（動的・家族側は
    ノイズフロア推定で自動追従）の値に関わらず常に「完全な無音」として扱う（トリガー評価・
    baseline学習・発話判定のいずれも行わない・重心トリガーへも isSpeech=false で渡し持続を
    リセットする）。**適応 VAD 床のクランプを `[-70,-45]` → `[-50,-45]` に変更**し、
    ノイズゲートと揃えて「-50dB 未満には絶対反応しない」ことを二重に保証した。
    snapshot に `noiseGateDb`／`gated`（現在フレームがゲート未満か）を追加し、デバッグパネルの
    「発火」「パラメータ現在値」セクションに表示した。計測ログのサンプルに `gate_ratio`
    （その1秒でゲート未満だったフレーム率）を追加した。**送信音声そのものには一切手を
    加えていない（聞こえ方は不変）**。
  - **声トリガーの両側化（family lane）**: 家族側ローカルマイク音声に第2の検知系統
    （family lane）を追加した（`RmsTrigger`／`CentroidTrigger`／`AudioPipeline` を高齢者側
    〈elder レーン〉とは別インスタンスで保持。baseline・発話累計・ノイズフロア推定・
    ノイズゲート・リアームのすべてを独立に学習する）。`agoraCall.ts` に
    `onLocalAudioTrack`（家族側ローカルマイクの生 MediaStreamTrack を渡す差し込み口）を追加し、
    `call/page.tsx` がこれを `attachDetection` の `familyAudioTrack` へ配線した。**STT は
    高齢者側のみ**（family lane には付けない）。**クールダウンは全系統共有**（elder の
    rms/centroid/stt ＋ family の rms/centroid のどれが発火しても8秒間は全体で再発火しない。
    `handleTrigger` の `lastTriggerAtMs` 1本を elder/family 共通で参照する既存の仕組みを
    そのまま横断適用）。発火時の写真連写は**現状どおり高齢者側 video リングから**（両側連写は
    次フェーズ）。発火イベント・写真 metadata に `trigger_source`（`"elder"`／`"family"`）を
    追加した（既存データは elder 扱いのデフォルト。`docs/data-contract.md` に追記）。
    デバッグパネルに「家族側マイク（第2系統）」セクション（rms/baseline/rise/mode/armed/
    重心比の現在値）を追加した。計測ログのサンプルに `family_rise_peak_db`／
    `family_centroid_ratio_peak` を追加し、発火イベントに `trigger_source` を記録した。
    家族側系統の初期値は高齢者側と同一（noiseGate 含む）。
  - **worker（`call_context.py`）**: ラベリング文脈に `has_family_trigger` を追加し、確定5枚の
    いずれかが `trigger_source == "family"` なら「家族側の歓声や声の盛り上がりもこの瞬間の
    きっかけになった」という文脈行を1つ足す（判定ロジック・スコアリングは無変更。ラベリング
    文脈への軽い反映のみ）。
  - 検収条件（機能）は不変。連写10枚・スニペット範囲（前2秒〜後3秒）・sustainMs（150ms/200ms）・
    クールダウン（8秒）・重心閾値（+30%/200ms）は据え置き。

- **2026-07-07（実測フィードバックによる調整: rise閾値のモード依存化・クールダウン延長・
  リアーム条件・重心トリガーの厳密化）**: オーナーの実測フィードバック（発火しすぎ・鳴りっぱなし・
  無言での重心誤発火）を受け、検知パラメータとロジックを調整した。実装の正は `rmsTrigger.ts`・
  `centroidTrigger.ts`・`index.ts`・`app/call/page.tsx`。
  - **rise 閾値のモード依存化**: 従来の一律 `riseThresholdDb=+6dB` を、基準モード（改良1の
    Phase 1/2）別の2値に分割した。**仮基準（provisional）= +24dB**（`riseThresholdProvisionalDb`）・
    **発話基準（speech）= +12dB**（`riseThresholdSpeechDb`）。baseline がまだ安定していない
    仮基準は誤発火を避けて高め、baseline が発話中央値に収束済みの発話基準は感度を保ちつつ
    低めにする。凍結判定（EMA更新の凍結）・持続カウント・発火判定は、いずれもその時点の
    モードの閾値を参照するよう統一した。デバッグパネルの「パラメータ現在値」もモード連動表示
    （`+{閾値}dB (仮基準/発話基準)`）に変更した。
  - **クールダウン 4秒→8秒**: `cooldownMs` を8秒に延長した（RMS・STT・重心で共有）。
  - **リアーム条件の追加**: 発火後は「rise が現行閾値未満に一度戻る」まで再発火しない
    （`armed` フラグ・クールダウンとの AND 条件）。鳴りっぱなし・連続再発火（クールダウン明けの
    瞬間に声を張ったままだと即再発火してしまう挙動）を防ぐ。無音（VADゲート未満）は
    「声が収まった」とみなしてリアームする（大声の直後に静寂へ戻るケースで、次の有声発話まで
    再発火不能のまま固まらないようにするための実装判断）。重心トリガーにも同様のリアームを
    適用し、基準比が `riseRatio` 未満に戻るまで再発火しない。デバッグパネルに `armed` 表示
    （済／未〈高止まり中〉）を追加した。
  - **重心トリガーの厳密化**: 基準比を **+20%→+30%**（`CENTROID_RISE_RATIO=1.2→1.3`）に
    引き上げた。加えて、発火条件に**発話ゲート成立（現在フレームがノイズフロア+8dB以上）を
    同時必須**にした。従来は「発話フレームのみを push する」呼び出し側ゲートだったが、
    非発話フレームで push 自体をスキップしていたため持続カウントが暗黙に途切れるだけだった。
    2026-07-07 の変更で `CentroidTrigger.push(centroidHz, isSpeech, nowMs)` へシグネチャを拡張し、
    **非発話フレームも明示的に投入して持続カウントをリセット**する（無言のまま重心だけ動いた
    区間で誤発火しないことを厳密化）。持続カウントは発話フレームのみで積算する。
  - 検収条件（機能）は不変。連写10枚・スニペット範囲（前2秒〜後3秒）・sustainMs（150ms/200ms）・
    VADゲート（-55dB・家族側は自動化）は据え置き。
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

## 計測ログ（トリガーパラメータ設計の実地テスト用）

実地テストで「全シナリオでの rise / 重心比の分布」と「全発火イベントの詳細」を後から集計
できるようにするための、読み取り専用オブザーバー。検知本体（`rmsTrigger.ts`／
`centroidTrigger.ts`／`index.ts`）の挙動には一切影響しない（フックは snapshot 取得と発火
`onEvent` 経由のみ）。実装は `frontend/src/modules/detection/measurementLog.ts`。

- **記録タイミング**: 通話中は常時記録する（デバッグパネルの表示可否とは無関係）。
  1秒ごとのサマリサンプルと、全発火イベントの詳細を蓄積する。
- **サマリサンプル（1秒ごと）**: 瞬間値ではなく**その1秒間のピークホールド**を含める
  （sustain 150ms の短いイベントを1Hzサンプリングで取りこぼさないため）。フィールド:
  `t`（通話開始からの秒）・`rise_peak_db`（この1秒間の rise 最大値）・`rms_db`／
  `baseline_db`／`mode`／`speech_accum_ms`／`speech_median_db`（現在値）・`armed`・
  `vad_floor_db`・`noise_floor_db`・`speech_ratio`（この1秒間の発話フレーム率 0〜1）・
  `centroid_hz`／`centroid_baseline_hz`（現在値）・`centroid_ratio_peak`（この1秒間の基準比
  最大値）・`centroid_ratio_median`（この1秒間の基準比の中央値＝平滑値。2026-07-18 追加。ピークと
  併記し、Phase B で「平滑重心なら通常発話と識別できるか」を検証する材料）・`auto_gain_db`
  （自ゲイン現在値。取得できる場合のみ）・`gate_ratio`（この1秒間で
  ノイズゲート未満だったフレーム率 0〜1。2026-07-10 追加・elder レーンの観測）・
  `family_rise_peak_db`／`family_centroid_ratio_peak`（family lane のこの1秒間のピーク値。
  2026-07-10 追加。family lane 未接続の通話では常に null）・`face_score_peak`（家族側の
  face_score のこの1秒間のピーク。顔トリガー・Phase 2・2026-07-10 追加。顔検知なしの通話では
  常に null）・`face_baseline`（顔トリガーの本人ベースライン＝直近10秒中央値の1秒毎の現在値。
  2026-07-18 追加。顔検知なしの通話では常に null）。
- **発火イベント**: `t`・`type:"trigger"`・`reason`（rms/centroid/stt/face/force）・
  `source`（`"elder"`／`"family"`。声トリガーの両側化・2026-07-10 追加。省略呼び出しは
  `"elder"` 既定）・発火瞬間の全スナップショット（rise・mode・centroid比・armed 等を含む
  発火元レーンの rmsTrigger/centroidTrigger の `snapshot()` そのもの）・完了時に確定する
  `photo_count`・部分保存（タイムアウト救済）フラグ `partial_save`。
- **スパイク棄却イベント（2026-07-18 追加）**: `t`・`type:"spike_rejected"`・`source`
  （`"elder"`／`"family"`）。rmsTrigger の発火確認窓の途中で非発話へ落ちて発火を破棄した
  ときに記録する（咳・くしゃみ等の破裂音対策の効果測定＝C1台本用）。
- **シナリオマーカーイベント（2026-07-18 追加）**: `t`・`type:"marker"`・`label`（A1〜C3 または
  自由入力）。計測UI（`NEXT_PUBLIC_MEASUREMENT_UI=1` 時）の「打刻」ボタンで記録する
  （Round 2 の集計自動化用）。events はこれら3種（trigger／spike_rejected／marker）の直和で、
  いずれも最大200件のリングに従う。
- **メモリ上限**: サンプルは最大 3600 件（60分相当・1Hz）、イベントは最大 200 件のリング
  バッファ（古いものから溢れる）。
- **エクスポート形式（JSON）**: `version`（1）・`call_id`・`exported_at`（ISO8601）・
  `params`（有効だった `DEFAULT_RMS_PARAMS`／`DEFAULT_CENTROID_PARAMS` のスナップショット）・
  `samples`・`events`。
- **UI**: 家族側 `/call` のデバッグパネル内に「計測ログDL」（Blob+a.download で
  `measurement-log-<callId>-<t>.json` をダウンロード）・「ログクリア」ボタンと、現在の
  記録件数（samples/events）の小表示を追加。ボタン表示はデバッグパネル限定（記録自体は
  デバッグモードに関係なく常時行う）。
- **シナリオ打刻UI（2026-07-18 追加）**: 計測UI（`NEXT_PUBLIC_MEASUREMENT_UI=1`）のとき、
  画面左下（📊ログボタンの少し上）にセレクト（A1〜A7・B1〜B8・C1〜C3・自由入力）＋「打刻」
  ボタンを表示する。押すと計測ログの events に `{type:"marker", label, t}` を記録する
  （Round 2 の集計自動化）。通話画面の邪魔にならない小ささ。

### ワンタップDL導線・通話終了後の回収導線（2026-07-08 追加）

実地テストでのログ回収の手間を減らすため、①通話画面の常設DLボタンと②通話終了後・
タブクラッシュ時にも回収できる IndexedDB 永続化＋ホーム画面からのDLを追加した。
実装は `frontend/src/modules/detection/measurementLogStorage.ts`（永続化層）・
`index.ts`（フラッシュタイマー）・`app/call/page.tsx`（常設ボタン）・
`app/page.tsx`（ホームの回収セクション）。

- **①常設「📊ログ」ボタン**: 家族側 `/call` の画面左下（既存のデバッグトグルは右下のため
  衝突しない）に常時表示する小さなボタン（`data-testid="measurement-quick-download"`）。
  タップで `exportMeasurementLog()` を即 Blob ダウンロードする（デバッグパネル内の
  「計測ログDL」と同じ `handleMeasurementDownload` を共有）。
- **②通話終了後の回収導線（IndexedDB永続化）**:
  - **保存タイミング**: (a) 通話中は約10秒ごとに自動フラッシュ、(b) 通話終了時
    （`detach()` 内）に確定フラッシュ。タブクラッシュ・切り忘れでも直近の状態を失わない。
  - **設計判断（upsert＝完全スナップショット置き換え。差分追記ではない）**: フラッシュは
    「その時点の `MeasurementLog.toExport()` の完全スナップショットで、当該 call_id の
    レコードを丸ごと置き換える」方式にした。10秒間隔の複数回フラッシュ＋終了時の確定保存が
    どの順序で呼ばれても、常に「最後に呼ばれた時点の完全な状態」が残るため、差分マージに
    起因する重複・欠落が原理的に発生しない（`measurementLogStorage.ts` にコメントで明記）。
  - **保存先**: 新規 IndexedDB（`tvmvp-measurement-log`。既存の検知保存 `tvmvp-detection`
    とは別DB・別ファイル。`storage.ts` の `DetectionDB` には一切手を加えていない）。
    ストア `logs`（keyPath=`callId`）＋ `byUpdatedAt` インデックス。
  - **保存上限**: 直近10通話分（`MAX_STORED_CALLS=10`）。call_id ごとに1レコード。
    上限を超えたら `updatedAt`（直近フラッシュ時刻）が最も古いものから削除する。
  - **best-effort**: フラッシュ失敗は検知・通話を止めない（try/catch + console.warn のみ）。
  - **ホーム画面の回収UI**: 家族側ホーム（`/`）に「計測ログ（トリガーテスト用）」セクションを
    追加（`data-testid="measurement-log-section"`）。保存済み通話の一覧（日時・call_id・
    samples/events件数）＋各行に「DL」「削除」ボタン。ダウンロードファイル名は既存と同じ
    `measurement-log-<callId>-<t>.json`（t はダウンロード時刻）。
- **表示制御**: ①②とも環境変数 `NEXT_PUBLIC_MEASUREMENT_UI` が `"1"` のときのみ表示
  （未設定なら非表示）。Next.js 静的エクスポートのビルド時に埋め込まれる
  （`frontend/.env.production` に設定）。デバッグパネル内の既存「計測ログDL」「ログクリア」は
  この環境変数に関係なくデバッグパネル表示中は常に見える（変更なし）。
- **検証**: 新規 `tests-unit/measurementLogStorage.test.ts`（上限ローテーション・
  フラッシュのマージ整合性〈10秒フラッシュ→終了確定保存の順／逆順〉・一覧の日時降順・削除）。
  `fake-indexeddb` を devDependencies に導入（テストファイル内に import を閉じ、他のテストへの
  影響なし）。

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
